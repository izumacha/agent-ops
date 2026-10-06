// 公開エンドポイントのレート制限（スライディングウィンドウ）。ADR-0007 の「残る宿題」のうち
// 「有効な API キーがあれば無制限に中継を要求できる」を閉じる（§9 公開エンドポイントを保護する）。
//
// **数えるキーは認証済みの資格情報の id にする。** IP ベースにしないのが要点で、送信元 IP は
// `X-Forwarded-For` 由来なので偽装でき、per-IP の枠は使い捨てのヘッダで迂回できる。
// API キーの id は認証を通ったあとに決まる値なので偽装できない。
//
// **インプロセスの Map なので、プロセスをまたいだ合計にはならない。** 水平スケールすると
// 「プロセス数 × 上限」まで通る。共有ストア（Redis 等）へ移すのは Step6 の課題として
// ADR-0010 に記録する。それでも「無制限」ではなくなるので、置かないより明確に良い。
import { ApiError } from './errors';
import { HTTP_STATUS } from './http-status';
import {
  API_MESSAGES,
  FAN_OUT_ROUTE_RATE_LIMIT_PER_MINUTE,
  HEAVY_READ_ROUTE_RATE_LIMIT_PER_MINUTE,
  OUTBOUND_WAIT_ROUTE_RATE_LIMIT_PER_MINUTE,
  PROXY_RATE_LIMIT_ENV,
  RATE_LIMIT_WINDOW_MS,
} from '@/lib/constants';
import { FALLBACK_PLAN, planLimitsFor } from '@/domain/plan';
import type { Principal } from './auth';

/** 1 回の判定の結果 */
export interface RateLimitDecision {
  // 通してよいか
  allowed: boolean;
  // 次に試してよいまでの秒数（`allowed` が false のときだけ意味を持つ）
  retryAfterSeconds: number;
}

/**
 * 制限器の設定。
 *
 * **上限は持たない（Step6）。** 窓の中で許す回数は契約プランごとに違うので、`check` / `inspect`
 * の引数で 1 回ごとに渡す。制限器が覚えるのは「キーごとの呼び出し時刻」だけで、上限は判定の
 * 時点の方針として外から与える形にしてある — 制限器を上限ごとに分けると、プランを変えた
 * テナントの記録が別の制限器へ移って**窓の途中で数え直し**になる（上げた直後は得をし、
 * 下げた直後は上限を超えて通る）。
 */
export interface RateLimiterOptions {
  // 窓の長さ（ミリ秒）
  windowMs: number;
}

/**
 * テスト専用の上限の上書き（`resetSharedRateLimiterForTesting` が受け取る形）。
 *
 * 本番の上限はプラン（と環境変数）から決まるが、テストは「上限を超える」挙動を数回の呼び出しで
 * 確かめたい（既定の毎分 600 回を実際に叩くのは遅い）。**本番では設定できない**ので、
 * 上書きの経路が運用に漏れることはない。
 */
export interface RateLimitOverrideForTesting {
  // 窓の中で許す回数（省略すると本番と同じ決め方）
  limit?: number;
  // 窓の長さ（ミリ秒。省略すると既定）
  windowMs?: number;
}

// 1 秒のミリ秒数（`Retry-After` を秒へ直すのに使う）
const MILLIS_PER_SECOND = 1_000;
// 掃除を走らせる間隔を窓の長さから導く割り算の分母。
// **「表が満杯のとき」を条件にしてはいけない** — 山を越えて件数が減った時点で掃除が二度と
// 走らず、期限切れの記録をプロセスが生きているあいだ抱え続ける（回収したいのはまさにその状態）。
// **「1 窓に 1 回」でもいけない** — 窓の早い時点（まだ何も期限切れでない時点）で使い切ると、
// その後に期限切れになっても次の窓まで回収されない。間隔で絞れば遅れは常に 1 間隔以内
const SWEEP_INTERVALS_PER_WINDOW = 60;

/**
 * 送信元ごとのスライディングウィンドウ制限器。
 *
 * **時刻を引数で受け取る純粋な形**に保つ（`Date.now()` を内部で読まない）ので、境界値を
 * ユニットテストで決定的に固定できる（§11）。
 */
