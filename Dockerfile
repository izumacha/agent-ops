# ベースイメージ: 軽量な Alpine Linux 上の Node.js 22 (.nvmrc / CI / engines.node と同じ major に揃える)
FROM node:22-alpine AS base
# 作業ディレクトリ (以降のコマンドのカレント)
WORKDIR /app

# 依存解決ステージ (キャッシュ最適化のため分離)
FROM base AS deps
# package.json と package-lock.json を先にコピー (依存変更が無ければキャッシュが効く)
COPY package*.json ./
# lockfile に従って厳密インストール (再現性重視)
RUN npm ci

# 本番用依存だけを解決するステージ (runner へ持ち込む node_modules。eslint / typescript / vitest 等の
# devDependencies を実行イメージに載せない。migrate / seed に要る prisma・tsx・dotenv は dependencies 側にある)
FROM base AS prod-deps
# Prisma CLI のスキーマエンジンが要求する OpenSSL 3 (postinstall で prisma が動く)
RUN apk add --no-cache openssl
# lockfile を先にコピー
COPY package*.json ./
# devDependencies を除いて厳密インストール
RUN npm ci --omit=dev

# ビルドステージ (Next.js のプロダクションビルドを行う)
FROM base AS builder
# Prisma CLI のスキーマエンジンが要求する OpenSSL 3 を入れる (消すと prisma generate が動かない)
RUN apk add --no-cache openssl
# deps から node_modules を持ち込む
COPY --from=deps /app/node_modules ./node_modules
# ソース全体をコピー (.dockerignore で tests/docs は除外)
COPY . .
# OpenAPI 型と Prisma クライアントを生成 (どちらも gitignore の生成物)
RUN npm run gen && npx prisma generate
# Next.js を本番ビルド (standalone 出力)
RUN npm run build

# 実行ステージ (ビルド成果物だけを持つ最小イメージ)
FROM base AS runner
# 本番モード
ENV NODE_ENV=production
# コンテナ内のタイムゾーンを日本時間に固定
ENV TZ=Asia/Tokyo
# 実行イメージでも `prisma migrate deploy` / `prisma db seed` を叩けるよう OpenSSL 3 を導入する
RUN apk add --no-cache openssl

# 専用グループ・ユーザーを作成 (root 実行を避ける)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 静的ファイル
COPY --from=builder /app/public ./public
# Next.js standalone のサーバ本体
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Next.js が配信する静的ビルド成果物
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma / OpenAPI の生成物 (src/generated を相対パスで参照しているため)
COPY --from=builder /app/src/generated ./src/generated

# 起動後に prisma migrate / db seed を実行できるよう CLI と関連ファイルを同梱
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# seed (prisma/seed.ts) が相対 import で参照する src/ 配下のファイルと、`@/` を解決する tsconfig。
# 列挙は seed の import グラフと tests/docker-seed-files.test.ts が突き合わせる (足し忘れ・余分はどちらも落ちる)
COPY --from=builder /app/src/lib/prisma-client.ts ./src/lib/prisma-client.ts
COPY --from=builder /app/src/domain/types.ts ./src/domain/types.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# 本番用依存だけを取り込む (Prisma CLI / tsx / dotenv を含み、dev ツールチェーンは含まない)
COPY --from=prod-deps /app/node_modules ./node_modules

# 非 root ユーザーで実行
USER nextjs
# コンテナが listen するポート
EXPOSE 3000
# Next.js が listen するポート
ENV PORT=3000
# 全 IP で listen (コンテナ外からアクセス可能に)
ENV HOSTNAME="0.0.0.0"

# 起動コマンド: マイグレーションを適用してからサーバを起動する (クリーン環境で compose up だけで動かすため)
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
