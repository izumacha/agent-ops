// 生 SQL の書き方を構文で固定する **二次的な網**。Prisma はタグ付きテンプレート (`$queryRaw`) なら値を
// パラメータ化するが、`$queryRawUnsafe` / `Prisma.raw` は文字列をそのまま SQL に混ぜる。
//
// **値の妥当性を担保するのはここではなく実行時のガード** (`src/lib/raw-sql-guard.ts`)。綴りを走査する
// 検出網は 1 段の間接化で崩れるためで、実測では `const { raw } = Prisma` と分割代入して変数に入れた
// 断片を埋め込むだけで、この検査も ESLint も素通りし、URL のパスパラメータから任意 SQL を実行できた
// (pg_sleep が実際に効いた)。同じ理由で、計算添字 `(tx as never)[name](sql)` のような形も捕まえられない。
// この検査の役目は「危険な書き方が直接の綴りで増えたことに、テストを流す前の段階で気付く」ことに限る。
// 捕まえられる範囲を正直に書いておくのは、これを「証明」と誤解して実行時ガードを外させないため
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 値を素通しする (＝禁止する) メソッド名 (レシーバは問わない)
const UNSAFE_MEMBERS = ['$queryRawUnsafe', '$executeRawUnsafe'] as const;
// SQL 断片を作る API 名。レシーバが `Prisma` のときだけ禁止する — 名前だけで禁じると、無関係な
// オブジェクトの `.raw` / `.sql` まで落ちる (実際この規約を実装しているガード自身が引っかかった)。
// 誤検知はいずれ「検査を緩める」圧力になるので、精度の側に寄せる
const FRAGMENT_MEMBERS = ['raw', 'sql'] as const;
// SQL 断片を作るオブジェクトの名前
const FRAGMENT_OWNER = 'Prisma';
// パラメータ化される (＝許す) タグ付きテンプレートの API 名
const TAGGED_MEMBERS = ['$queryRaw', '$executeRaw'] as const;

// src 全体の構文木 (1 度だけ作る)
const FILES = parseSourceFiles();

// メンバ参照のレシーバ名を返す (Prisma.raw なら Prisma。該当しなければ null)
function receiverName(node: ts.Node): string | null {
  // プロパティアクセスで、左側が単なる識別子のときだけ名前を返す
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  // それ以外は対象外
  return null;
}

// メンバ呼び出し・メンバ参照の「最後の名前」を返す (x.y.z なら z。該当しなければ null)
function memberName(node: ts.Node): string | null {
  // プロパティアクセス (a.b) の右側の名前
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  // 添字アクセス (a['b']) の文字列リテラル (綴りを変えた迂回を拾う)
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  // それ以外は対象外
  return null;
}

describe('生 SQL の書き方', () => {
  it('走査対象のファイルを集められている (fail-closed)', () => {
    // 1 ファイルも読めていなければ検出網が死んでいる
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('値を素通しする生 SQL の API を src のどこでも使っていない', () => {
    // 見つかった違反 (ファイルと API 名)
    const found: string[] = [];
    for (const { path, source } of FILES) {
      forEachNode(source, (node) => {
        // 参照している名前を取り出す
        const name = memberName(node);
        // 名前が読めなければ対象外
        if (name === null) return;
        // 値を素通しするメソッドはレシーバを問わず禁止する
        if ((UNSAFE_MEMBERS as readonly string[]).includes(name)) {
          found.push(`${path}: ${name}`);
          return;
        }
        // SQL 断片を作る API は、レシーバが Prisma のときだけ禁止する
        if (
          (FRAGMENT_MEMBERS as readonly string[]).includes(name) &&
          receiverName(node) === FRAGMENT_OWNER
        ) {
          found.push(`${path}: ${FRAGMENT_OWNER}.${name}`);
        }
      });
    }
    // 1 件も無いこと (Prisma.raw / Prisma.sql はタグ付きテンプレートの中でも値を素通しする)
    expect(found).toEqual([]);
  });

  it('生 SQL はタグ付きテンプレートで書き、埋め込む値は変数の参照だけにする', () => {
    // 実際に見たタグ付きテンプレートの数 (0 件なら走査が壊れている)
    let checked = 0;
    // 見つかった違反
    const found: string[] = [];
    for (const { path, source } of FILES) {
      forEachNode(source, (node) => {
        // タグ付きテンプレート以外の形で $queryRaw を呼んでいないか
        if (ts.isCallExpression(node)) {
          // 呼び出し先の名前
          const name = memberName(node.expression);
          // タグ付きで使うべき API を関数として呼んでいたら違反 (文字列を組み立てて渡せてしまう)
          if (name !== null && (TAGGED_MEMBERS as readonly string[]).includes(name)) {
            found.push(`${path}: ${name} を関数として呼んでいる`);
          }
          return;
        }
        // ここからはタグ付きテンプレートだけを見る
        if (!ts.isTaggedTemplateExpression(node)) return;
        // タグの名前 (this.db.$queryRaw のような形も拾う。型引数付きは式の中身を見る)
        const tag = ts.isExpressionWithTypeArguments(node.tag) ? node.tag.expression : node.tag;
        const name = memberName(tag);
        // 対象の API でなければ見ない
        if (name === null || !(TAGGED_MEMBERS as readonly string[]).includes(name)) return;
        // 見た数を数える
        checked += 1;
        // 値を埋め込んでいない (テンプレートに ${} が無い) 形はそのまま安全
        if (!ts.isTemplateExpression(node.template)) return;
        // 埋め込んでいる式をすべて見る
        for (const span of node.template.templateSpans) {
          // 単なる変数の参照 (id) か、その property (input.tenantId) だけを許す。
          // 関数呼び出し (Prisma.raw(...)) や文字列の組み立てはここで落とす
          const ok =
            ts.isIdentifier(span.expression) ||
            (ts.isPropertyAccessExpression(span.expression) &&
              ts.isIdentifier(span.expression.name));
          if (!ok) found.push(`${path}: ${name} の埋め込みが変数の参照ではない`);
        }
      });
    }
    // 生 SQL を 1 つも見ていなければ走査が壊れている (fail-closed)
    expect(checked).toBeGreaterThan(0);
    // 違反が無いこと
    expect(found).toEqual([]);
  });
});
