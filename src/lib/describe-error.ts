// エラーをログへ落とすときの形を決める唯一の場所。
// **`src/lib/api/` ではなく `src/lib/` 直下に置く** — ストリームの読み取り (`stream-bytes.ts`) や
// プロキシの記録経路もここを通す必要があり、Route Handler の機構ごと引き込みたくないため
// V8 のスタックフレームの形 (末尾が「:行:列)」「:行:列」「<anonymous>)」「native)」のいずれか)
const STACK_FRAME_PATTERN = /^at .*(?::\d+:\d+\)?|<anonymous>\)?|native\)?)$/;

// ラベル (name / code) に許す綴り。実在の値は `ECONNREFUSED` / `P2002` / `28P01` /
// `ERR_INVALID_ARG_TYPE` / `PrismaClientKnownRequestError` (29 文字) / Bedrock の
// `ProvisionedThroughputExceededException` (38 文字) のような短い識別子で、
// 空白も区切り記号も持たない。**上限は実在の最長 (38) から導く**（＋2 の余裕は、同じ体系の
// 名前が少し伸びても診断が消えないようにするため）— 根拠の無い 64 にしていた版は、区切り
// 記号を持たない秘密をそのまま載せた (実測: このリポジトリの API キーの形 `aop_k_` + 40 文字
// = 46 文字と、英数字 64 文字のトークンがいずれも素通し。どちらも 40 上限では型だけになる)。
// **残る境界**: 40 文字以下で区切り記号を持たない秘密（外部サービスの鍵には 32 文字程度の
// ものがある）は、実在の例外名と**形でも長さでも区別できない**ので通る。
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
  // **ログ整形器は絶対に throw しない。** `'cause' in error` はゲッターを起こさないが、
  // 続くプロパティの読み出しは起こす。throw するゲッターを持つ値が来ると整形器自身が
  // 例外を投げ、到達先ごとに壊れ方が違う: `route()` の catch の中なら統一された 500 応答を
  // すり抜けてフレームワークへ抜け、`onPoolError` の中なら uncaught でプロセスが落ち、
  // 上流の失敗の経路なら 502/504 が 500 に化けて UsageEvent の statusCode も 500 で記録される。
  // `cause` を 1 段たどるようにしてゲッターの読み出しが 2 → 5 か所へ増えたので、包んで止める
  try {
    return describeErrorOrThrow(error);
  } catch {
    // **値は 1 バイトも出さない** — ここへ来るのは「読むと投げる」値なので、
    // 読めなかったことだけを残す (§9 fail-closed)
    return { type: typeof error, undescribable: true };
  }
}

/** `describeError` の本体（読み出しで投げうるので、必ず上の包みを通して呼ぶ）。 */
function describeErrorOrThrow(error: unknown): Record<string, unknown> {
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
  // 実際の stack がどの見出しで始まるか。**見出しの直後が改行（か文末）であることまで求める** —
  // V8 は `error.stack` を初回アクセスで文字列に固定するので、その後に `message` を差し替えると
  // `name: message` の候補が外れ、素の `name` が前方一致して見出しに採用される。すると残りは
  // `": <元の message>\n…"` になり、message の中にフレームの形の行があればそれが frames に載る
  // （実測で、元の message 由来の行が 1 行出た）。改行で始まることを求めればこの形は落ち、
  // message が空の `Error\n    at …` は通る
  const header = headers.find((candidate) => {
    // 前方一致していなければ違う
    if (!stack.startsWith(candidate)) return false;
    // 見出しの直後の 1 文字（文末なら undefined）
    const next = stack[candidate.length];
    return next === undefined || next === '\n';
  });
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
  // **`cause` は 1 段だけ、同じ規則で name / code を載せる** — undici の `fetch` は
  // 接続不能も証明書エラーも `TypeError: fetch failed` で包むので、辿らないと実際の理由
  // (`ECONNREFUSED` / `ENOTFOUND` など) が消える。message は載せないので規則は緩まない
  const rawCause = 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  const cause =
    rawCause instanceof Error
      ? {
          name: describeShortLabel(rawCause.name),
          code: describeShortLabel(
            'code' in rawCause ? (rawCause as { code?: unknown }).code : undefined,
          ),
        }
      : undefined;
  // 見出しを読めなかったことは残す (フレームが空の理由が分かるように)
  return header === undefined
    ? { name, code, cause, frames, stackUnparsed: true }
    : { name, code, cause, frames };
}