export class SlidingWindowRateLimiter {
  // 窓の長さ（ミリ秒）
  private readonly windowMs: number;
  // 掃除を走らせる間隔（ミリ秒）
  private readonly sweepIntervalMs: number;
  // キーごとの「窓の中の呼び出し時刻」
  private readonly hits = new Map<string, number[]>();
  // 最後に掃除した時刻（まだ掃除していないことを表すため null から始める）
  private lastSweptAt: number | null = null;
  // 掃除を走らせた回数。**判定の結果には現れない**ので、観測できるように公開する
  // （間隔で絞れていることをテストで確かめるため。リクエスト数に比例して走ると
  //  使い捨てキーで表を膨らませたうえで全リクエストに走査の費用を負わせられる）
  private sweeps = 0;

  // 窓の長さを受け取る。**正の整数でなければ落とす**
  constructor(options: RateLimiterOptions) {
    // 窓が 0 以下だと記録が常に空になり、レート制限が丸ごと無効になる（fail-closed で落とす）
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('レート制限の窓の長さは正の整数でなければなりません');
    }
    // 設定を覚える
    this.windowMs = options.windowMs;
    // 掃除の間隔は窓の長さから導く（数値を 2 か所に書かない）
    this.sweepIntervalMs = Math.max(1, Math.floor(options.windowMs / SWEEP_INTERVALS_PER_WINDOW));
  }

  /** 掃除を走らせた回数（テストが「リクエスト数に比例していない」ことを確かめる） */
  get sweepCount(): number {
    // 観測用の読み取り専用プロパティ
    return this.sweeps;
  }

  /** いま覚えているキーの数（テストが回収されていることを確かめる） */
  get trackedKeys(): number {
    // 表の件数
    return this.hits.size;
  }

  /**
   * 1 回の呼び出しを数えて、通してよいかを返す。
   *
   * @param key 送信元を表すキー（認証済みの id。偽装できる値を渡さない）
   * @param now 現在時刻（ミリ秒）。呼び出し側が渡すので、テストが時刻を決められる
   * @param limit 窓の中で許す回数（プランごとに違うので呼び出しごとに渡す）
   */
  check(key: string, now: number, limit: number): RateLimitDecision {
    // 数えながら判定する
    return this.evaluate(key, now, limit, true);
  }

  /**
   * 数えずに「いま通せるか」だけを返す。
   *
   * **2 つ以上の枠を同時に見る経路のために要る**（`enforceRateLimit`）。`check` を順に呼ぶと、
   * 1 つ目が通って 2 つ目が断ったときに 1 つ目だけが呼び出しを数えてしまう。断った要求を
   * 数えないのはこの制限器の約束（数えると断られ続けるあいだ窓が延びて永久に通れない）なので、
   * 「全部の枠が通ると分かってから数える」ために覗き見だけの形を用意する。
   */
  inspect(key: string, now: number, limit: number): RateLimitDecision {
    // 数えずに判定する
    return this.evaluate(key, now, limit, false);
  }

  // 判定の本体。`record` が true のときだけ今回の呼び出しを覚える
  private evaluate(key: string, now: number, limit: number, record: boolean): RateLimitDecision {
    // **上限が壊れていたら落とす（fail-closed）** — 0 や NaN を通すと「上限に達することが無い」
    // か「全部断る」のどちらかになり、前者は保護が黙って消える。渡す側のバグを隠さない
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('レート制限の上限は正の整数でなければなりません');
    }
    // まず期限切れの記録を間隔ごとに回収する（表が膨らみ続けないように）
    this.sweepIfDue(now);
    // 窓の開始時刻（これ以前の記録は数えない）
    const windowStart = now - this.windowMs;
    // そのキーの記録のうち窓の中に残っているもの
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);
    // 上限に達していれば通さない
    if (recent.length >= limit) {
      // 窓から最も古い記録が外れるまでの時間（それより前に試しても必ず断られる）。
      // **先頭ではなく最小値を取る** — 配列は push 順なので「昇順に並んでいる」は
      // `now` が単調増加することに依存する。呼び出し側は `Date.now()` を渡すので NTP の
      // 時刻合わせで巻き戻りうる。先頭を信じると、巻き戻った幅のぶん Retry-After を
      // 長く返し、素直に従うクライアントが必要以上に待つ
      const oldest = recent.reduce((min, at) => (at < min ? at : min), now);
      // 秒へ切り上げる。**RFC 9110 の delay-seconds は整数**で、小数を送るとヘッダが
      // 無いのと同じ扱いになる。0 秒は「すぐ試してよい」に見えるので最低 1 秒にする
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - now) / MILLIS_PER_SECOND),
      );
      // 絞り込んだ記録を書き戻す（断った呼び出しは数えない — 断られ続けると窓が延びてしまう）
      this.hits.set(key, recent);
      // 断る
      return { allowed: false, retryAfterSeconds };
    }
    // 通すので今回の時刻を足して覚える。**覗き見のときは表に触らない** —
    // 空の配列でも書き戻すとキーが表に残り、覗き見だけで表を膨らませられる
    // （断る側の書き戻しは既にあるキーの絞り込みなので、新しいキーは作らない）
    if (record) {
      recent.push(now);
      this.hits.set(key, recent);
    }
    // 通す（`retryAfterSeconds` は使われない）
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // 期限切れの記録を回収する。**間隔が来ていなければ何もしない**
  private sweepIfDue(now: number): void {
    // 初回は必ず走らせず、最初の呼び出し時刻を基準にする（起動直後に全走査しない）
    if (this.lastSweptAt === null) {
      this.lastSweptAt = now;
      return;
    }
    // 間隔が来ていなければ帰る
    if (now - this.lastSweptAt < this.sweepIntervalMs) return;
    // 基準を更新して回数を数える
    this.lastSweptAt = now;
    this.sweeps += 1;
    // 窓の開始時刻
    const windowStart = now - this.windowMs;
    // すべてのキーを見て、窓の中に 1 件も残らないものは表から消す
    for (const [key, times] of this.hits) {
      // 窓の中に残る記録
      const recent = times.filter((at) => at > windowStart);
      // 1 件も残らなければキーごと消す（残れば絞り込んだ配列へ差し替える）
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

/**
 * 認証済みの主体からレート制限のキーを作る。**偽装できる値（IP・ヘッダ）は使わない。**
 *
 * 種類ごとに接頭辞を付けるのは、別の種類の id がたまたま同じ文字列だったときに
 * 枠を共有しないようにするため（id は資源ごとに独立した `cuid` なので衝突は考えにくいが、
 * 枠の共有は「他人の呼び出しで断られる」という分かりにくい形で現れる）。
 */
export function rateLimitKeyFor(principal: Principal): string {
  // 主体の種類ごとに数える単位を決める
  switch (principal.kind) {
    case 'agent':
    case 'user':
      // **テナント単位で数える。** API キー単位・ユーザー単位にしてはいけない —
      // どちらも利用者が API から好きなだけ増やせるので（`POST /api-keys` ・ `POST /users` に
      // 件数の上限は無い）、枠を資格情報ごとに持つと**キーを増やすだけで上限が何倍にもなる**。
      // 実測の形: 同じエージェント向けのキーを 100 本発行すると中継は毎分 60,000 回通り、
      // 予算 (`Agent.budgetMicroUsd`) が未設定なら上流への課金に歯止めが無くなる。
      // エージェント単位でも同じ（エージェントも API から増やせる）。
      //
      // **代償**: 1 つの壊れたクライアントが同じテナントの枠を食い潰しうる（以前の
      // 「キーごとに独立」はこれを避ける意図だった）。費用を払う単位はテナントなので、
      // 「自分の枠を自分で使い切る」ほうを選ぶ（ベンダーへの無制限な課金より軽い）。
      // 配備先ごとの調整は `PROXY_RATE_LIMIT_PER_MINUTE` で行う。
      return `tenant:${principal.tenantId}`;
    case 'platform':
      // プラットフォーム管理者トークンは 1 本しかないので単一の枠
      return 'platform';
  }
}

/** レート制限を超えたときの例外（429 ＋ `Retry-After`） */
export function rateLimitedError(retryAfterSeconds: number): ApiError {
  // 429 に秒数のヘッダを付ける（クライアントが待ち時間を知れるようにする）
  return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, API_MESSAGES.rateLimited, undefined, {
    'Retry-After': String(retryAfterSeconds),
  });
}

/**
 * 環境変数による上限の上書きを読む（未設定・読めない値なら `null`）。
 *
 * **ベンチが上書きする**（`scripts/bench-proxy.ts`）: 1 接続で毎秒数百件を出すので既定の
 * 上限では 9 割近くが 429 になり、測れるのは「中継の追加遅延」ではなく「429 を返す速さ」に
 * なる（実測で 3516 件のうち 3116 件が 429 になり、ベンチの「2xx 以外があれば失敗」の
 * 門番が正しく落とした）。
 *
 * **設定するとプランの差が消える**（全テナントが同じ上限になる）。Step6 でプラン別にしても
 * この逃げ道を残しているのはベンチのためで、運用で設定するのは「全テナントに同じ上限を
 * 掛け直す」という意味になる。
 *
 * **読めない値は上書き無し（`null`）へ倒す（fail-closed）。** 設定ミスで制限が消えるより、
 * プランの上限が効いている方が安全。逆に「とても大きい値」を入れれば実質的に制限を外せるが、
 * 環境変数は運用者が意図して置く信頼値なので、それはその配備先の判断として受け入れる。
 */
export function rateLimitOverrideFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  // 環境変数を読み、前後の空白を落とす
  const raw = env[PROXY_RATE_LIMIT_ENV]?.trim();
  // 未設定・空は上書き無し
  if (raw === undefined || raw === '') return null;
  // 数値として読む（`Number` は空文字を 0 にするので、空の判定を先に済ませてある）
  const parsed = Number(raw);
  // 正の整数でなければ上書き無しへ倒す（0 や負の値を通すと制限が丸ごと無効になる）
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  // 設定された上限
  return parsed;
}

