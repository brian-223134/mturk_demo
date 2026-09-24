import { Space, Tag, Typography } from 'antd';

interface Props {
  names: string[];
  color?: string;
  /** 이름이 하나도 없을 때 보여줄 문구 */
  empty?: string;
}

/** `${컬럼명}` 목록. placeholder가 없는 템플릿은 TASK_DATA 방식이다 (5.5). */
export default function PlaceholderTags({ names, color, empty = 'none (uses window.TASK_DATA)' }: Props) {
  if (names.length === 0) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <Space size={[0, 4]} wrap>
      {names.map((name) => (
        <Tag key={name} color={color} style={{ fontFamily: 'monospace' }}>{`\${${name}}`}</Tag>
      ))}
    </Space>
  );
}
