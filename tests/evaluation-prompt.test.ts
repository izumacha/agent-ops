// judge へ渡す指示文 (src/domain/evaluation/prompt.ts) の形を固定する。
// 指示が壊れると judge の応答が解析できなくなり、**全ケースが unparsable_output で除外される**
// (テストは緑のまま、実行だけが静かに空振りする) ので、ここで最低限の形を押さえる
import { describe, expect, it } from 'vitest';
import { buildJudgeUserPrompt, JUDGE_SYSTEM_PROMPT } from '@/domain/evaluation/prompt';
import { SCORE_FIELDS } from '@/domain/evaluation/judge-output';

describe('judge へのシステム指示', () => {
  it('採点する 3 項目の綴りが judge-output.ts の表と一致する', () => {
    // 解析側が読む項目名がすべて指示文に現れること (綴りがずれると必ず解析に失敗する)
    for (const field of SCORE_FIELDS) {
      expect(JUDGE_SYSTEM_PROMPT, `${field} が指示文に無い`).toContain(field);
    }
  });

  it('JSON だけを返すよう指示し、応答の形の例を含む', () => {
    // 解析側が期待する入れ物 (results) と、出力形式の指示があること
    expect(JUDGE_SYSTEM_PROMPT).toContain('"results"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('JSON');
  });

  it('ケースの中身を指示として扱わないよう釘を刺している', () => {
    // 評価ケースの入力・応答は外部由来なので、プロンプトインジェクションへの注意を残す
    expect(JUDGE_SYSTEM_PROMPT).toContain('採点対象のデータ');
  });
});

describe('1 バッチ分の本文', () => {
  it('依頼するケース ID を列挙し、入力・応答を見出しで囲う', () => {
    // 期待する出力がある/無いの 2 件
    const prompt = buildJudgeUserPrompt([
      { caseId: 'case_1', input: '入力A', expected: '期待A', actual: '応答A' },
      { caseId: 'case_2', input: '入力B', expected: null, actual: '応答B' },
    ]);
    // 先頭で依頼するケース ID を並べること (返す ID の取り違えを減らす)
    expect(prompt).toContain('採点するケース: case_1, case_2');
    // 各ケースが見出しで区切られること
    expect(prompt).toContain('### ケース case_1');
    expect(prompt).toContain('### ケース case_2');
    // 入力・応答が本文に含まれること
    expect(prompt).toContain('入力A');
    expect(prompt).toContain('応答B');
  });

  it('期待する出力は、あるときだけ見出しごと載せる', () => {
    // 期待する出力を持たないケースだけ
    const prompt = buildJudgeUserPrompt([
      { caseId: 'case_1', input: '入力', expected: null, actual: '応答' },
    ]);
    // 見出しごと出ないこと (空の見出しを見せて judge を迷わせない)
    expect(prompt).not.toContain('#### 期待する出力');
  });
});