// ── プロセス共有の制限器 ──────────────────────────────
// **1 つのインスタンスをすべてのルートで共有する。** ルートごとに持つと、同じ API キーが
// 別のルートを交互に叩くだけで合計が上限の 2 倍まで通る（枠は「送信元ごと」で、
// 「送信元とルートの組ごと」ではない）
let shared = new SlidingWindowRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS });

// テスト専用: 共有の枠・追加の枠の上限の上書き（`null` なら本番と同じ決め方）。
// **本番では設定できない** — 設定する関数が `NODE_ENV=production` で throw する
let sharedLimitOverrideForTesting: number | null = null;
let extraLimitOverrideForTesting: number | null = null;

/**
 * そのルートに掛ける枠の種類。
 *
 * - `standard`: 上流へ 1 回ぶんの費用を出す経路（中継 2 本）。共有の枠だけを消費する
 * - `fanOut`: 1 要求で上流へ扇状に出る経路（評価の実行）
 * - `outbound`: 応答を返す前に外部の往復を待つ経路（ガードレールの明示実行）
 * - `heavyRead`: 1 要求で大量の行を読んで計算し直す経路（監査ログの連鎖の検証）
 *
 * `standard` 以外は共有の枠**と**種類ごとの小さい枠の両方を消費する。
 * **「重い」をひとまとめにしない** — 重さの中身（ベンダーへの課金 / 外部の応答時間と DB 負荷）が
 * 違えば妥当な上限も違うので、1 つに束ねるとどちらかの経路に必ず不適切な値になる
 * （理由は `src/lib/constants.ts` の 2 つの定数のコメント）。
 */
