// 公開エンドポイントのレート制限（スライディングウィンドウ）。ADR-0007 の「残る宿題」のうち
// 「有効な API キーがあれば無制限に中継を要求できる」を閉じる（§9 公開エンドポイントを保護する）。
//
// **数えるキーは認証済みの資格情報の id にする。** IP ベースにしないのが要点で、送信元 IP は
// `X-Forwarded-For` 由来なので偽装でき、per-IP の枠は使い捨てのヘッダで迂回できる。
// テナントの id は認証を通ったあとに決まる値なので偽装できない。
//
// **このモジュールが持つのは「方針」だけ**（ADR-0015）。窓の中の件数を数えて 1 行足すのは
// data 層（`repos.rateLimit`）で、記録は**配備全体で 1 つの DB** に置く。以前はこのファイルが
// インプロセスの `Map` を持っていたので、同じテナントの要求が別のインスタンスへ振られると
// 枠が別々に数えられ、水平スケールすると「インスタンス数 × 上限」まで通った（ADR-0010 の宿題）。
// 費用を払う単位はテナントなので、枠も配備全体で 1 つでなければ意味を持たない。
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
import { describeError } from '@/lib/describe-error';
import { logEventThrottled } from '@/lib/log';
import type { RateLimitConsumeResult, Repositories } from '@/data/ports';
import type { Principal } from './auth';

/**
 * テスト専用の上限の上書き（`setRateLimitOverridesForTesting` が受け取る形）。
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
// `Retry-After` の最小値（秒）。**0 を返さない** — delay-seconds は整数なので 0 は
// 「いますぐ再試行」になり、同じ要求が即座に 429 で跳ね返る輪ができる
const MIN_RETRY_AFTER_SECONDS = 1;

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

// ── テスト専用の上書き ──────────────────────────────
// 共有の枠・追加の枠の上限と窓の長さの上書き（`null` なら本番と同じ決め方）。
// **本番では設定できない** — 設定する関数が `NODE_ENV=production` で throw する
let sharedLimitOverrideForTesting: number | null = null;
let extraLimitOverrideForTesting: number | null = null;
let windowMsOverrideForTesting: number | null = null;

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
  // 追加の枠を持たない種類。**素の添字では引かない** — 型の外から `constructor` のような値が
  // 届くと `Object.prototype` 由来の関数が返り、以降の比較が意図しない経路へ落ちる
  // （`src/domain/plan.ts` の `planLimitsFor` と `src/lib/log.ts` の `lookupLogEvent` と同じ引き方）
  const limit = Object.hasOwn(EXTRA_FRAME_LIMIT, tier) ? EXTRA_FRAME_LIMIT[tier] : null;
  if (limit === null) return null;
  // テスト専用の上書きがあればそれを使う
  return extraLimitOverrideForTesting ?? limit;
}

/**
 * 窓の長さ（ミリ秒）。テストの上書きがあればそれを使う。
 *
 * **正の整数でなければ落とす（fail-closed）。** 0 以下だと窓の下端が「いま」と同値以降になり、
 * **どの記録も数えられず全部通る**＝レート制限が無言で消える（以前はこの検証を制限器の
 * コンストラクタが持っていた）。渡す側のバグを隠さない。
 * **`export` してあるのは保守の定期実行（`src/lib/maintenance/run.ts`）が「どの窓にも入らない
 * 記録」の境目を同じ値から導くため。** `RATE_LIMIT_WINDOW_MS` を直接読む形にすると、
 * テストの上書きが効かないうえ、上の fail-closed の検証を通らない値で境目が決まりうる。
 * @returns 窓の長さ
 */
export function rateLimitWindowMs(): number {
  // 上書きが無ければ既定（毎分）
  const windowMs = windowMsOverrideForTesting ?? RATE_LIMIT_WINDOW_MS;
  // 壊れていれば落とす（0 以下は「制限が丸ごと無効」を意味する）
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new RangeError('レート制限の窓の長さは正の整数でなければなりません');
  }
  // 使う値
  return windowMs;
}

/**
 * 上限が使える値か確かめる（**正の整数でなければ落とす**）。
 *
 * 0 や NaN を通すと「上限に達することが無い」か「全部断る」のどちらかになり、前者は保護が
 * 黙って消える（以前はこの検証を制限器の `evaluate` が持っていた）。
 * @param limit 確かめる上限
 * @param label どちらの枠か（失敗文言に出す）
 */
