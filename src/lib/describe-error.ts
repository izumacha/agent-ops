// エラーをログへ落とすときの形を決める唯一の場所。
// **`src/lib/api/` ではなく `src/lib/` 直下に置く** — ストリームの読み取り (`stream-bytes.ts`) や
// プロキシの記録経路もここを通す必要があり、Route Handler の機構ごと引き込みたくないため
// V8 のスタックフレームの形 (末尾が「:行:列)」「:行:列」「<anonymous>)」「native)」のいずれか)
const STACK_FRAME_PATTERN = /^at .*(?::\d+:\d+\)?|<anonymous>\)?|native\)?)$/;

// 内部エラーのログに残す形: 種類 (name / code) と発生箇所 (スタックフレーム) だけで、message は含めない。
// **エラーをログへ落とす経路はすべてここを通す** (route() を通らない /health も含む)。
// 経路ごとに書き方が分かれると、片方だけが message を素で出して PII / 接続文字列を漏らす。
// ORM の検証エラーなどは message にクエリ引数 (= メールアドレス・名前といった利用者の入力) をそのまま埋め込むため、
// message ごと出すと PII がログに流れる (§9 ログに残す前に個人情報をマスクする)
export function describeError(error: unknown): Record<string, unknown> {
  // Error でなければ型だけ
  if (!(error instanceof Error)) return { type: typeof error };
  // V8 の stack は「name: message」の見出しの後にフレームが続く。見出しは構築時の name / message で固定されるので、
  // まず見出しを長さで切り落とし (message が何行あっても構造で外せる)、残りから V8 のフレームの形
  // (「at 関数 (ファイル:行:列)」か「at <anonymous>」) に一致する行だけを残す。「at 」で始まるかだけで選ぶと、
  // 利用者の入力 (改行を含む description 等) 由来の「at 田中 …」という行が message から紛れ込み、偽のフレームも書ける
  const stack = error.stack ?? '';
  // code は Node のシステムエラー (ECONNREFUSED 等) や ORM のエラー番号が入る
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  // 見出しの形の候補。Node は `TypeError [ERR_INVALID_ARG_TYPE]: …` のように code を挟むことがあり、
  // message が空なら name だけになる
  const headers = [
    `${error.name}: ${error.message}`,
    typeof code === 'string' ? `${error.name} [${code}]: ${error.message}` : null,
    error.name,
  ].filter((candidate): candidate is string => candidate !== null);
  // 実際の stack がどの見出しで始まるか
  const header = headers.find((candidate) => stack.startsWith(candidate));
  // どれとも一致しなければ message の範囲を確定できないので、フレームは 1 行も出さない (fail-closed。
  // 「at …」の形だけで選ぶと、改行を含む利用者の入力由来の行がフレームとして紛れ込む)
  const frames =
    header === undefined
      ? []
      : stack
          .slice(header.length)
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => STACK_FRAME_PATTERN.test(line));
  // 見出しを読めなかったことは残す (フレームが空の理由が分かるように)
  return header === undefined
    ? { name: error.name, code, frames, stackUnparsed: true }
    : { name: error.name, code, frames };
}
