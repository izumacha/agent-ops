// `docs/api.md`（API リファレンス）が **`openapi/openapi.yaml`（契約の正本）と一致している**
// ことを機械で確かめる。
//
// **なぜ要るか.** 読み物版の API ドキュメントは「書いた時点では正しい」けれど、エンドポイントを
// 足す・消すときに取り残される。lint も typecheck も全テストも緑のまま、**文書だけが嘘になる**
// （運用者が読むのはそちらなので、実装との乖離がそのまま問い合わせになる）。
//
// **両向きに突き合わせる.** 「契約にあるのに文書に無い」（書き忘れ）だけでなく、
// 「文書にあるのに契約に無い」（消したエンドポイントの行が残る）も落とす。片方だけだと、
// 導出が狭まったときに検査も一緒に狭まって「取りこぼしゼロ＝緑」で無力化される。
//
// **一覧を手書きしない.** 期待値はすべて契約から導く（この repo の他の検出網と同じ流儀）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// リポジトリのルート
const ROOT = process.cwd();
// 読み物版の API ドキュメント
const API_DOC = readFileSync(join(ROOT, 'docs', 'api.md'), 'utf8');
// 契約の正本
const SPEC = parse(readFileSync(join(ROOT, 'openapi', 'openapi.yaml'), 'utf8')) as {
  paths?: Record<string, Record<string, { operationId?: string } | unknown>>;
};
// HTTP メソッドとして扱うキー（`parameters` のような非メソッドのキーを拾わない）
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** 契約に書かれたオペレーション（`METHOD /path` → operationId） */
function contractOperations(): Map<string, string> {
  // 集めた結果
  const operations = new Map<string, string>();
  // パスごとに見る
  for (const [path, item] of Object.entries(SPEC.paths ?? {})) {
    // メソッドごとに見る
    for (const method of METHODS) {
      // そのメソッドの定義
      const operation = (item as Record<string, { operationId?: string } | undefined>)[method];
      // 無ければ次へ
      if (operation === undefined || typeof operation.operationId !== 'string') continue;
      // `METHOD /path` の形で覚える
      operations.set(`${method.toUpperCase()} ${path}`, operation.operationId);
    }
  }
  // 集めた結果
  return operations;
}

/** 文書の表に書かれたオペレーション（`` `METHOD /path` `` → operationId） */
function documentedOperations(): Map<string, string> {
  // 集めた結果
  const operations = new Map<string, string>();
  // 表の行（`| \`GET /x\` | \`getX\` | tag |` の形）だけを拾う
  for (const line of API_DOC.split('\n')) {
    // メソッドとパス、続く operationId をまとめて読む
    const matched = /^\|\s*`([A-Z]+ \/[^`]*)`\s*\|\s*`([^`]+)`\s*\|/.exec(line.trim());
    // 表の行でなければ飛ばす
    if (matched === null) continue;
    // 覚える
    operations.set(matched[1], matched[2]);
  }
  // 集めた結果
  return operations;
}

describe('docs/api.md と OpenAPI の契約', () => {
  it('契約のオペレーションがすべて文書の表にある（書き忘れを落とす）', () => {
    // 契約から導く
    const contract = contractOperations();
    // 1 件も読めなければ導出が壊れている（fail-closed）
    expect(contract.size, '契約からオペレーションを 1 件も読めない').toBeGreaterThan(0);
    // 文書から導く
    const documented = documentedOperations();
    // 1 件も読めなければ表の形が変わっている（fail-closed）
    expect(documented.size, 'docs/api.md の表から 1 件も読めない').toBeGreaterThan(0);
    // 契約にあるものがすべて書かれていること
    for (const [operation, operationId] of contract) {
      expect(
        documented.has(operation),
        `${operation} が docs/api.md の表に無い（契約へ足したら読み物版にも 1 行足す）`,
      ).toBe(true);
      // **operationId まで一致すること** — パスだけ合わせて別の操作を指す形を落とす
      expect(documented.get(operation), `${operation} の operationId が契約とずれている`).toBe(
        operationId,
      );
    }
  });

  it('文書の表にあるものはすべて契約に実在する（古い行が残らない）', () => {
    // 契約と文書
    const contract = contractOperations();
    const documented = documentedOperations();
    // どちらも読めていること（fail-closed）
    expect(contract.size).toBeGreaterThan(0);
    expect(documented.size).toBeGreaterThan(0);
    // 文書にあるものが契約にあること
    for (const operation of documented.keys()) {
      expect(
        contract.has(operation),
        `${operation} は契約（openapi/openapi.yaml）に無い（消したエンドポイントの行が残っている）`,
      ).toBe(true);
    }
    // **件数も一致すること** — 片方の導出が縮んだときに「包含はしているが数が違う」で気付く
    expect(documented.size, '表の行数と契約のオペレーション数が違う').toBe(contract.size);
  });
});
