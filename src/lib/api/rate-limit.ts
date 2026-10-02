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
  HEAVY_ROUTE_RATE_LIMIT_PER_MINUTE,
  PROXY_RATE_LIMIT_ENV,
  PROXY_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from '@/lib/constants';
import type { Principal } from './auth';

/** 1 回の判定の結果 */
export interface RateLimitDecision {
  // 通してよいか
  allowed: boolean;
  // 次に試してよいまでの秒数（`allowed` が false のときだけ意味を持つ）
  retryAfterSeconds: number;
}

/** 制限器の設定 */
export interface RateLimiterOptions {
  // 窓の中で許す回数
  limit: number;
  // 窓の長さ（ミリ秒）
  windowMs: number;
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
  // 窓の中で許す回数
  private readonly limit: number;
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

  // 上限と窓の長さを受け取る。**正の整数でなければ落とす**
  constructor(options: RateLimiterOptions) {
    // 窓が 0 以下だと記録が常に空になり、レート制限が丸ごと無効になる（fail-closed で落とす）
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new RangeError('レート制限の上限は正の整数でなければなりません');
    }
    // 窓の長さも同じ理由で縛る
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('レート制限の窓の長さは正の整数でなければなりません');
    }
    // 設定を覚える
    this.limit = options.limit;
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
   */
  check(key: string, now: number): RateLimitDecision {
    // 数えながら判定する
    return this.evaluate(key, now, true);
  }

  /**
   * 数えずに「いま通せるか」だけを返す。
   *
   * **2 つ以上の枠を同時に見る経路のために要る**（`enforceRateLimit`）。`check` を順に呼ぶと、
   * 1 つ目が通って 2 つ目が断ったときに 1 つ目だけが呼び出しを数えてしまう。断った要求を
   * 数えないのはこの制限器の約束（数えると断られ続けるあいだ窓が延びて永久に通れない）なので、
   * 「全部の枠が通ると分かってから数える」ために覗き見だけの形を用意する。
   */
  inspect(key: string, now: number): RateLimitDecision {
    // 数えずに判定する
    return this.evaluate(key, now, false);
  }

  // 判定の本体。`record` が true のときだけ今回の呼び出しを覚える
  private evaluate(key: string, now: number, record: boolean): RateLimitDecision {
    // まず期限切れの記録を間隔ごとに回収する（表が膨らみ続けないように）
    this.sweepIfDue(now);
    // 窓の開始時刻（これ以前の記録は数えない）
    const windowStart = now - this.windowMs;
    // そのキーの記録のうち窓の中に残っているもの
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);
    // 上限に達していれば通さない
    if (recent.length >= this.limit) {
      // 窓から最も古い記録が外れるまでの時間（それより前に試しても必ず断られる）
      const oldest = recent[0] ?? now;
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
      // 中継は API キー単位で数える（同じエージェントに複数のキーを発行できる）
      return `apiKey:${principal.apiKeyId}`;
    case 'user':
      // ユーザー向け API はユーザー単位
      return `user:${principal.user.id}`;
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
 * 環境変数があればその上限を、無ければ既定（`PROXY_RATE_LIMIT_PER_MINUTE`）を返す。
 *
 * **ベンチが上書きする**（`scripts/bench-proxy.ts`）: 1 接続で毎秒数百件を出すので既定の
 * 上限では 9 割近くが 429 になり、測れるのは「中継の追加遅延」ではなく「429 を返す速さ」に
 * なる（実測で 3516 件のうち 3116 件が 429 になり、ベンチの「2xx 以外があれば失敗」の
 * 門番が正しく落とした）。
 *
 * **読めない値は既定へ倒す（fail-closed）。** 設定ミスで制限が消えるより、効いている方が安全。
 * 逆に「とても大きい値」を入れれば実質的に制限を外せるが、環境変数は運用者が意図して置く
 * 信頼値なので、それはその配備先の判断として受け入れる。
 */
export function configuredRateLimit(env: NodeJS.ProcessEnv = process.env): number {
  // 環境変数を読み、前後の空白を落とす
  const raw = env[PROXY_RATE_LIMIT_ENV]?.trim();
  // 未設定・空は既定
  if (raw === undefined || raw === '') return PROXY_RATE_LIMIT_PER_MINUTE;
  // 数値として読む（`Number` は空文字を 0 にするので、空の判定を先に済ませてある）
  const parsed = Number(raw);
  // 正の整数でなければ既定へ倒す（0 や負の値を通すと制限が丸ごと無効になる）
  if (!Number.isInteger(parsed) || parsed <= 0) return PROXY_RATE_LIMIT_PER_MINUTE;
  // 設定された上限
  return parsed;
}

// ── プロセス共有の制限器 ──────────────────────────────
// **1 つのインスタンスをすべてのルートで共有する。** ルートごとに持つと、同じ API キーが
// 別のルートを交互に叩くだけで合計が上限の 2 倍まで通る（枠は「送信元ごと」で、
// 「送信元とルートの組ごと」ではない）
let shared = new SlidingWindowRateLimiter({
  limit: configuredRateLimit(),
  windowMs: RATE_LIMIT_WINDOW_MS,
});

// **重い経路だけが追加で消費する枠.** 上の枠と置き換えるのではなく両方を消費する
// （置き換えだと重い経路と中継を交互に叩くだけで合計が上の上限を超える。理由は
//  `HEAVY_ROUTE_RATE_LIMIT_PER_MINUTE` のコメント）
let heavy = new SlidingWindowRateLimiter({
  limit: HEAVY_ROUTE_RATE_LIMIT_PER_MINUTE,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

/**
 * そのルートに掛ける枠の種類。
 *
 * - `standard`: 上流へ 1 回ぶんの費用を出す経路（中継 2 本）。共有の枠だけを消費する
 * - `heavy`: 1 要求で何十回も外へ出る、または応答前に外部の往復を待つ経路。
 *   共有の枠**と**小さい枠の両方を消費する
 */
export const RATE_LIMIT_TIER = {
  standard: 'standard',
  heavy: 'heavy',
} as const;

/** 枠の種類（`RouteOptions.rateLimit` に書く値） */
export type RateLimitTier = (typeof RATE_LIMIT_TIER)[keyof typeof RATE_LIMIT_TIER];

/** プロセス共有の制限器を返す（テストが表の状態を覗くのに使う） */
export function sharedRateLimiter(): SlidingWindowRateLimiter {
  // 共有インスタンス
  return shared;
}

/** 重い経路用の制限器を返す（テストが表の状態を覗くのに使う） */
export function heavyRateLimiter(): SlidingWindowRateLimiter {
  // 重い経路用のインスタンス
  return heavy;
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
  // 見るべき枠（重い経路は共有の枠も消費する）
  const limiters = tier === RATE_LIMIT_TIER.heavy ? [shared, heavy] : [shared];
  // まず全部を覗き見して、断るものがあるか調べる
  const denials = limiters
    .map((limiter) => limiter.inspect(key, now))
    .filter((decision) => !decision.allowed);
  // 1 つでも断るなら、待ち時間の長いほうで 429 にする（どの枠も数えない）
  if (denials.length > 0) {
    throw rateLimitedError(Math.max(...denials.map((decision) => decision.retryAfterSeconds)));
  }
  // 全部通るので、ここで初めて数える
  for (const limiter of limiters) limiter.check(key, now);
}

/**
 * テスト専用: 共有の制限器を作り直す。本番では呼べない（fail-closed）。
 *
 * 表はプロセスの寿命いっぱい残るので、これが無いとテストの実行順によって
 * 「前のテストが使った枠」が次のテストへ漏れる（`setReposForTesting` と同じ扱い）。
 */
export function resetSharedRateLimiterForTesting(
  options?: RateLimiterOptions,
  heavyOptions?: RateLimiterOptions,
): void {
  // 本番で作り直せると、呼ぶだけで全員の枠が空になる
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSharedRateLimiterForTesting は本番では使えません。');
  }
  // 指定が無ければ既定の設定で作り直す
  shared = new SlidingWindowRateLimiter(
    options ?? { limit: configuredRateLimit(), windowMs: RATE_LIMIT_WINDOW_MS },
  );
  // **重い経路の枠も必ず作り直す** — 片方だけ空にすると、前のテストが使った枠が
  // 次のテストへ漏れる（しかも漏れるのは小さいほうの枠なので、無関係なテストが 429 で落ちる）。
  // 指定が無ければ既定（`HEAVY_ROUTE_RATE_LIMIT_PER_MINUTE`）で作る
  heavy = new SlidingWindowRateLimiter(
    heavyOptions ?? { limit: HEAVY_ROUTE_RATE_LIMIT_PER_MINUTE, windowMs: RATE_LIMIT_WINDOW_MS },
  );
}