export const RATE_LIMIT_TIER = {
  standard: 'standard',
  fanOut: 'fanOut',
  outbound: 'outbound',
  heavyRead: 'heavyRead',
} as const;

/** 枠の種類（`RouteOptions.rateLimit` に書く値） */
export type RateLimitTier = (typeof RATE_LIMIT_TIER)[keyof typeof RATE_LIMIT_TIER];

/**
 * 種類ごとの「追加で消費する枠」の上限（`null` は追加の枠を持たない）。
 *
 * **網羅的な表にする** — 種類を足したらここへ書かないと型検査が落ちるので、
 * 「追加の枠を持たせるかどうか」を必ず一度決めることになる
 */
const EXTRA_FRAME_LIMIT: Readonly<Record<RateLimitTier, number | null>> = {
  standard: null,
  fanOut: FAN_OUT_ROUTE_RATE_LIMIT_PER_MINUTE,
  outbound: OUTBOUND_WAIT_ROUTE_RATE_LIMIT_PER_MINUTE,
  heavyRead: HEAVY_READ_ROUTE_RATE_LIMIT_PER_MINUTE,
};

// 種類ごとの追加の枠を作る（上の表から導くので、種類を足したら自動で増える）。
// **上限は制限器が持たない**ので、作るのは「追加の枠を持つ種類ぶんの記録表」だけ
function buildExtraFrames(windowMs: number): Map<RateLimitTier, SlidingWindowRateLimiter> {
  // 表の各項目から制限器を 1 つずつ作る
  return new Map(
    Object.entries(EXTRA_FRAME_LIMIT).flatMap(([tier, limit]) =>
      // 追加の枠を持たない種類は作らない
      limit === null
        ? []
        : [[tier as RateLimitTier, new SlidingWindowRateLimiter({ windowMs })] as const],
    ),
  );
}

