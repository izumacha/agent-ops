// Chromium の実行ファイルの差し替え（Step5）。
//
// **E2E と Lighthouse が同じ 1 か所を読む。** ブラウザをダウンロードできない環境
// （社内プロキシ・この種のコンテナ）では既存の Chromium を指す必要があり、片方だけが
// 逃げ道を持つと「E2E は動くのに Lighthouse だけ動かない」状態になる。

// 実行ファイルのパスを入れる環境変数の名前（ここが唯一の参照元。README と §2 はこの名前を指す）
export const CHROMIUM_PATH_ENV = 'PLAYWRIGHT_CHROMIUM_PATH';

/** 指定があればそのパス、無ければ undefined（Playwright / Lighthouse の既定に任せる）。 */
export function chromiumExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // 前後の空白を落として読む（貼り付けの改行で見つからなくなるのを防ぐ）
  const configured = env[CHROMIUM_PATH_ENV]?.trim();
  // 空文字は未設定と同じ扱い
  return configured === undefined || configured === '' ? undefined : configured;
}
