// テストから YAML の設定ファイル（compose / GitHub Actions のワークフロー）を読む共通部分。
//
// **ここに集めてあるのは「マージキーを解決する」ことと「読めなければ落とす」ことの 2 つ。**
// 素の `parse` で読む版を 2 本持つと、片方だけが下の手当てを持つ状態になる（実測の経緯は
// `readYaml` の中のコメント）。**OpenAPI（`openapi/openapi.yaml`）を読む検査はここを通していない** —
// あちらはアンカーを使わない契約の正本で、取り込み口も別（各テストが自分で読む）。
import { expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// YAML を読んで解釈する（読めなければ前提が崩れているので落とす = fail-closed）。
// パスはリポジトリのルートからの相対で渡す（vitest のワーカーのカレントは常にプロジェクトの根）
export function readYaml(...segments: string[]): Record<string, unknown> {
  // ファイルを読む
  const text = readFileSync(join(process.cwd(), ...segments), 'utf8');
  // 解釈する。**マージキー (`<<: *anchor`) を解決する** — compose も GitHub Actions も
  // アンカーの取り込みを受け付けるので、既定の parse だと `services.db.ports` が undefined になり
  // 代わりに `'<<'` というリテラルキーが残る。実測では `x-exposed: &exposed` に
  // `ports: ['0.0.0.0:5432:5432']` を置いて db へ取り込むだけで、`docker compose config` は
  // 0.0.0.0 への公開を出力するのに全件緑のまま通った
  const parsed = parse(text, { merge: true }) as Record<string, unknown> | null;
  // オブジェクトとして読めること
  expect(parsed, `${segments.join('/')} を解釈できない`).toBeTypeOf('object');
  expect(parsed).not.toBeNull();
  // 呼び出し側が項目を取り出す
  return parsed as Record<string, unknown>;
}