// **種類ごとに追加で消費する枠.** 共有の枠と置き換えるのではなく両方を消費する
// （置き換えだと重い経路と中継を交互に叩くだけで合計が共有の上限を超える）
let extraFrames = buildExtraFrames(RATE_LIMIT_WINDOW_MS);

/** プロセス共有の制限器を返す（テストが表の状態を覗くのに使う） */
export function sharedRateLimiter(): SlidingWindowRateLimiter {
  // 共有インスタンス
  return shared;
}

/** 種類ごとの追加の枠を返す（持たない種類なら undefined。テストが表の状態を覗くのに使う） */
export function extraRateLimiter(tier: RateLimitTier): SlidingWindowRateLimiter | undefined {
  // その種類のインスタンス
  return extraFrames.get(tier);
}

/**
 * その主体が共有の枠で窓の中に出せる回数（Step6 でプラン別になった）。
 *
 * 優先順位は **テストの上書き → 環境変数の上書き → 契約プランの上限**。
 * プラットフォーム管理者はテナントではないのでプランを持たない。**倒れ先は最も厳しいプラン**
 * （`FALLBACK_PLAN`）で、いま共有の枠を宣言しているルートは 4 本ともテナントの経路なので
 * この分岐は実際には通らない（将来プラットフォームのルートへ枠を掛けるときに値を決める。
 * そのときまでは「分からないなら厳しい側」にしておく。§9 fail-closed）。
 */
export function sharedRateLimitFor(
  principal: Principal,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // テスト専用の上書き（本番では設定できない）
  if (sharedLimitOverrideForTesting !== null) return sharedLimitOverrideForTesting;
  // 環境変数の上書き（設定するとプランの差が消える）
  const override = rateLimitOverrideFromEnv(env);
  if (override !== null) return override;
  // プランから引く（プラットフォーム管理者は最も厳しいプランへ倒す）
  const plan = principal.kind === 'platform' ? FALLBACK_PLAN : principal.plan;
  return planLimitsFor(plan).proxyRateLimitPerMinute;
}

/**
 * その種類の追加の枠の上限（追加の枠を持たない種類なら `null`）。
 *
 * **環境変数では動かせない**（広げると `src/lib/constants.ts` の 3 つの根拠が崩れる）。
 * **プラン別にもしない** — 守っているのはテナントの取り分ではなく「1 要求の重さ」そのもの
 * （ベンダーへの課金・外部の応答時間・DB と CPU）なので、上位プランでも 1 要求の重さは同じ。
 */
