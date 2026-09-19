// 5.5 미리보기 환경. 템플릿을 CSV 1행으로 렌더해 worker가 보는 화면 그대로 띄운다.
// sandbox에 allow-same-origin을 주지 않으므로 템플릿의 JS는 콘솔 앱(쿠키, 저장소, DOM)에 접근할 수 없고,
// 콘솔과는 postMessage로만 통신한다 (src/domain/template.ts의 PREVIEW_BRIDGE).
// allow-forms는 필요하다. 없으면 브라우저가 submit 이벤트를 내기도 전에 제출을 막아서 가로챌 수가 없다.
// 실제 제출은 PREVIEW_BRIDGE가 항상 취소하므로 iframe이 다른 주소로 이동하지는 않는다.

import { Alert, Button, Flex, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnswerField, AnswerItem } from '../api/types';
import { PREVIEW_MESSAGE_SOURCE, renderTemplate, type PreviewMessage } from '../domain/template';

interface Props {
  html: string;
  row: Record<string, string>;
  height?: number | string;
  /** 화면에서 읽어 낸 문항 목록 (name과 선택지). 게시할 때 batch.answerSchema로 저장한다. */
  onSchema?: (fields: AnswerField[]) => void;
}

export default function TaskPreviewFrame({ html, row, height = 640, onSchema }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [submitted, setSubmitted] = useState<AnswerItem[] | null>(null);
  const srcDoc = useMemo(() => renderTemplate(html, row, { preview: true }), [html, row]);
  // 내용이 바뀌면 iframe을 새로 만든다 (srcdoc만 바꾸면 이전 문서의 스크립트 상태가 남는 브라우저가 있다)
  const frameKey = useMemo(() => `${Date.now()}-${Math.random()}`, [srcDoc]);

  const schemaHandler = useRef(onSchema);
  schemaHandler.current = onSchema;

  useEffect(() => {
    setSubmitted(null);
    const onMessage = (event: MessageEvent<PreviewMessage>) => {
      // origin은 sandbox 때문에 "null"이라 비교할 수 없다. 이 iframe의 창에서 온 메시지인지로 가린다.
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (event.data.type === 'submit') setSubmitted(event.data.answers ?? []);
      if (event.data.type === 'schema') schemaHandler.current?.(event.data.fields ?? []);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [srcDoc]);

  return (
    <div>
      <iframe
        ref={frame}
        key={frameKey}
        title="Task preview"
        sandbox="allow-scripts allow-forms"
        srcDoc={srcDoc}
        style={{ width: '100%', height, border: '1px solid #d9d9d9', borderRadius: 4, background: '#fff' }}
      />
      {submitted && (
        <Alert
          type="success"
          style={{ marginTop: 12 }}
          message={
            <Flex justify="space-between" align="center">
              <span>
                Submit intercepted: {submitted.length} answer(s). Nothing was sent to MTurk.
              </span>
              <Button size="small" onClick={() => setSubmitted(null)}>
                Clear
              </Button>
            </Flex>
          }
          description={
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              <pre style={{ maxHeight: 220, overflow: 'auto', margin: 0, fontSize: 12 }}>
                input_answers = {JSON.stringify(submitted, null, 2)}
              </pre>
            </Typography.Paragraph>
          }
        />
      )}
    </div>
  );
}
