// "Open task": 그 HIT의 입력으로 batch의 템플릿 사본을 렌더해 worker가 본 화면을 띄운다.
// 목록은 입력을 잘라서 주므로 getHit으로 전체 입력을 받는다.

import { useQuery } from '@tanstack/react-query';
import { Modal, Skeleton } from 'antd';
import { api } from '../../api/client';
import type { Batch } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import TaskPreviewFrame from '../../components/TaskPreviewFrame';

interface Props {
  batch: Batch;
  hitId: string;
  rowIndex: number;
  onClose: () => void;
}

export default function TaskPreviewModal({ batch, hitId, rowIndex, onClose }: Props) {
  const hit = useQuery({ queryKey: ['hit', hitId], queryFn: () => api.getHit(hitId) });

  return (
    <Modal open onCancel={onClose} footer={null} width={1180} style={{ top: 24 }} title={`Task preview · row ${rowIndex} · HIT ${hitId}`} destroyOnHidden>
      <QueryErrorAlert error={hit.error} />
      {hit.isLoading && <Skeleton active />}
      {hit.data && <TaskPreviewFrame html={batch.templateHtml} row={hit.data.input} height="70vh" />}
    </Modal>
  );
}
