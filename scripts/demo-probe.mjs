#!/usr/bin/env node
// Step7 の受け入れ基準①「クリーン環境で `docker compose up` → 5 分以内にデモ動作」を
// **CI の `docker-smoke` ジョブで確かめる側**。
//   DEMO_BASE_URL=http://127.0.0.1:3000 DEMO_STARTED_AT_MS=<epoch ms> node scripts/demo-probe.mjs
//
// **デモの筋はベンチと共有する**（`scripts/lib/demo-flow.mjs` の `DEMO_STEPS` / `runDemoFlow`）。
// ここで別の手順を書くと「ゲートが測るデモ」と「CI が測るデモ」が静かにずれる（§6 DRY）。
// 違いは**時間の起点だけ**で、こちらは `docker compose up -d --build` を始めた時刻から数える
// （イメージのビルドとマイグレーション適用を含む＝基準そのもの）。ベンチは本番ビルドの起動から
// 数える部分集合で、ゲートが毎回確かめるのはそちら（解釈は `docs/roadmap.md` と ADR-0013）。
//
// **判定もここで行う**（上限は正本から読む）。ワークフロー側で秒数を比べる形にすると、
// 上限の写しが YAML に生まれて片方だけ古くなる。
import { DEMO_READY_MAX_MS } from './lib/step7-criteria.mjs';
import { DEMO_STEPS, runDemoFlow } from './lib/demo-flow.mjs';

// 叩く先（compose が公開しているアプリ）
const baseUrl = process.env.DEMO_BASE_URL;
// テナント作成に要るプラットフォーム管理者トークン（compose へ渡したものと同じ値）
const platformAdminToken = process.env.PLATFORM_ADMIN_TOKEN;
// `docker compose up` を始めた時刻（epoch ミリ秒。ワークフローが記録して渡す）
const startedAtMs = Number(process.env.DEMO_STARTED_AT_MS);

// 見つかった問題（1 件でもあれば非 0 で終わる）
const problems = [];
// 設定が揃っていなければ測れない（fail-closed。「測れないから緑」に倒さない）
if (baseUrl === undefined || baseUrl === '') problems.push('DEMO_BASE_URL が未設定です');
if (platformAdminToken === undefined || platformAdminToken === '')
  problems.push('PLATFORM_ADMIN_TOKEN が未設定です');
if (!Number.isFinite(startedAtMs) || startedAtMs <= 0)
  problems.push('DEMO_STARTED_AT_MS が epoch ミリ秒ではありません');

// 設定が揃っていればデモの筋を 1 回通す
if (problems.length === 0) {
  // 失敗しても理由を残して非 0 で終わらせたいので受け止める
  try {
    // デモの筋（ベンチと同じ関数）
    const flow = await runDemoFlow({ baseUrl, platformAdminToken });
    // `docker compose up` からの所要時間
    const elapsedMs = Date.now() - startedAtMs;
    // 通った段が宣言どおりか（段を削った計測を「デモが動いた」と数えない）
    if (flow.steps.length < DEMO_STEPS.length)
      problems.push(`デモの段を ${flow.steps.length}/${DEMO_STEPS.length} しか通っていません`);
    // 登録したものが一覧に出たか（書いたものが読めたことの裏打ち）
    if (flow.agentsListed <= 0) problems.push('登録したエージェントが一覧に出ていません');
    // 停止の操作が記録に残ったか（`runDemoFlow` も 0 件なら落ちるが、結果に載せて読めるようにする）
    if (flow.auditRows <= 0) problems.push('停止したのに監査ログが 0 件です');
    // 受け入れ基準そのもの
    if (elapsedMs > DEMO_READY_MAX_MS)
      problems.push(`デモが動くまでが遅すぎます: ${elapsedMs}ms (上限 ${DEMO_READY_MAX_MS}ms)`);
    // 結果を 1 行の JSON で出す（人が読む・ログに残す）
    console.log(
      JSON.stringify({
        probe: 'demo-ready',
        elapsedMs,
        limitMs: DEMO_READY_MAX_MS,
        steps: flow.steps,
        agentsListed: flow.agentsListed,
        auditRows: flow.auditRows,
        plan: flow.plan,
        passed: problems.length === 0,
      }),
    );
  } catch (error) {
    // デモの筋が通らなかった（段の途中で落ちた）
    problems.push(error instanceof Error ? error.message : String(error));
  }
}

// 理由を 1 件ずつ出す
for (const problem of problems) console.error('[demo-probe]', problem);
// 1 件でもあれば非 0 で終わる（ワークフローが赤になる）
if (problems.length > 0) process.exit(1);
