// 5.3 Batch 상세: 경로와 네 하위 탭 (Overview, Review, HITs, Results)

import { useQuery } from '@tanstack/react-query';
import { Breadcrumb, Skeleton, Space, Tabs, Tag } from 'antd';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import StatusTag from '../../components/StatusTag';
import HitsTab from './tabs/HitsTab';
import OverviewTab from './tabs/OverviewTab';
import ResultsTab from './tabs/ResultsTab';
import ReviewTab from './tabs/ReviewTab';

const TAB_KEYS = ['overview', 'review', 'hits', 'results'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | undefined): value is TabKey {
  return (TAB_KEYS as readonly string[]).includes(value ?? '');
}

export default function BatchDetailPage() {
  const { batchId = '', tab } = useParams();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ['batch', batchId], queryFn: () => api.getBatch(batchId) });

  if (!isTabKey(tab)) return <Navigate to={`/manage/${batchId}/overview`} replace />;

  const submitted = detail.data?.progress.submitted ?? 0;
  const labels: Record<TabKey, string> = {
    overview: 'Overview',
    review: submitted > 0 ? `Review (${submitted})` : 'Review',
    hits: 'HITs',
    results: 'Results',
  };

  return (
    <>
      <Space size="middle" style={{ marginBottom: 8 }}>
        <Breadcrumb
          items={[{ title: <Link to="/manage">Manage</Link> }, { title: detail.data?.batch.name ?? batchId }]}
        />
        {detail.data && <StatusTag status={detail.data.status} />}
        {detail.data?.needsReview && <Tag color="gold">Needs review</Tag>}
      </Space>
      <QueryErrorAlert error={detail.error} />
      {detail.isLoading && <Skeleton active />}
      {detail.data && (
        <Tabs
          activeKey={tab}
          destroyOnHidden
          onChange={(key) => navigate(`/manage/${batchId}/${key}`)}
          items={[
            { key: 'overview', label: labels.overview, children: <OverviewTab detail={detail.data} /> },
            { key: 'review', label: labels.review, children: <ReviewTab detail={detail.data} /> },
            { key: 'hits', label: labels.hits, children: <HitsTab detail={detail.data} /> },
            { key: 'results', label: labels.results, children: <ResultsTab detail={detail.data} /> },
          ]}
        />
      )}
    </>
  );
}