function assertUsableLimit(limit: number, label: string): void {
  // 整数でない・0 以下はいずれも設定の誤り
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`${label}の上限は正の整数でなければなりません`);
  }
}

/**
 * 断ったときの待ち時間（秒）を決める**純粋関数**。
 *
 * **上限に達している枠だけを見る。** その枠で最も古い記録が窓から外れた瞬間に 1 回ぶんの空きが
 * できるので、`最も古い記録 + 窓の長さ - いま` が待つべき時間。両方の枠が埋まっていれば
 * **長いほうを返す**（短いほうを返すと、その時刻に再試行しても必ず断られる）。
 *
 * **「最も古い記録」は記録側が最小値として返す**（配列の先頭ではない）。時刻は壁時計なので
 * NTP の時刻合わせで巻き戻りうる — 先頭を信じると巻き戻った幅のぶん長く待たせる。
 *
 * **待ち時間は窓の長さを超えない。** 記録側の時計が巻き戻れば「最も古い記録」が未来に
 * なりうるが、どんな場合でも窓の長さだけ待てば必ず 1 回ぶんの空きができる（それより長く
 * 待たせるのは、素直に従うクライアントを理由なく止めることになる）。
 *
 * @param result 記録側が返した件数・最古の時刻・記録側の「いま」
 * @param windowMs 窓の長さ（ミリ秒）
 * @param sharedLimit 共有の枠の上限
 * @param extraLimit 追加の枠の上限（持たない種類は null）
 * @returns 待つべき秒数（1 以上・窓の長さ以下の整数）
 */
export function retryAfterSecondsFor(
  result: RateLimitConsumeResult,
  windowMs: number,
  sharedLimit: number,
  extraLimit: number | null,
): number {
  // 上限に達している枠の「最も古い記録」を集める
  const blocking: Date[] = [];
  // 共有の枠（種類を問わない合計）
  if (result.sharedCount >= sharedLimit && result.sharedOldest !== null) {
    blocking.push(result.sharedOldest);
  }
  // 追加の枠（その種類だけの合計）
  if (extraLimit !== null && result.extraCount >= extraLimit && result.extraOldest !== null) {
    blocking.push(result.extraOldest);
  }
  // どの枠も「最も古い記録」を持たないなら最低値で答える（上限が壊れている場合の保険）
  if (blocking.length === 0) return MIN_RETRY_AFTER_SECONDS;
  // 空きができるまでのミリ秒（複数あれば長いほう）。**窓の長さで頭打ちにする**（上の説明）
  const waitMs = Math.min(
    windowMs,
    Math.max(...blocking.map((oldest) => oldest.getTime() + windowMs - result.at.getTime())),
  );
  // 秒へ切り上げ、最低 1 秒にする（RFC 9110 の delay-seconds は整数）
  return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(waitMs / MILLIS_PER_SECOND));
}

/**
 * その主体の 1 回の呼び出しを数え、上限を超えていれば 429 を投げる。
 *
 * **判定も記録も data 層の 1 回の操作で行う**（ADR-0015）。読んでから書く形に分けると、
 * 同時に届いた 2 本がどちらも「上限未満」を読んで両方が通る。共有の枠と追加の枠の
 * **両方**が上限未満のときだけ 1 行足すので、片方だけが消費された状態にもならない。
 *
 * **ストアが落ちたら断る（fail-closed）。** 数えられないまま通すと、DB 障害のあいだだけ
 * レート制限が丸ごと無効になる（しかも上流への課金は止まらない）。例外はそのまま投げて
 * 500 にし、**上流への呼び出しは 1 度も起こさない**。
 *
 * **「いま」を受け取らない。** 窓の判定に使う時刻は**記録側（1 つの DB）の時計**が決める —
 * アプリのインスタンスごとの壁時計を使うと、記録が配備全体で 1 つでも時刻がずれた台数ぶん
 * 枠が割れる（この PR が閉じた穴が、時刻の側から戻ってくる）。
 *
 * @param repos リポジトリの束（`rateLimit` を使う）
 * @param principal 認証済みの主体
 * @param tier 枠の種類
 */
