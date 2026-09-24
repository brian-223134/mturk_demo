// 5.3 Results: 문항별 투표와 majority, 만장일치 비율, Fleiss κ (8.4), 라벨 분포, export.
// Approved assignment의 실제 문항만 센다. 계산은 서버(또는 mock)가 하고 화면은 보여주기만 한다.

import { DownOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Col, Dropdown, Flex, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { useMemo, useState } from 'react';
import { api } from '../../../api/client';
import type { BatchDetail, ExportFormat, ItemResult } from '../../../api/types';
import QueryErrorAlert from '../../../components/QueryErrorAlert';
import StackedBar, { CATEGORY_COLORS } from '../../../components/StackedBar';
import { downloadFile } from '../../../components/download';
import { formatPercent } from '../../../components/format';

type ItemFilter = 'all' | 'not-unanimous' | 'tie' | 'short';

/** Landis & Koch (1977)의 구간. 해석을 돕는 관례일 뿐 기준은 아니다. */
function kappaBand(kappa: number): string {
  if (kappa < 0) return 'poor';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}

export default function ResultsTab({ detail }: { detail: BatchDetail }) {
  const { batch } = detail;
  const { notification } = App.useApp();
  const [filter, setFilter] = useState<ItemFilter>('all');
  const results = useQuery({ queryKey: ['results', batch.id], queryFn: () => api.getResults(batch.id) });

  const exportAs = async (format: ExportFormat) => {
    try {
      downloadFile(await api.exportBatch(batch.id, format));
    } catch (error) {
      notification.error({ message: 'Export failed', description: error instanceof Error ? error.message : String(error) });
    }
  };

  const data = results.data;
  // 값마다 색을 고정한다 (득표 순이 아니라 이름 순). 필터로 항목이 줄어도 같은 값은 같은 색이다.
  const labels = useMemo(() => Object.keys(data?.labelDistribution ?? {}).sort(), [data]);
  const colorOf = (label: string) => CATEGORY_COLORS[labels.indexOf(label)] ?? '#8c8b86';

  const shown = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === 'not-unanimous') return items.filter((i) => !i.unanimous && i.votes.length > 1);
    if (filter === 'tie') return items.filter((i) => i.majority === null);
    if (filter === 'short') return items.filter((i) => i.votes.length < (data?.target ?? 0));
    return items;
  }, [data, filter]);

  const columns: TableColumnsType<ItemResult> = [
    { title: 'Row', dataIndex: 'rowIndex', width: 80, align: 'right', sorter: (a, b) => a.rowIndex - b.rowIndex },
    { title: 'Item', dataIndex: 'answerName', width: 220, render: (name: string) => <Typography.Text code>{name}</Typography.Text> },
    {
      title: 'Votes (approved)',
      key: 'votes',
      render: (_, item) => (
        <Space size={[4, 4]} wrap>
          {item.votes.map((vote, i) => (
            <Tooltip key={item.workers[i]} title={item.workers[i]}>
              <Tag style={{ marginInlineEnd: 0 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: colorOf(vote), marginRight: 6 }} />
                {vote}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
    { title: 'n', key: 'n', width: 60, align: 'right', render: (_, item) => item.votes.length, sorter: (a, b) => a.votes.length - b.votes.length },
    {
      title: 'Majority',
      key: 'majority',
      width: 200,
      render: (_, item) =>
        item.majority === null ? <Tag color="gold">tie</Tag> : (
          <Space size={4}>
            <Tag style={{ marginInlineEnd: 0 }}>{item.majority}</Tag>
            {item.unanimous && <Typography.Text type="secondary" style={{ fontSize: 12 }}>unanimous</Typography.Text>}
          </Space>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <QueryErrorAlert error={results.error} />
      <Row gutter={16}>
        <Col span={5}>
          <Card size="small" loading={results.isLoading} style={{ height: '100%' }}>
            <Statistic
              title={<Tooltip title="Computed only on items with exactly the target number of approved votes">Fleiss' κ</Tooltip>}
              value={data?.fleissKappa === null || data === undefined ? '–' : data.fleissKappa.toFixed(3)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data?.fleissKappa !== null && data !== undefined ? `${kappaBand(data.fleissKappa)} agreement · ` : ''}
              {data?.kappaItemCount ?? 0} items × {data?.target ?? batch.settings.MaxAssignments} raters
            </Typography.Text>
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small" loading={results.isLoading} style={{ height: '100%' }}>
            <Statistic title="Unanimous items" value={formatPercent(data?.unanimousRatio)} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>of items with {data?.target} votes</Typography.Text>
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small" loading={results.isLoading} style={{ height: '100%' }}>
            <Statistic title="Items with votes" value={data?.items.length ?? 0} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {(data?.items.length ?? 0) - (data?.kappaItemCount ?? 0)} not at {data?.target} votes · {data?.items.filter((i) => i.majority === null).length ?? 0} tied
            </Typography.Text>
          </Card>
        </Col>
        <Col span={9}>
          <Card size="small" title="Label distribution (approved votes)" loading={results.isLoading} style={{ height: '100%' }}>
            <StackedBar
              segments={labels.map((label) => ({ key: label, label, value: data?.labelDistribution[label] ?? 0, color: colorOf(label) }))}
            />
          </Card>
        </Col>
      </Row>

      <div>
        <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
          <Space>
            <Typography.Text strong>Items</Typography.Text>
            <Select<ItemFilter>
              value={filter}
              onChange={setFilter}
              style={{ width: 240 }}
              options={[
                { value: 'all', label: 'All items' },
                { value: 'not-unanimous', label: 'Not unanimous' },
                { value: 'tie', label: 'Tied (no majority)' },
                { value: 'short', label: `Fewer than ${data?.target ?? ''} votes` },
              ]}
            />
            <Typography.Text type="secondary">{shown.length} shown</Typography.Text>
          </Space>
          <Dropdown
            menu={{
              items: [
                { key: 'labels-json', label: 'Labels JSON (votes, majority, workers per item)' },
                { key: 'mturk-csv', label: 'MTurk results CSV (same columns as the Requester website export)' },
              ],
              onClick: ({ key }) => void exportAs(key as ExportFormat),
            }}
          >
            <Button>
              Export <DownOutlined />
            </Button>
          </Dropdown>
        </Flex>
        <Table
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={shown}
          loading={results.isLoading}
          pagination={{ pageSize: 25, showSizeChanger: true, pageSizeOptions: [25, 50, 100], showTotal: (total) => `${total} items` }}
        />
      </div>
    </Space>
  );
}
