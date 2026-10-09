// 捕まえたログ 1 行を読むための共通ヘルパー。
//
// ログの出口（`src/lib/log.ts`）は **1 行 1 JSON の文字列を 1 引数だけ**渡すので、
// 捕まえた側は「文字列を解析する」か「生のまま部分一致で見る」かのどちらかになる。
// どちらも複数のテストが必要とするので、読み方をここ 1 か所に置く
// （書き写すと、行の形を変えたときに片方だけが直る）。
import { expect, vi } from 'vitest';

/** ログ 1 行の中身（`src/lib/log.ts` の `formatLogLine` が作る形） */
export interface LoggedLine {
  // ISO 8601 の時刻
  ts: string;
  // 深刻度
  level: string;
  // 出来事の識別子（**警報の条件に使うのはこれ**。文言は推敲で変わる）
  event: string;
  // 人間向けの説明
  message: string;
  // `describeError` が作った診断（無い出来事もある）
  error?: Record<string, unknown>;
}

/**
 * ログへ渡された実引数を「中身が見える形」で 1 本の文字列にする。
 *
 * **`JSON.stringify` だけで畳まない** — `Error` は `{}` になるので、例外そのものを引数へ足す
 * 変更（message ごと出る）が素通りし、PII をログへ出さないための選別が丸ごと無意味になる
 * （しかも全件緑のまま通る）。文字列はそのまま使う（二重に逃がすと部分一致の検査が壊れる）。
 * @param args `console.error` に渡された実引数
 * @returns 連結した文字列
 */
export function renderLoggedLine(args: readonly unknown[] | undefined): string {
  // 1 件も無ければ空文字（呼び出し側の `toContain` が素直に落ちる）
  if (args === undefined) return '';
  // 引数を 1 つずつ文字列にする
  return args
    .map((arg) => {
      // 例外は種類・message・スタックまで開く（素で渡す変更を見逃さない）
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
      // 文字列はそのまま（出口が渡すのはこれ）
      if (typeof arg === 'string') return arg;
      // それ以外は JSON へ
      return JSON.stringify(arg);
    })
    .join(' ');
}

/**
 * ログ 1 行を解析する。
 *
 * **形が違えば落とす** — 出口は必ず「1 引数・JSON の文字列」なので、引数が増えた・文字列でない・
 * JSON として読めないのはいずれも結線が変わった印。黙って通すと、呼び出し側の照合が
 * 「何も見ていない」状態へ静かに移る。
 * @param args `console.error` に渡された実引数
 * @returns 解析した行
 */
export function parseLoggedLine(args: readonly unknown[] | undefined): LoggedLine {
  // 実引数はちょうど 1 つ
  expect(args, 'ログ 1 行の実引数が無い').toBeDefined();
  expect(args, 'ログの出口は 1 引数だけを渡す').toHaveLength(1);
  // その 1 つは文字列
  const [first] = args ?? [];
  expect(typeof first, 'ログの出口は JSON の文字列を渡す').toBe('string');
  // JSON として読む
  return JSON.parse(String(first)) as LoggedLine;
}

/**
 * 捕まえたすべての行から出来事の識別子だけを取り出す。
 * 「何行出たか」「どの種類が出たか」を見るテストが使う（文言ではなく識別子で照合する）。
 * @param calls `console.error` の呼び出し履歴
 * @returns 出来事の識別子の列（出た順）
 */
export function loggedEvents(calls: readonly (readonly unknown[])[]): string[] {
  // 行ごとに解析して識別子を拾う
  return calls.map((args) => parseLoggedLine(args).event);
}

/**
 * ログの出口（`console.warn` / `console.error` の両方）を捕まえる。
 *
 * **出口のメソッドは深刻度で分かれる**（`src/lib/log.ts` の `logEvent` が `level === 'warn'`
 * なら `console.warn`、それ以外は `console.error`）。配備先のログ基盤が `console` の
 * メソッドで深刻度を付けるためで、**行の形は変わらない**（1 行 1 JSON）。
 *
 * テスト側が「この出来事はどちらのメソッドか」を知る必要は無い（深刻度の正本は `LOG_EVENTS`
 * なので、知る形にすると語彙の `level` を変えた瞬間にテストが無言で何も見なくなる）。
 * だから両方を捕まえて、**出た順**に 1 本の履歴として返す。
 * @returns `calls()` で履歴を読み、`restore()` で元へ戻す
 */
export function captureLogOutlet(): {
  calls: () => readonly (readonly unknown[])[];
  restore: () => void;
} {
  // 出た順を保つために 1 本の配列へ集める
  const collected: unknown[][] = [];
  // `warn` と `error` の両方を同じ配列へ向ける
  const spies = (['warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      collected.push(args);
    }),
  );
  // 読み口と後始末を返す
  return {
    calls: () => collected,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
