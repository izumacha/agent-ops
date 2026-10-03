# ADR-0004: 各 Step の受け入れ基準を `npm run gate:stepN` として自動化する

- **ステータス**: 採択
- **日付**: 2026-09-16

## 背景

ロードマップ（`docs/roadmap.md`）は 8 Step・約 14 週で、各 Step に数値の受け入れ基準がある。基準を人が目視で確認する運用だと、期限が近づくほど「だいたい満たしている」で次へ進みがちで、後の Step で前提が崩れる。

## 決定

- Step N の受け入れ基準を `scripts/gate-stepN.mjs` に落とし、`npm run gate:stepN` で検査する。1 つでも赤なら非 0 終了。
- CI は実装済みの最新 Step のゲートを必ず実行する。
- **`main` でゲートが緑になってから次 Step のブランチを切る。**
- 基準を緩めるときは、`docs/roadmap.md` と該当 ADR を同じ PR で更新する（テストだけを書き換えない）。
- **`npm audit` の検査範囲は本番依存だけ**（`--audit-level=high --omit=dev`）。開発依存の勧告は Dependabot で追い、ゲートでは止めない。

## 理由

- 基準が「コマンド 1 本」になると、レビュー時に判断が割れない。
- 性能基準（p95 ≦ 50ms、集計 ≦ 1 秒、停止 ≦ 3 秒）も計測をスクリプト化すれば CI で回帰検出できる。

## 結果

- Step0 のゲートは `gen` / `db:generate` / `lint` / `format:check` / `typecheck` / `test` / OpenAPI 定義の存在 / ADR 3 件以上を検査する（`format:check` は定数の削除などで崩れた書式を lint / typecheck / test のどれも拾えなかったため後から追加した）。
- 性能系のゲート（Step2 以降）は CI ランナーの性能差でぶれるため、しきい値と計測方法を各 Step の ADR で決めてから実装する。
- **`npm audit` を `--omit=dev` にした（Step4 の途中で変更）。** きっかけは `braces` の勧告（GHSA-vfj7-8cjw-p6xm、high、対象 `<=3.0.3`）で、**修正版が存在しないため「上げて直す」ができない**。到達経路は開発依存だけ（`eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`）で、ESLint が走らせる glob の深いネストで起きるスタック枯渇なので、**配布物にも実行時の経路にも入らない**。範囲を絞らないと「直す手段が無いのに全ての PR が赤」という状態が続き、そこで待つかゲートを一時的に無効化するかの二択になる（後者は基準そのものを失う）。**production 依存の high は引き続き 0 を要求する**（絞ったのは範囲だけで、しきい値は変えていない）。開発依存の勧告は `.github/dependabot.yml` の更新で追い、上流が修正版を出せば自然に解消する。**判断の記録を残す場所はここ**で、`--omit=dev` を外すときも同じようにこの ADR を更新する。
