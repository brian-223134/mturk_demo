import { Alert } from 'antd';

/** 목록 조회가 실패했을 때 표 위에 띄운다. ApiError의 code가 있으면 함께 보여준다. */
export default function QueryErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const code = typeof error === 'object' && 'code' in error ? String(error.code) : null;
  const text = error instanceof Error ? error.message : String(error);
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message={code ? `Failed to load (${code})` : 'Failed to load'}
      description={text}
    />
  );
}
