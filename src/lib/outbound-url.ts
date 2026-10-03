// サーバから外へ出る接続先 URL の「受け付けてよい形」の規則の唯一の定義。
//
// 上流 LLM の接続先 (src/lib/proxy/upstream.ts) と通知の宛先 (src/lib/notify/send.ts) が
// 同じ規則を共有する (§6 DRY。2 箇所目になったので切り出した)。片方にしか規則が無いと、
// 「平文の http で別ホストへ送る」設定ミスがもう片方の経路だけ通ってしまう。
//
// **どちらの経路も宛先は環境変数とコードだけから決まる** (テナントや利用者からは受け取らない)。
// 利用者が入れた URL へサーバが要求を出す形にすると SSRF の入口になるので、Step4 では
// その形を作らない方針を採っている (ADR-0007 と同じ流儀。ADR-0010 に宿題として記録)。
// したがってここで防いでいるのは**攻撃ではなく設定ミス**で、プライベート IP の遮断までは行わない
// (行う必要が出るのはテナントごとの宛先管理を入れるときで、そこが入口になる)。

// ループバック (自分自身) を指すホスト名。**非本番でだけ** http を許す相手
// (ローカルに立てたスタブ上流・スタブ通知先へ繋ぐため)
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** 受け付けなかった理由。呼び出し側が自分の HTTP エラー・ログへ写す */
export const OutboundUrlRejection = {
  // URL として読めなかった
  unparsable: 'unparsable',
  // 資格情報付き URL (user:pass@host)。ログや Referer に漏れる形なので受け付けない
  credentials_in_url: 'credentials_in_url',
  // https でなく、非本番のループバック http でもない
  insecure_scheme: 'insecure_scheme',
} as const;
// OutboundUrlRejection の値の型
export type OutboundUrlRejection = (typeof OutboundUrlRejection)[keyof typeof OutboundUrlRejection];

/**
 * 文字列を外向きの接続先として読む。受け付けられなければ理由を返す。
 *
 * **クエリ・フラグメントの可否はここで決めない。** 上流の基底 URL は後ろにパスを足すので
 * クエリ付きを拒否する必要があるが、通知の宛先はそのまま POST するだけなので
 * クエリ付き (受け手のトークンを載せた形) が普通に要る。経路ごとの事情なので呼び出し側が足す。
 */
export function parseOutboundUrl(
  candidate: string,
  env: NodeJS.ProcessEnv,
): { ok: true; url: URL } | { ok: false; reason: OutboundUrlRejection } {
  // URL として読めること
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    // 読めない値は設定ミス
    return { ok: false, reason: OutboundUrlRejection.unparsable };
  }
  // 資格情報付き URL は拒否する (ログや Referer に漏れる形)
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: OutboundUrlRejection.credentials_in_url };
  }
  // https ならそのまま使える
  if (url.protocol === 'https:') return { ok: true, url };
  // http はローカルのスタブに限る。本番では平文の送信を許さない (署名鍵も本文も素で流れる)
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`);
  // 非本番のループバック http だけを通す
  if (url.protocol === 'http:' && loopback && env.NODE_ENV !== 'production') {
    return { ok: true, url };
  }
  // それ以外は拒否 (fail-closed)
  return { ok: false, reason: OutboundUrlRejection.insecure_scheme };
}
