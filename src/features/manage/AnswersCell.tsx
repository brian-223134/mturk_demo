// Review 표의 Answers 셀: 윗줄 W(this worker), 아랫줄 R(reference). 문항은 제출 순서대로 토큰 하나씩이라
// hover 없이 한 줄을 훑어 판단한다. 토큰 폭은 페이지에서 가장 긴 토큰에 맞춰 W와 R이 세로로 나란히 선다.

import { Typography, theme } from 'antd';
import type { CSSProperties } from 'react';
import type { AssignmentListItem } from '../../api/types';
import { isAttentionName } from '../../domain/attention';
import { normalizeLabel } from '../../domain/reference';

interface Props {
  assignment: AssignmentListItem;
  tokens: Map<string, string>; // 값 → 약어 (answerTokens.abbreviate)
  tokenWidth: number; // ch 단위
  attentionPrefix: string;
}

/** 페이지의 토큰 중 가장 긴 것에 맞춘 폭(ch). 값 전체를 쓰는 긴 토큰은 잘라 보이고 title로 읽는다 */
export function tokenWidthOf(tokens: Map<string, string>): number {
  let longest = 1;
  for (const token of tokens.values()) longest = Math.max(longest, token.length);
  return Math.min(longest, 12) + 1;
}

export default function AnswersCell({ assignment, tokens, tokenWidth, attentionPrefix }: Props) {
  const { token: t } = theme.useToken();
  const box: CSSProperties = {
    display: 'inline-block',
    width: `${tokenWidth}ch`,
    fontFamily: t.fontFamilyCode,
    fontSize: 11,
    lineHeight: '16px',
    textAlign: 'center',
    border: '1px solid transparent',
    borderRadius: 3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const attentionBox: CSSProperties = { borderColor: t.purple };
  const mismatchBox: CSSProperties = { color: t.colorError, background: t.colorErrorBg };
  const line: CSSProperties = { display: 'flex', gap: 2, alignItems: 'center' };
  const label: CSSProperties = { width: 14, flex: 'none', fontSize: 11 };

  const pairs = assignment.answers.map((answer) => {
    const reference = assignment.reference[answer.name];
    return {
      name: answer.name,
      worker: answer.value,
      reference,
      attention: isAttentionName(answer.name, attentionPrefix),
      // 표시는 원래 문자열, 비교는 normalizeLabel (표의 Agree 열과 같은 기준)
      mismatch: reference !== undefined && normalizeLabel(reference) !== normalizeLabel(answer.value),
      title: `${answer.name} · worker: ${answer.value} · reference: ${reference ?? 'none'}`,
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={line}>
        <Typography.Text type="secondary" style={label}>W</Typography.Text>
        {pairs.map((p) => (
          <span key={p.name} title={p.title} style={{ ...box, ...(p.attention ? attentionBox : {}), ...(p.mismatch ? mismatchBox : {}) }}>
            {tokens.get(p.worker) ?? p.worker}
          </span>
        ))}
      </div>
      <div style={line}>
        <Typography.Text type="secondary" style={label}>R</Typography.Text>
        {pairs.map((p) =>
          p.reference === undefined ? (
            <span key={p.name} title={p.title} style={{ ...box, color: t.colorTextQuaternary }}>·</span>
          ) : (
            <span key={p.name} title={p.title} style={{ ...box, ...(p.attention ? attentionBox : {}) }}>
              {tokens.get(p.reference) ?? p.reference}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
