// 本番の実行経路そのものを見張る検査。
//   (1) Route Handler が必ず route() を通ること — 通らない export は認証も認可もキャッシュ制御も無いまま公開される
//   (2) トークンの乱数が暗号学的乱数であること・秘密の比較が定数時間であること
// どちらも「壊しても全テストが緑」だった穴を塞ぐ。実挙動の検査では捕まらない (壊れた実装でも
// 単体では筋の通った値を返してしまう) ので、ソースの形として固定する
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Route Handler が置かれる場所 (OpenAPI の servers.url と対応)
const ROUTES_DIR = join(process.cwd(), 'src', 'app', 'api', 'v1');
// HTTP メソッドとして export される名前
const HTTP_METHOD_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
// route() を包んで返してよい工場 (工場自身が route() を使っていることは下のテストが確かめる)
const ALLOWED_FACTORIES = ['route', 'setAgentStatusRoute'] as const;
// 認証を通さないことが正しい経路 (理由付きの唯一の除外)
const UNAUTHENTICATED_ROUTES: Record<string, string> = {
  'health/route.ts': 'DB 到達性だけを返す公開エンドポイント (compose の healthcheck が使う)',
};

// ディレクトリを再帰して route.ts を集める
function findRouteFiles(dir: string): string[] {
  // 直下の要素
  return readdirSync(dir).flatMap((entry) => {
    // 絶対パス
    const full = join(dir, entry);
    // ディレクトリなら潜る
    if (statSync(full).isDirectory()) return findRouteFiles(full);
    // route.ts だけを拾う
    return entry === 'route.ts' ? [full] : [];
  });
}

// 集めた Route Handler のファイル (パスは v1 からの相対で表す)
const routeFiles = findRouteFiles(ROUTES_DIR).map((full) => ({
  relative: full
    .slice(ROUTES_DIR.length + 1)
    .split('\\')
    .join('/'),
  source: readFileSync(full, 'utf8'),
}));

describe('Route Handler の結線', () => {
  // 走査が壊れて 0 件になったら落とす (fail-closed)
  it('Route Handler を 1 つ以上見つけている', () => {
    // 見つけた数
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  // 認証・認可・キャッシュ制御は route() が 1 か所で行う。素の export はその全部を素通りする
  it('HTTP メソッドの export はすべて route() 由来である', () => {
    // 許す工場名をまとめた正規表現の断片
    const factories = ALLOWED_FACTORIES.join('|');
    for (const { relative, source } of routeFiles) {
      // 公開エンドポイントは対象外 (理由は表に書く)
      if (relative in UNAUTHENTICATED_ROUTES) continue;
      for (const method of HTTP_METHOD_EXPORTS) {
        // その名前を export していなければ何もしない
        if (
          !new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source)
        ) {
          continue;
        }
        // 「export const <METHOD> = <許した工場>(」の形であること (関数宣言の export は許さない)
        const wrapped = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*(?:${factories})\\s*[<(]`);
        expect(wrapped.test(source), `${relative} の ${method} が route() を通っていない`).toBe(
          true,
        );
      }
    }
  });

  // 工場を経由する形も許しているので、工場自身が route() を使っていることを確かめる
  it('許した工場は route() を返している', () => {
    // 全ソース (工場の定義はルート直下にあるとは限らない)
    const sources = findRouteFiles(ROUTES_DIR)
      .map((full) => readFileSync(full, 'utf8'))
      .concat(
        readdirSync(join(process.cwd(), 'src', 'app', 'api', 'v1', 'agents', '[agentId]'))
          .filter((entry) => entry.endsWith('.ts'))
          .map((entry) =>
            readFileSync(
              join(process.cwd(), 'src', 'app', 'api', 'v1', 'agents', '[agentId]', entry),
              'utf8',
            ),
          ),
      );
    for (const factory of ALLOWED_FACTORIES) {
      // route 自身は検査対象外 (これが本体)
      if (factory === 'route') continue;
      // その工場を定義しているソース
      const definition = sources.find((source) =>
        new RegExp(`export\\s+function\\s+${factory}\\b`).test(source),
      );
      // 定義が見つかること
      expect(definition, `${factory} の定義が見つからない`).toBeDefined();
      // 定義の中で route() を返していること
      expect(
        definition && /return route\s*[<(]/.test(definition),
        `${factory} が route() を返していない`,
      ).toBe(true);
    }
  });
});

describe('秘密の生成と比較', () => {
  // トークン生成のソース
  const tokens = readFileSync(join(process.cwd(), 'src', 'lib', 'tokens.ts'), 'utf8');

  // 予測可能な乱数になると、発行済みの全トークン・API キーが推測できる (乗っ取りに直結)
  it('トークンの乱数は node:crypto の randomBytes から取る', () => {
    // node:crypto から randomBytes を読んでいること
    expect(/import\s+\{[^}]*\brandomBytes\b[^}]*\}\s+from\s+'node:crypto'/.test(tokens)).toBe(true);
    // 乱数の作成に使っていること
    expect(/randomBytes\(/.test(tokens)).toBe(true);
    // 擬似乱数を混ぜていないこと
    expect(/Math\.random/.test(tokens)).toBe(false);
  });

  // 早期終了の比較に戻すと、前方一致の長さが応答時間から漏れる (多層防御が黙って剥がれる)
  it('秘密の比較は定数時間で行う', () => {
    // node:crypto から timingSafeEqual を読んでいること
    expect(/import\s+\{[^}]*\btimingSafeEqual\b[^}]*\}\s+from\s+'node:crypto'/.test(tokens)).toBe(
      true,
    );
    // 実際に使っていること
    expect(/timingSafeEqual\(/.test(tokens)).toBe(true);
  });
});
