// トップページ。ログイン状態に応じてダッシュボードかログイン画面へ送る (Step5)。
//
// **案内文を置かない。** 以前は「Step1 まで実装済み」と書いていたが、画面ができた以上
// トップで止まる理由が無く、文言は実装が進むたびに古くなる (コードとドキュメントの乖離)。
import { redirect } from 'next/navigation';
import { DASHBOARD_PATH, LOGIN_PATH } from '@/lib/constants';
import { currentSession } from '@/lib/session-server';

export default async function HomePage(): Promise<never> {
  // ログイン済みならダッシュボード、未ログインならログイン画面へ送る
  redirect((await currentSession()) === null ? LOGIN_PATH : DASHBOARD_PATH);
}
