// ドメイン層が使う enum/型の正準 (canonical) な参照元。
// Prisma の生成物を直接 import できるのはこのファイルと Prisma の結線箇所だけ (eslint.config.mjs)。
// 生成物の import 経路を 1 か所に絞ることで、ORM を差し替えたときの影響をここに閉じ込める。
export {
  AgentStatus,
  IncidentStatus,
  Plan,
  Provider,
  Role,
  RuleAction,
  RuleKind,
} from '@/generated/prisma';