export async function enforceRateLimit(
  repos: Repositories,
  principal: Principal,
  tier: RateLimitTier,
): Promise<void> {
  // 数える単位（認証済みの id。偽装できる値は使わない）
  const key = rateLimitKeyFor(principal);
  // 共有の枠の上限（プラン別）
  const sharedLimit = sharedRateLimitFor(principal);
  // 追加の枠の上限（持たない種類は null）
  const extraLimit = extraRateLimitFor(tier);
  // 上限が使える値であること（壊れていたら落とす。fail-closed）
  assertUsableLimit(sharedLimit, '共有の枠');
  if (extraLimit !== null) assertUsableLimit(extraLimit, '追加の枠');
  // 窓の長さ（下端は記録側が自分の時計から決める。理由は Port の `windowMs`）
  const windowMs = rateLimitWindowMs();
  // 数えて、通せるなら 1 行足す（1 回の操作）
  const result = await consumeOrFail({
    repos,
    input: { key, tier, windowMs, sharedLimit, extraLimit },
  });
  // 通るならここで終わり（記録はもう足されている）
  if (result.allowed) return;
  // **枠を数えられなかった（混雑）場合も記録を残す** — 上限超過と区別できないと、
  // 運用者は「上限を上げれば直る」と読む（直らない。詰まっているのは判定そのもの）
  if (result.contended) logEventThrottled('rate_limit.contended');
  // 断るので待ち時間を決めて 429 にする（**基準は記録側の時計**。理由は結果の `at`）
  throw rateLimitedError(retryAfterSecondsFor(result, windowMs, sharedLimit, extraLimit));
}

/**
 * 記録側を呼び、落ちたら**専用の出来事を残してから**投げ直す。
 *
 * ストア障害を汎用の 500（`api.unexpected_error`）に埋もれさせない — 運用者が知りたいのは
 * 「断っているのが上限超過なのか、枠を数えられていないのか」。**行は間引く**
 * （DB が落ちている間は全要求で起きる＝直るまで続く条件。`health.db_unreachable` と同じ判断）。
 * @param args リポジトリと入力
 * @returns 記録側の結果
 */
async function consumeOrFail(args: {
  repos: Repositories;
  input: Parameters<Repositories['rateLimit']['consume']>[0];
}): Promise<RateLimitConsumeResult> {
  // 記録側へ渡す（1 回の操作で数えて足す）
  try {
    return await args.repos.rateLimit.consume(args.input);
  } catch (error) {
    // 枠を数えられなかったことを残す（通す側へ倒さないので、応答は 500 になる）
    logEventThrottled('rate_limit.store_unavailable', describeError(error));
    // 原因を隠さずそのまま投げる（§6 エラーを握り潰さない）
    throw error;
  }
}

/**
 * テスト専用: 上限・窓の長さの上書きを設定する。本番では呼べない（fail-closed）。
 *
 * **記録は DB にあるので「作り直す」ものは無い**（以前のインプロセスの表と違う）。
 * テストごとの隔離は memory アダプタを作り直すこと（`createMemoryRepos`）か、
 * 契約テストの `TRUNCATE` が行う。ここで設定するのは**方針の値だけ**。
 *
 * `limit` を渡すと上限の上書きになる（本番はプランから決まるので、数回の呼び出しで
 * 「上限を超える」挙動を確かめたいテストのための逃げ道）。省略すれば本番と同じ決め方に戻る。
 *
 * @param options 共有の枠の上書き（`windowMs` は両方の枠に効く）
 * @param extraOptions 追加の枠の上限の上書き
 */
export function setRateLimitOverridesForTesting(
  options?: RateLimitOverrideForTesting,
  extraOptions?: RateLimitOverrideForTesting,
): void {
  // 本番で上書きできると、呼ぶだけで上限を外せる
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setRateLimitOverridesForTesting は本番では使えません。');
  }
  // 上限の上書き（省略なら本番と同じ決め方へ戻す）
  sharedLimitOverrideForTesting = options?.limit ?? null;
  extraLimitOverrideForTesting = extraOptions?.limit ?? null;
  // **窓の長さは 1 つしかない**（共有の枠と追加の枠で別々にはできない） —
  // 記録が 1 つの表なので、同じ行を 2 つの窓で数えることになる。
  // 以前は枠ごとにインスタンスを持てたので別々に指定できたが、その形は
  // 「同じ呼び出しが別の窓に属する」という表現できない状態を許していた
  windowMsOverrideForTesting = options?.windowMs ?? extraOptions?.windowMs ?? null;
}
