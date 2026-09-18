// Step0 の検証コマンド一覧 (gate-step0.mjs が実行し、gate-step1.mjs 以降が再利用する。写しを持たない)
export const STEP0_STEPS = [
  { name: 'OpenAPI 型生成', args: ['run', 'gen'] },
  { name: 'Prisma クライアント生成', args: ['run', 'db:generate'] },
  { name: 'Lint', args: ['run', 'lint'] },
  { name: 'Format check', args: ['run', 'format:check'] },
  { name: 'Typecheck', args: ['run', 'typecheck'] },
  { name: 'Unit tests', args: ['run', 'test'] },
];