export function extraRateLimitFor(tier: RateLimitTier): number | null {
  // 追加の枠を持たない種類
  const limit = EXTRA_FRAME_LIMIT[tier];
  if (limit === null) return null;
  // テスト専用の上書きがあればそれを使う
  return extraLimitOverrideForTesting ?? limit;
}

/**
 * その主体の 1 回の呼び出しを数え、上限を超えていれば 429 を投げる。
 *
 * **判定の順序をここ 1 か所に閉じ込める**（`route()` から枠の組み合わせを追い出す）。
 * すべての枠を**先に覗き見して**から数えるので、片方だけが消費された状態にならない。
 * 断るときは待ち時間の**長いほう**を返す（短いほうを返すと、その時刻に再試行しても必ず断られる）。
 */
export function enforceRateLimit(principal: Principal, tier: RateLimitTier, now: number): void {
  // 数える単位（認証済みの id。偽装できる値は使わない）
  const key = rateLimitKeyFor(principal);
  // 共有の枠の上限（プラン別）
  const sharedLimit = sharedRateLimitFor(principal);
  // その種類の追加の枠（持たない種類もある）
  const extra = extraFrames.get(tier);
  // 追加の枠の上限（枠が無ければ null）
  const extraLimit = extraRateLimitFor(tier);
  // 見るべき「枠と上限」の組。**共有の枠は必ず消費する**ので先に 1 つだけ書き、
  // 追加の枠を持つ種類はその後ろへ足す（両方の分岐に書くと、組み方を直したときに片方だけ直る）
  const frames: [SlidingWindowRateLimiter, number][] = [[shared, sharedLimit]];
  // 追加の枠を持つ種類だけ 2 つ目を足す（置き換えではなく「加えて」消費する）
  if (extra !== undefined && extraLimit !== null) frames.push([extra, extraLimit]);
  // まず全部を覗き見して、断るものがあるか調べる
  const denials = frames
    .map(([limiter, limit]) => limiter.inspect(key, now, limit))
    .filter((decision) => !decision.allowed);
  // 1 つでも断るなら、待ち時間の長いほうで 429 にする（どの枠も数えない）
  if (denials.length > 0) {
    throw rateLimitedError(Math.max(...denials.map((decision) => decision.retryAfterSeconds)));
  }
  // 全部通るので、ここで初めて数える
  for (const [limiter, limit] of frames) limiter.check(key, now, limit);
}

/**
 * テスト専用: 共有の制限器を作り直す。本番では呼べない（fail-closed）。
 *
 * 表はプロセスの寿命いっぱい残るので、これが無いとテストの実行順によって
 * 「前のテストが使った枠」が次のテストへ漏れる（`setReposForTesting` と同じ扱い）。
 *
 * `limit` を渡すと**上限の上書き**になる（本番はプランから決まるので、数回の呼び出しで
 * 「上限を超える」挙動を確かめたいテストのための逃げ道）。省略すれば本番と同じ決め方に戻る。
 */
export function resetSharedRateLimiterForTesting(
  options?: RateLimitOverrideForTesting,
  extraOptions?: RateLimitOverrideForTesting,
): void {
  // 本番で作り直せると、呼ぶだけで全員の枠が空になる
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSharedRateLimiterForTesting は本番では使えません。');
  }
  // 上限の上書き（省略なら本番と同じ決め方へ戻す）
  sharedLimitOverrideForTesting = options?.limit ?? null;
  extraLimitOverrideForTesting = extraOptions?.limit ?? null;
  // 記録表を作り直す（窓の長さは指定があればそれを使う）
  shared = new SlidingWindowRateLimiter({ windowMs: options?.windowMs ?? RATE_LIMIT_WINDOW_MS });
  // **追加の枠も必ず全部作り直す** — 片方だけ空にすると、前のテストが使った枠が
  // 次のテストへ漏れる（しかも漏れるのは小さいほうの枠なので、無関係なテストが 429 で落ちる）
  extraFrames = buildExtraFrames(extraOptions?.windowMs ?? RATE_LIMIT_WINDOW_MS);
}
