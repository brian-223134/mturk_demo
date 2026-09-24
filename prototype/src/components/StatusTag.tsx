import { Tag } from 'antd';
import type { AssignmentStatus, BatchStatus } from '../api/types';

type Status = BatchStatus | AssignmentStatus;

const STYLES: Record<Status, { color: string; label: string }> = {
  in_progress: { color: 'processing', label: 'In progress' },
  completed: { color: 'success', label: 'Completed' },
  expired: { color: 'warning', label: 'Expired' },
  Submitted: { color: 'gold', label: 'Submitted' },
  Approved: { color: 'green', label: 'Approved' },
  Rejected: { color: 'red', label: 'Rejected' },
};

export default function StatusTag({ status }: { status: Status }) {
  const { color, label } = STYLES[status];
  return <Tag color={color}>{label}</Tag>;
}
