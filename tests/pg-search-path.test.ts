// 接続時に search_path を固定する libpq オプション文字列の組み立てを固定するテスト。
//
// なぜテストで縛るのか:
//   search_path はバインドパラメータで渡せず、文字列として組み立てるしかない
//   (`SET` はプレースホルダを取らない)。組み立てを間違えると、スキーマ名に含まれる
//   引用符やカンマがそのまま設定値として解釈され、**意図しないスキーマが検索対象に
//   混ざる**。しかもエラーにならず「別のスキーマのデータが読める / 書ける」という
//   静かな壊れ方をするため、振る舞いテストでは気付きにくい。
//   実 DB での解決結果は Step6 の契約テストで確かめる。ここは DB 無しで回る純粋な組み立て規則の側を固定する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// 検査対象 (純粋関数なので DB もモックも要らない)
import { buildSearchPathOption } from '@/lib/pg-search-path';

describe('buildSearchPathOption', () => {
  it('ふつうのスキーマ名を二重引用符で囲んで渡す', () => {
    // 単純な識別子でも引用しておく (予約語や大文字が来ても同じ規則で通るため)
    expect(buildSearchPathOption('app')).toBe('-c search_path="app"');
  });

  it('ハイフンを含む名前をそのまま扱える (Prisma 5 で使えていた形)', () => {
    // 引用しない実装だと構文エラーになっていたケース
    expect(buildSearchPathOption('agent-ops')).toBe('-c search_path="agent-ops"');
  });

  it('空白は libpq がオプション区切りとして食べるのでエスケープする', () => {
    // libpq は options の値を空白で区切るため、\ で退避しないと途中で切れる
    expect(buildSearchPathOption('my schema')).toBe('-c search_path="my\\ schema"');
  });

  it('半角スペース以外の空白文字 (タブ・改行) は受け付けない', () => {
    // バックスラッシュで退避してもサーバ側の分割 (pg_split_opts) が区切りとして扱うため、
    // 通すと接続時に分かりにくいエラーになる。入口で理由付きで落とす
    expect(() => buildSearchPathOption('tab\there')).toThrow(/空白文字/);
    expect(() => buildSearchPathOption('line\nbreak')).toThrow(/空白文字/);
  });

  it('バックスラッシュを含む名前もエスケープする', () => {
    // libpq は \ を「次の 1 文字をそのまま使う」記号として消費する
    expect(buildSearchPathOption('back\\slash')).toBe('-c search_path="back\\\\slash"');
  });

  it('二重引用符を含む名前は受け付けない (Prisma 側が生成 SQL でエスケープしないため)', () => {
    // search_path 側だけなら扱えるが、ORM のクエリが構文エラーになるので入口で落とす。
    // 「片方だけ動く」状態を作らないための fail-closed
    expect(() => buildSearchPathOption('we"ird')).toThrow(/二重引用符/);
  });

  it('カンマや追加スキーマを混ぜた名前でも検索対象を増やせない', () => {
    // `?schema=app,public` のような値で public を検索対象へ紛れ込ませる試み。
    // 全体が 1 つの引用符付き識別子になるので、存在しないスキーマ名として扱われる
    expect(buildSearchPathOption('app,public')).toBe('-c search_path="app,public"');
  });

  it('空のスキーマ名は受け付けない (どのスキーマも指さないため)', () => {
    // `?schema=` と書かれた場合。黙って public にフォールバックさせない (fail-closed)
    expect(() => buildSearchPathOption('')).toThrow(/スキーマ名/);
  });
});
