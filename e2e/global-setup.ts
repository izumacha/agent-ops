// E2E の仕込みとアプリの起動（Step5）。**戻り値が後始末**（Playwright が最後に呼ぶ）。
//
// 順序が要点: 専用 DB を空にして行を仕込む → 本番ビルドを起動する → その URL を書き出す。
// 逆にすると、アプリが前の実行のデータを掴んだまま起動する。
import { startApp, stopApp, freePort } from './lib/app';
import { seedE2eFixture, writeE2eFixture } from './lib/fixture';

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 専用 DB を空にして、画面を開くのに必要な行を仕込む（開発 DB なら 1 行も書かずに落ちる）
  const seed = await seedE2eFixture();
  // 空いているポートを取る（固定だと CI で衝突する）
  const port = await freePort();
  // 本番ビルドを起動して、health が通るまで待つ
  const app = await startApp(port);
  // テストのワーカーと Lighthouse が読む受け渡しファイルを書く
  writeE2eFixture({ ...seed, baseUrl: `http://127.0.0.1:${port}` });
  // 後始末（Playwright がスイートの最後に呼ぶ）
  return async () => {
    // 起動したアプリを止める（§8 リソースを確実に解放する）
    stopApp(app);
  };
}
