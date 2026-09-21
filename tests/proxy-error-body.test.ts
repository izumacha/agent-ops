// 上流のエラー本文の絞り込み (src/lib/proxy/error-body.ts)。
// ここが緩むと、上流アカウントの残高・組織名・契約ティアが有効な API キーを持つ全テナントへ漏れる
import { describe, expect, it } from 'vitest';
// 契約 (OpenAPI) から総当たりの対象を導くため
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { sanitizeUpstreamErrorBody } from '@/lib/proxy/error-body';
import { API_MESSAGES } from '@/lib/constants';

describe('上流のエラー本文の絞り込み', () => {
  it('機械可読な項目だけを残し、自由記述は定型文へ差し替える', () => {
    // OpenAI 形式のエラー本文 (message に組織名が載る実例)
    const safe = sanitizeUpstreamErrorBody({
      error: {
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
        message: 'your organization acme-corp does not have access to it',
      },
    });
    // 識別子は残る
    expect(safe).toEqual({
      error: {
        message: API_MESSAGES.upstreamRejected,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model',
      },
    });
  });

  // 上流が返しうる項目名 (表を広げる差分がここに当たる)。
  // **これは「表に載った項目がどう配線されるか」を見る挙動の検査**で、表そのものを固定するのは
  // `tests/openapi.test.ts` の「中継するエラー本文の項目は契約と一致する」のほう
  // (手書きの候補リストは、載せ忘れた名前のぶんだけ黙って狭くなる。実測で `subcode` /
  // `hint` / `quota_type` を表へ足す変異がここでは素通りした)
  const CANDIDATE_FIELDS = [
    'type',
    'code',
    'param',
    'message',
    'detail',
    'details',
    'reason',
    'status',
    'statusCode',
    'organization',
    'org',
    'account',
    'plan',
    'tier',
    'balance',
    'quota',
    'limit',
    'usage',
    'request_id',
    'requestId',
    'doc_url',
    'inner_error',
    'innererror',
    'error_subcode',
    'metadata',
  ];
  // 契約で中継する項目 (これ以外は落ちる)。**手書きの写しにしない** —
  // 実装と契約を同時に広げる差分が、写しを直し忘れたときにだけ赤くなる形になって信用できない。
  // `message` は上流から読まずこちらが書く項目なので、中継される側には数えない
  const relayedFields = (): string[] =>
    Object.keys(relayedErrorSchema ?? {}).filter((field) => !SELF_WRITTEN_FIELDS.includes(field));

  it.each(CANDIDATE_FIELDS)('返すのは契約の項目だけ (%s)', (field) => {
    // 綴りの検査は通る値にする。空白入りの値だと「表に無いから落ちた」のか
    // 「綴りで落ちた」のかを区別できず、表を広げる変異を捕まえられない
    const value = 'org_ACME_tier_enterprise';
    // その項目だけを載せた上流の本文を通す
    const safe = sanitizeUpstreamErrorBody({ error: { [field]: value } }) as {
      error: Record<string, unknown>;
    };
    // 応答の最上位は error だけ (上流の項目が最上位へ増えていないこと)
    expect(Object.keys(safe).sort(), '最上位').toEqual(['error']);
    // error の中身は「定型文」＋「契約で残す項目のうち今回載せたもの」だけ
    const expectedKeys = relayedFields().includes(field) ? ['message', field].sort() : ['message'];
    expect(Object.keys(safe.error).sort(), 'error の項目').toEqual(expectedKeys);
    // message は必ず自前の定型文 (上流の自由記述で上書きされない)
    expect(safe.error.message, 'message').toBe(API_MESSAGES.upstreamRejected);
  });

  it('許可リストに無い項目は落とす (上流の識別子や入れ子も含む)', () => {
    // request_id や独自の項目、入れ子のオブジェクトは残さない
    const safe = sanitizeUpstreamErrorBody({
      type: 'error',
      request_id: 'req_011CQabcdef',
      error: {
        type: 'invalid_request_error',
        billing: { balance_usd: 0.12, organization: 'acme-corp' },
        // **綴りを通る値にする。** 空白入りの値だと「表に無いから落ちた」のか
        // 「綴りで落ちた」のかを区別できず、表を広げる変異に対して空振りする (実測)
        detail: 'credit_balance_too_low',
      },
    });
    // 最上位の type と error.type だけが残る
    expect(safe).toEqual({
      type: 'error',
      error: { message: API_MESSAGES.upstreamRejected, type: 'invalid_request_error' },
    });
    // 落とした値がどこにも残っていない
    expect(JSON.stringify(safe)).not.toContain('acme-corp');
    expect(JSON.stringify(safe)).not.toContain('req_011CQabcdef');
  });

  it.each([
    ['空白入りの散文 (code)', { code: 'quota for org-ACME exhausted; plan=Enterprise' }],
    [
      '空白入りの散文 (param)',
      { param: 'organization ACME Corp (tier: enterprise) has no access' },
    ],
    ['長すぎる識別子', { code: 'x'.repeat(65) }],
    ['制御文字を含む値', { code: 'a\r\nX-Injected: 1\u0000b' }],
    ['孤立サロゲート', { code: '\ud800' }],
  ])('識別子の綴りに収まらない値は通さない: %s', (_label, error) => {
    // 長さだけを見ていたときは 100 文字以内の散文が素通しした (実測)
    const safe = sanitizeUpstreamErrorBody({ error });
    // 定型文だけが残る
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  it.each([
    ['ドットとハイフンで繋いだ文 (code)', { code: 'billing.org-ACME_Corp.tier-enterprise' }],
    ['ハイフン区切りの文 (type)', { type: 'org-ACME.tier-enterprise.balance-0' }],
    [
      '長い語を繋いだ文 (param)',
      { param: 'credit_balance_too_low.add_funds_at_Plans_and_Billing' },
    ],
    ['キーの断片', { code: 'sk-proj-AbCdEf0123456789_XYZ.truncated_key_prefix' }],
    ['5 語以上の snake_case', { code: 'organization_ACME_tier_enterprise_has_no_access' }],
  ])('区切り文字で書いた文も通さない: %s', (_label, error) => {
    // **空白が無いだけでは足りない** — 空白は `_` や `.` で置き換えられる。
    // 1 本の正規表現に `.` と `-` をまとめて許していたときは、これらが全部素通りした (実測)
    const safe = sanitizeUpstreamErrorBody({ error });
    // 定型文だけが残る
    expect(safe).toEqual({ error: { message: API_MESSAGES.upstreamRejected } });
  });

  // **同じ綴り (SAFE_CODE_PATTERN) を使う出力位置をすべて総当たりする。**
  // 項目を 1 つ選んで検査すると、別の箇所だけを差し替える変異が素通りする (実測で全件緑だった)。
  //
  // **一覧は手で書かず契約から導く。** 手書きの表にしていたときは、エントリを 1 行消すだけで
  // その位置の検査 14 件が黙って消え、痕跡は件数の減少だけだった。実測では、消したうえで
  // `code` の総長を 40→64 に緩めると **677 件すべて緑**のまま
  // `OrgAcmeCorpTierEnterpriseCreditBalanceZeroGoToPlansAndBilling` (61 文字) が中継された
  const relayedTopLevelSchema = (
    parse(readFileSync(join(process.cwd(), 'openapi', 'openapi.yaml'), 'utf8') as string) as {
      components?: {
        schemas?: Record<string, { properties?: Record<string, { properties?: object }> }>;
      };
    }
  ).components?.schemas?.RelayedUpstreamError?.properties;
  // error の中で中継する項目 (綴りの総当たりの対象をここから導く)
  const relayedErrorSchema = relayedTopLevelSchema?.error?.properties;
  // **除外表ではなく「分割」にする。** 除外表にしていたときは、そこへ 1 行足すだけで
  // その項目の検査 14 件が黙って消えた (実測: `type` を除外して綴りを緩めると 683 件すべて緑のまま
  // `org_ACME_Corp.tier-enterprise.credit_balance_zero.add-funds` 59 文字が中継された)。
  // 契約の項目は必ずどちらかの綴りの表に属する形にして、**和集合が契約を覆うこと**を固定する
  const PARAM_SWEEP_FIELDS = ['param'];
  // プロキシが自分で書く項目 (上流から読まないので綴りの検査の対象にならない)
  const SELF_WRITTEN_FIELDS = ['message'];
  // 分類語彙 (SAFE_CODE_PATTERN) の総当たり対象 = 契約の項目 − param の綴り − 自前の項目
  const CODE_FIELDS = Object.keys(relayedErrorSchema ?? {}).filter(
    (field) => !PARAM_SWEEP_FIELDS.includes(field) && !SELF_WRITTEN_FIELDS.includes(field),
  );

  it('綴りの総当たりは契約の項目を過不足なく覆っている', () => {
    // 1 つも残らなければ導出が壊れている (fail-closed)
    expect(CODE_FIELDS.length, '総当たりの対象が 0 件').toBeGreaterThan(0);
    // **3 つの表の和集合が契約と一致すること。** 片方へ移すことはできても、
    // どこにも属さない項目 (＝検査されない項目) は作れない
    expect(
      [...CODE_FIELDS, ...PARAM_SWEEP_FIELDS, ...SELF_WRITTEN_FIELDS].sort(),
      '契約の項目と総当たりの対象が食い違っている',
    ).toEqual(Object.keys(relayedErrorSchema ?? {}).sort());
  });

  it.each(PARAM_SWEEP_FIELDS)('%s には JSON パスの綴りが当たっている', (field) => {
    // 分類語彙の総当たりから項目を「param 側へ移す」だけで検査が消えないよう、
    // **param の綴りでしか通らない値**で確かめる (分類語彙の綴りは `.` も `[添字]` も許さないので、
    // 移した項目に分類語彙が当たっていればここで落ちる)
    const safe = sanitizeUpstreamErrorBody({ error: { [field]: 'messages[0].content' } }) as {
      error: Record<string, unknown>;
    };
    // JSON パスがそのまま通ること
    expect(safe.error[field], `${field} に param の綴りが当たっていない`).toBe(
      'messages[0].content',
    );
  });

  it.each(SELF_WRITTEN_FIELDS)('%s は上流の値を一切運ばない (自前で書く項目)', (field) => {
    // **こちらの表にも裏打ちが要る。** 無いと、分類語彙の総当たりから項目を「自前で書く側へ移す」
    // だけでその項目の検査が黙って消える (実測: `type` をこちらへ移して綴りを緩めると
    // 685 件すべて緑のまま `OrgAcmeCorpTierEnterpriseCreditBalanceZeroGoToPlansAndBilling`
    // 61 文字が中継された)。移した項目は「上流から読まない」はずなので、そこを直接確かめる
    // **綴りの検査を通る値を使う** — 落ちた理由が「綴り」だと、移された項目を捕まえられない
    const value = 'org_ACME_tier_enterprise';
    // その項目だけに値を載せて通す
    const safe = sanitizeUpstreamErrorBody(buildAt(field, value));
    // 上流の値が出口のどこにも現れないこと (別の項目名へ移し替える形もここで落ちる)
    expect(JSON.stringify(safe), `${field} が上流の値を運んでいる`).not.toContain(value);
  });

  // 出口に出てはいけない値の目印 (**綴りの検査は通る形**にして、落ちた理由を「綴り」にしない)
  const LEAK_MARKER = 'zzleak';
  // 綴りの検査を通る値 (分類語彙・JSON パスのどちらの綴りにも収まる)
  const PASSING_VALUE = 'org_ACME_tier_enterprise';

  // 契約の項目へ入れる値の周回。**1 通りでは「値で条件づけた読み取り」に入れない** —
  // 実測で `upstreamError.type === 'billing_error'` のときだけ別項目を載せる変異は、
  // 汎用の識別子だけを流していたとき 705 件すべて緑のまま中継した。
  // 実在しそうなベンダーの語彙でもう 1 周する (**それでも「どの値で条件づけたか」までは
  // 尽くせないので、値で条件づけた形は残る境界**)
  const VALUE_ROUNDS: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['汎用の識別子', {}],
    [
      'ベンダーらしい値 (課金系)',
      { type: 'billing_error', code: 'billing_hard_limit_reached', param: 'messages[0].content' },
    ],
    [
      'ベンダーらしい値 (要求不正)',
      { type: 'invalid_request_error', code: 'model_not_found', param: 'model' },
    ],
  ];

  it.each(VALUE_ROUNDS)(
    '候補を全部同時に載せても契約の項目しか出ない (存在で条件づけた読み取りも捕まえる): %s',
    (_label, vendorValues) => {
      // **1 項目ずつの総当たりでは「条件付きの読み取り」が一度も実行されない。**
      // 上の総当たりは項目を 1 つだけ載せ、tests/openapi.test.ts の観測は空の入れ物を渡すので、
      // 「ある項目が通ったときに限り別の項目も中継する」実装はどちらの経路でも走らない
      // (実測: `code` が通ったときだけ `hint` を載せる変異は **699 件すべて緑**のまま、
      // 残高・組織名・契約ティアを含む散文をそのまま中継した)。ここでは全項目に同時に値を載せ、
      // 分岐が実際に実行される状態で**出口だけ**を見る
      //
      // **入れ物は Proxy にする。** 候補の名前を手で書き並べると、そこに無い名前を読む実装が
      // 黙って外れる。名前を問わず目印つきの値を返すので、**文字列として読まれた値**が出口に
      // 出れば捕まる。入れ子へ降りる形は別の検査 (下の「入れ子の … 下からも値を運ばない」) が見る
      const relayable = new Set([...CODE_FIELDS, ...PARAM_SWEEP_FIELDS]);
      // 契約が読めていなければ照合にならない (fail-closed)
      expect(relayable.size, '中継する項目が 0 件').toBeGreaterThan(0);
      // 列挙でまとめて読む実装のために、目に見える名前も持たせる (重複は Proxy の規約違反なので潰す)
      const enumerableKeys = [...new Set([...CANDIDATE_FIELDS, ...relayable])];
      // 名前を問わず値を返す入れ物を作る
      const fieldProxy = (values: Record<string, unknown>): Record<string, unknown> =>
        new Proxy({} as Record<string, unknown>, {
          // どの名前で読まれても値を返す
          get(target, property) {
            // Symbol は言語側の問い合わせなので素通しする
            if (typeof property !== 'string') return Reflect.get(target, property);
            // 明示した項目はその値、それ以外は「出てはいけない値」
            return property in values ? values[property] : `${LEAK_MARKER}_${property}`;
          },
          // 列挙 (Object.entries / スプレッド) でも同じ値が見えるようにする
          ownKeys: () => [...new Set([...enumerableKeys, ...Object.keys(values)])],
          // 列挙した名前が実際に読めるよう、記述子も返す (enumerable でないと entries に出ない)
          getOwnPropertyDescriptor(target, property) {
            // Symbol は素通し
            if (typeof property !== 'string')
              return Reflect.getOwnPropertyDescriptor(target, property);
            // 値つきの記述子を返す (target に無い項目なので configurable は必須)
            return {
              value: property in values ? values[property] : `${LEAK_MARKER}_${property}`,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          },
          // 存在確認はすべて真 (当たりを付けてから読む形にも値を渡す)
          has: () => true,
        });
      // error の中身: 中継する項目だけ綴りを通る値にして、分岐が実行される状態にする
      const upstreamError = fieldProxy(
        Object.fromEntries(
          [...relayable].map((field) => [field, vendorValues[field] ?? PASSING_VALUE]),
        ),
      );
      // 最上位: type は閉じた語彙の値、error は上の入れ物、それ以外は目印つきの値
      const safe = sanitizeUpstreamErrorBody(
        fieldProxy({ type: 'error', error: upstreamError }),
      ) as Record<string, unknown>;
      // 出口の最上位に、契約に無い項目が出ていないこと
      const topLevelFields = new Set(Object.keys(relayedTopLevelSchema ?? {}));
      // 契約が読めていなければ照合にならない (fail-closed)
      expect(topLevelFields.size, '契約の最上位の項目が 0 件').toBeGreaterThan(0);
      for (const key of Object.keys(safe))
        expect(topLevelFields.has(key), `契約に無い項目が最上位に出た: ${key}`).toBe(true);
      // 出口の error の中にも、契約に無い項目が出ていないこと
      const errorFields = new Set(Object.keys(relayedErrorSchema ?? {}));
      for (const key of Object.keys((safe.error ?? {}) as Record<string, unknown>))
        expect(errorFields.has(key), `契約に無い項目が error に出た: ${key}`).toBe(true);
      // 目印つきの値が 1 つも出ていないこと (契約の項目名の下へ移し替える形もここで落ちる)
      expect(JSON.stringify(safe), '通してはいけない値が出口に現れた').not.toContain(LEAK_MARKER);
    },
  );

  it.each([
    ['1 段', 2],
    ['2 段', 3],
    ['3 段', 4],
  ])('入れ子の %s 下からも値を運ばない', (_label, depth) => {
    // **上の検査も tests/openapi.test.ts の観測も、入れ子へ降りる実装を 1 度も実行しない** —
    // 前者は未知の名前に文字列を返すだけ、後者は空の入れ物を渡すだけなので、
    // `error.param.detail` のような 3 段目を読む実装が死角になる (実測: 許可リストの直後で
    // `error.param` をオブジェクトとして読み `detail` を中継する変異は 705 件すべて緑のまま、
    // 112 文字の散文をそのまま中継した)。ベンダーの形に合わせる改修 (`error.innererror.code` /
    // `error.details[0].reason` 等) は現実に起こるので、**降りた先も目印つきにする**
    const nested = (remaining: number): Record<string, unknown> =>
      new Proxy({} as Record<string, unknown>, {
        // どの名前で読まれても、まだ深さが残っていれば入れ物、尽きたら目印つきの値を返す
        get(target, property) {
          // Symbol は言語側の問い合わせなので素通しする
          if (typeof property !== 'string') return Reflect.get(target, property);
          // 深さが残っていれば入れ子、尽きたら葉
          return remaining > 1 ? nested(remaining - 1) : `${LEAK_MARKER}_${property}`;
        },
        // 存在確認はすべて真 (当たりを付けてから降りる形にも値を渡す)
        has: () => true,
      });
    // error の中身を入れ子にして通す (最上位 type は閉じた語彙なので通る値を置く)
    const safe = sanitizeUpstreamErrorBody({ type: 'error', error: nested(depth) });
    // 目印つきの値が 1 つも出ていないこと
    expect(JSON.stringify(safe), '入れ子の値が出口に現れた').not.toContain(LEAK_MARKER);
  });

  // その項目へ値を載せた「上流の本文」を組み立てる
  function buildAt(field: string, value: string): unknown {
    // 総当たりの対象はすべて error の中の項目
    return { error: { [field]: value } };
  }
  // 通ったとき、その値が応答のどこへ出るかを読む
  function readAt(field: string, safe: Record<string, unknown>): unknown {
    // 載せ先と同じ場所から読む
    return (safe.error as Record<string, unknown> | undefined)?.[field];
  }
  // 項目ごとの検査ケースへ展開する (ラベルに項目名を入れて、どこで落ちたか分かるようにする)
  function forEachPosition(
    cases: readonly (readonly [string, string])[],
  ): readonly (readonly [string, string, string])[] {
    // 値 × 項目の総当たり
    return cases.flatMap(([label, value]) =>
      CODE_FIELDS.map((field) => [`${label} @ error.${field}`, field, value] as const),
    );
  }

  it.each(
    forEachPosition([
      // 語ごとの規則は満たすが総長が 1 文字だけ超える (先読みの上限だけを見る)
      ['総長を 1 超える', `${'a'.repeat(32)}_${'b'.repeat(8)}`],
      // 総長には収まるが語数が 1 つ多い。**分類語彙で散文を止めている主役はこちら**で、
      // 総長だけでは枠内の英文 (`your_credit_balance_is_too_low` 30 文字) が通ってしまう (実測)
      ['語数を 1 超える', 'a_b_c_d_e'],
      // 先頭語を除く語の長さ (16) の境界
      ['語の長さを 1 超える', `a_${'b'.repeat(17)}`],
      // 上の 2 つが効いていることを、実際に漏れて困る形でも見る
      ['総長に収まる散文', 'your_credit_balance_is_too_low'],
      // **項目ごとに綴りを分けたことの中核**。1 本にまとめると param 用のドットと角括弧が
      // 分類語彙にも効き、区切り文字で書いた文が素通りする (固定する前は変異が全件緑で通った)
      ['ドットで繋いだ文', 'billing.org_ACME_Corp.tier_enterprise'],
      ['JSON パスの形', 'messages[0].content'],
      // 空白を含む散文 (上流の message をそのまま入れてきた場合)
      ['空白を含む散文', 'org ACME Corp balance is $0.00 — upgrade at Plans & Billing'],
      // **文字クラス (どの字を語に使えるか) も固定する。** 上の表はどれも `.` を含むので、
      // 分類語彙はドットだけで落ちており、ハイフンや先頭の字種が一度も試されていなかった
      // (実測: 語の中へ `-` を入れる / 区切りを `[_-]` にする / 先頭に `_` を許す、の 3 変異が
      // いずれも全件緑で通った)。区切りが語に数えられない形は、この commit が `_` について
      // 塞いだ退行とまったく同型
      ['ハイフンで繋いだ文', 'org-ACME-Corp-tier-enterprise-balance-0'],
      ['ハイフン 4 語', 'org-ACME-tier-enterprise'],
      ['先頭のアンダースコア', '_billing_hard_limit_reached'],
    ]),
  )('分類語彙の上限を超えたら通さない: %s', (_label, field, value) => {
    // 上限を緩める変異を落とす。固定する前は語数をいくら広げても全件緑だった (実測)
    expect(sanitizeUpstreamErrorBody(buildAt(field, value))).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it.each(
    forEachPosition([
      ['総長ちょうどの語の連結', `${'a'.repeat(32)}_${'b'.repeat(7)}`],
      ['語数ちょうど', 'a_b_c_d'],
      ['語の長さちょうど', `a_${'b'.repeat(16)}`],
      ['総長ちょうどの 1 語', 'a'.repeat(40)],
    ]),
  )('分類語彙の上限ちょうどは通す (絞りすぎて診断が消えていない): %s', (_label, field, value) => {
    // 上限の下側も見る。上側だけだと、上限をいくら広げても気付けない
    const safe = sanitizeUpstreamErrorBody(buildAt(field, value)) as Record<string, unknown>;
    expect(readAt(field, safe)).toBe(value);
  });

  it.each([
    ['ベンダーの値', 'error', 'error'],
    // 以下はいずれも分類語彙の綴りとしては妥当だが、最上位には載せない
    ['別の識別子', 'invalid_request_error', undefined],
    ['区切りの無い英文', 'OrgAcmeCorpTierEnterpriseBalance0', undefined],
    ['空文字', '', undefined],
  ])('最上位の type は %s だけを通す (閉じた語彙)', (_label, value, expected) => {
    // **ここは分類語彙の綴りを使わない。** 入る値は 'error' 1 つなので、綴りで通すと
    // 診断を 1 ビットも増やさないまま 40 文字ぶんの搬送容量が増える (実測で 33 文字の英文が乗った)
    const safe = sanitizeUpstreamErrorBody({ type: value, error: {} }) as Record<string, unknown>;
    expect(safe.type).toBe(expected);
  });

  it.each([
    // param は綴りが違う (ドットと角括弧を許す) ので、別の表で上下を固定する
    ['総長を 1 超える', `a.${'b'.repeat(23)}.${'c'.repeat(23)}`],
    ['階層を 1 超える', 'a.b.c.d.e.f.g'],
    ['添字の階層を 1 超える', 'a[1][2][3][4][5][6]'],
    ['添字の桁数を 1 超える', 'a[10000]'],
    ['語の長さを 1 超える', `a_${'b'.repeat(17)}`],
    ['階層で繋いだ散文', 'credit.balance.is.too.low.add.funds.now'],
    // **param のアンダースコア散文**。param 用の綴りを別に書いていたとき、文字クラスが `_` を
    // トークンの内側に含んでいたため語数の上限が `_` を数えず、これらがそのまま中継された (実測)
    ['アンダースコア散文', 'your_credit_balance_is_too_low'],
    ['長いアンダースコア散文', 'credit_balance_too_low_go_to_Plans_and_Billing'],
    // **`_` / `-` 区切りのキー形**だけを落とす。`.` 区切りにすると param は通る
    // (`skAnt.api03.AAAABBBBCCCCDDDDEEEEFFFFGGGG` 40 文字は PASS。実測)
    ['アンダースコア区切りのキー形', 'sk_ant_api03_AAAABBBBCCCCDDDDEEEEFFFFGGGG'],
    // param 側の文字クラス。添字は階層 1 つぶんとしか数えないので、字種を緩めると
    // 「語数の枠外に自由な文字が乗る」形になる (実測: 添字を `[0-9A-Za-z]` にすると全件緑で通った)
    ['ハイフンで繋いだ文', 'your-credit-balance-is-too-low'],
    ['先頭のアンダースコア', '_credit.balance'],
    ['添字に数字以外', 'org[ACME][Corp][tier][ent]'],
  ])('JSON パスの上限を超えたら通さない: %s', (_label, param) => {
    // param 側の上限も 1 つずつ上から押さえる
    expect(sanitizeUpstreamErrorBody({ error: { param } })).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });

  it.each([
    ['総長ちょうどの JSON パス', `a.${'b'.repeat(23)}.${'c'.repeat(22)}`],
    ['階層ちょうど', 'a.b.c.d.e.f'],
    ['添字の階層ちょうど', 'a[1][2][3][4][5]'],
    ['4 桁の添字ちょうど', 'a[9999]'],
    ['語数ちょうど', 'a_b_c_d'],
    ['語の長さちょうど', `a_${'b'.repeat(16)}`],
  ])('JSON パスの上限ちょうどは通す (絞りすぎて診断が消えていない): %s', (_label, param) => {
    // param 側の下側。実在の JSON パスを落としていないことを見る
    const safe = sanitizeUpstreamErrorBody({ error: { param } }) as {
      error: Record<string, unknown>;
    };
    expect(safe.error.param).toBe(param);
  });

  it.each([
    ['ベンダーの種別', { type: 'invalid_request_error' }],
    ['ベンダーのコード', { code: 'context_length_exceeded' }],
    ['JSON パス形式の param', { param: 'messages[0].content' }],
    ['4 語までの snake_case', { code: 'billing_hard_limit_reached' }],
    ['PascalCase (Azure)', { type: 'OperationNotSupported' }],
    ['長い PascalCase (Azure の innererror.code)', { code: 'ResponsibleAIPolicyViolation' }],
    ['長い PascalCase (Bedrock)', { code: 'ServiceQuotaExceededException' }],
    ['最も長い 1 語 (Bedrock)', { code: 'ProvisionedThroughputExceededException' }],
    ['長い 1 語 (Azure の Content Filter)', { code: 'ContentFilterResultsPolicyViolation' }],
    ['4 語の snake_case', { code: 'unsupported_country_region_territory' }],
    ['入れ子の添字つき JSON パス', { param: 'messages[0].content[1].text' }],
    ['4 桁の添字', { param: 'messages[1000].content' }],
    ['入れ子の JSON パス', { param: 'tools[12].input_schema.properties' }],
  ])('実在するベンダーの識別子は通す: %s', (_label, error) => {
    // 絞りすぎて診断が消えていないことを確かめる (綴りの条件が厳しすぎると全部 undefined になる)
    const safe = sanitizeUpstreamErrorBody({ error }) as { error: Record<string, unknown> };
    // 入れた項目がそのまま残る
    for (const [key, value] of Object.entries(error)) expect(safe.error[key]).toBe(value);
  });

  // 各項目のトークンに許してよい文字 (**表を正本にする**。ここから negative control を導く)。
  // `param` だけは JSON パスの区切り (`.` と `[添字]`) を追加で許す
  const ALLOWED_CHARACTERS: Readonly<Record<'type' | 'code' | 'param', string>> = {
    type: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
    code: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
    param: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.[]',
  };

  // その項目に許していない符号位置をすべて挙げる。
  //
  // **代表点のリストでは足りない。** 32 巡目は ASCII 全域＋空白類・ゼロ幅・同形異字の
  // 26 点を置いたが、実測で **U+3164 HANGUL FILLER** を 1 文字足す変異が 850 件すべて緑を
  // 通った（多くのフォント・端末で空白として描画されるので、`'Your credit balance is too low'`
  // がそのまま中継される）。「空白に見えるが分類は Zs でない文字」は他にも
  // U+115F / U+1160 / U+FFA0 / U+2800 / U+17B4 …と続き、代表点を足す限り追いかけっこが終わらない。
  //
  // **全符号位置を掃く。** 正規表現の判定だけなら 164ms、`sanitizeUpstreamErrorBody` を
  // 3 項目ぶん実際に呼んでも約 2 秒で、この 1 ファイルの実行時間に上乗せして許容できる。
  // これで「掃いていない符号位置を 1 つだけ通す変異」という族がまるごと閉じる
  // （残るのは「複数符号位置の並びを許す代替パターンを足す」形で、1 行では書けない）
  function forbiddenCharacters(field: 'type' | 'code' | 'param'): string[] {
    // 許可表に無い符号位置を集める
    const forbidden: string[] = [];
    // BMP は符号単位で回す（孤立サロゲートもここで含まれる）
    for (let code = 0; code <= 0xffff; code += 1) {
      const character = String.fromCharCode(code);
      if (!ALLOWED_CHARACTERS[field].includes(character)) forbidden.push(character);
    }
    // BMP の外は**間引いて**回す（1,048,576 点を全部呼ぶと現実的な時間に収まらない）。
    // 面ごとの端と代表点を取る — サロゲートペアの扱いが壊れていればここで落ちる
    for (let plane = 1; plane <= 16; plane += 1) {
      const base = plane * 0x10000;
      for (const offset of [0, 1, 0x600, 0xfffe, 0xffff])
        forbidden.push(String.fromCodePoint(base + offset));
    }
    return forbidden;
  }

  it.each(['type', 'code', 'param'] as const)(
    '%s は許していない ASCII 文字を 1 つでも含めば通さない (文字クラスの negative control)',
    (field) => {
      // 許していない文字 (0 個なら導出が壊れている = fail-closed)
      const forbidden = forbiddenCharacters(field);
      expect(forbidden.length, `${field} に許していない文字が 1 つも無い`).toBeGreaterThan(0);
      // **1 文字ずつ、それだけを混ぜた値で試す** — 既存の negative control は
      // `'quota for org-ACME exhausted; plan=Enterprise'` のように禁止文字を複数含むため、
      // どれか 1 つが漏れても他の文字が落としてしまい、**単独の抜けが見えなかった**。
      // 実測で `[A-Za-z0-9]` → `[A-Za-z0-9 ]` と空白を 1 文字足すだけで 116 件すべて緑になり、
      // `'Your credit balance is too low'` が type / code / param の 3 項目すべてに載った
      // (`:` `=` `,` `/` `$` も同じ。ハイフンだけは既存のケースが単独で落としていた)。
      // **残る境界**: BMP は全符号位置を掃くが、BMP の外は面ごとの端と代表点だけ
      // （全部呼ぶと現実的な時間に収まらない）。掃いていない補助面の符号位置を
      // 1 つだけ通す変異は捉えられない
      for (const character of forbidden) {
        // 前後を許した文字で挟み、禁止文字 1 つだけが違いになるようにする
        const value = `abc${character}def`;
        const safe = sanitizeUpstreamErrorBody({ error: { [field]: value } }) as {
          error: Record<string, unknown>;
        };
        expect(
          safe.error[field],
          `${field} が「${character}」(U+${character.charCodeAt(0).toString(16).padStart(4, '0')}) を含む値を通した`,
        ).toBeUndefined();
      }
    },
  );

  it.each([
    ['文字列でない値', { error: { type: 42, code: null, param: ['a'] } }],
    ['空文字', { error: { type: '' } }],
    ['error がオブジェクトでない', { error: 'boom' }],
    ['error が配列', { error: ['boom'] }],
    ['本文がオブジェクトでない', 'boom'],
    ['本文が null (JSON としては読めた)', null],
    ['本文が配列', [{ error: { type: 'x' } }]],
  ])('%s でも定型文だけを返す (fail-closed)', (_label, parsed) => {
    // 読めない形は素通しせず、定型文だけにする
    expect(sanitizeUpstreamErrorBody(parsed)).toEqual({
      error: { message: API_MESSAGES.upstreamRejected },
    });
  });
});
