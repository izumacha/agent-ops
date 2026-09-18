// 生 SQL の書き方を構文で固定する。Prisma はタグ付きテンプレート (`$queryRaw`) なら値をパラメータ化するが、
// `$queryRawUnsafe` / `Prisma.raw` は文字列をそのまま SQL に混ぜる。実測では lockActiveUser を
// `$queryRawUnsafe` + 文字列連結へ書き換えても全 244 件と契約 30 件が緑のまま通り、URL の
// パスパラメータから任意 SQL を実行できた (pg_sleep(2) が実際に 2 秒効いた)。
// 契約テストは正しい形の id しか渡さないので、値を見る検査では原理的に捕まえられない
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { forEachNode, parseSourceFiles } from './lib/source-files';

// 値を素通しする (＝禁止する) Prisma の API 名
const UNSAFE_MEMBERS = ['$queryRawUnsafe', '$executeRawUnsafe', 'raw', 'sql'] as const;
// パラメータ化される (＝許す) タグ付きテンプレートの API 名
const TAGGED_MEMBERS = ['$queryRaw', '$executeRaw'] as const;

// src 全体の構文木 (1 度だけ作る)
const FILES = parseSourceFiles();

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
        // 禁止した API に一致すれば記録する
        if (name !== null && (UNSAFE_MEMBERS as readonly string[]).includes(name)) {
          found.push(`${path}: ${name}`);
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
