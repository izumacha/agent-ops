// エラーをログへ落とすときの形を決める唯一の場所。
// **`src/lib/api/` ではなく `src/lib/` 直下に置く** — ストリームの読み取り (`stream-bytes.ts`) や
// プロキシの記録経路もここを通す必要があり、Route Handler の機構ごと引き込みたくないため
// V8 のスタックフレームの形 (末尾が「:行:列)」「:行:列」「<anonymous>)」「native)」のいずれか)
const STACK_FRAME_PATTERN = /^at .*(?::\d+:\d+\)?|<anonymous>\)?|native\)?)$/;

// ラベル (name / code) に許す綴り。実在の値は `ECONNREFUSED` / `P2002` / `28P01` /
// `ERR_INVALID_ARG_TYPE` / `PrismaClientKnownRequestError` (29 文字) / Bedrock の
// `ProvisionedThroughputExceededException` (38 文字) のような短い識別子で、
// 空白も区切り記号も持たない。**上限は実在の最長 (38) から導く** — 根拠の無い 64 にしていた
// 版は、区切り記号を持たない秘密をそのまま載せた (実測: このリポジトリの API キーの形
// `aop_k_` + 40 文字 = 46 文字、`sk_live_…` 32 文字、英数字 64 文字のトークンがいずれも素通し)。
// **先頭に数字を許す** — PostgreSQL の SQLSTATE は `28P01` (パスワード不正) /
// `23505` (一意制約違反) / `42P01` (テーブルが無い) のように数字で始まり、
// 英字始まりに絞っていた版ではこれらの診断が丸ごと消えた (実測)。
// 絞りすぎて診断が消えるのは、このリポジトリが繰り返し避けている失敗
const SHORT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{0,39}$/;

/**
 * name / code を「短い識別子」としてだけ載せる。
 * 文字列でない・長すぎる・区切りを含む値は**中身を出さず型だけ**返す (§9 fail-closed)。
 * @param value 載せたい値
 * @returns 載せてよい文字列、型だけの記述、または undefined (値が無い)
 */
function describeShortLabel(value: unknown): string | { type: string } | undefined {
  // 値が無ければ載せない
  if (value === undefined) return undefined;
  // 文字列でなければ型だけ
  if (typeof value !== 'string') return { type: typeof value };
  // 綴りに収まるものだけそのまま載せる
  return SHORT_LABEL_PATTERN.test(value) ? value : { type: 'string' };
}

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
  // code は Node のシステムエラー (ECONNREFUSED 等) や ORM のエラー番号が入る。
  // **形を絞ってから載せる** — 素通しにすると、code へ構造化された診断を入れるドライバに
  // 差し替わった時点で黙って広がる (実測で `code` に接続文字列やクエリを入れた Error は
  // そのままログへ出た)。短い識別子として読める文字列だけを載せ、それ以外は型だけ残す
  const rawCode = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const code = describeShortLabel(rawCode);
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
  // name も同じ規則で絞る (`error.name` は書き換えられるので、長い自由記述を入れられる)。
  // `error.name` は必ず文字列なので `describeShortLabel` は undefined を返さない
  const name = describeShortLabel(error.name);
  // 見出しを読めなかったことは残す (フレームが空の理由が分かるように)
  return header === undefined
    ? { name, code, frames, stackUnparsed: true }
    : { name, code, frames };
}
