// 5.4 Worker 목록. 정렬, 검색, 필터, 페이지 이동은 전부 listWorkers에 맡긴다 (서버식 페이지네이션, 명세 9장).
// 여러 명을 골라 pool에 넣거나 빼고, 차단한다. 차단의 기본 동선은 Excluded pool이다 (BlockWorkersModal).

import { FileTextOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Button,
  Flex,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
  type TableProps,
} from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { ListQuery, Worker } from '../../api/types';
import QueryErrorAlert from '../../components/QueryErrorAlert';
import { formatDate, formatPercent, formatSeconds } from '../../components/format';
import BlockWorkersModal from './BlockWorkersModal';
import PoolMenuButton from './PoolMenuButton';
import { countWorkers } from './shared';
import { useWorkerActions } from './useWorkerActions';

const DEFAULT_SORT: NonNullable<ListQuery['sort']> = { field: 'stats.total', order: 'desc' };

interface Filters {
  search: string;
  poolId: string; // ''이면 Any pool
  blockedOnly: boolean;
}

export default function WorkerListPage() {
  const [paging, setPaging] = useState({ page: 1, pageSize: 25, sort: DEFAULT_SORT });
  const [filters, setFilters] = useState<Filters>({ search: '', poolId: '', blockedOnly: false });
  // 선택은 페이지를 넘겨도 유지된다. 차단 여부를 보려고 key와 함께 행도 들고 있는다.
  const [selected, setSelected] = useState<Worker[]>([]);
  const [blockOpen, setBlockOpen] = useState(false);
  const actions = useWorkerActions();

  // 빈 값은 listWorkers가 필터가 없는 것으로 본다
  const query: ListQuery = {
    ...paging,
    filters: { search: filters.search, poolId: filters.poolId, blocked: filters.blockedOnly ? true : undefined },
  };
  const workers = useQuery({
    queryKey: ['workers', query],
    queryFn: () => api.listWorkers(query),
    placeholderData: keepPreviousData,
  });
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api.listPools() });
  const poolName = (id: string) => pools.data?.find((p) => p.id === id)?.name ?? id;

  // 차단 해제나 pool 제거로 마지막 페이지가 비면 앞 페이지로 돌아간다
  const total = workers.data?.total;
  useEffect(() => {
    if (total === undefined) return;
    const lastPage = Math.max(1, Math.ceil(total / paging.pageSize));
    if (paging.page > lastPage) setPaging((previous) => ({ ...previous, page: lastPage }));
  }, [total, paging.page, paging.pageSize]);

  const selectedIds = selected.map((w) => w.WorkerId);
  const allBlocked = selected.length > 0 && selected.every((w) => w.blocked);
  const clearSelection = () => setSelected([]);
  const changeFilter = (patch: Partial<Filters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
    setPaging((previous) => ({ ...previous, page: 1 }));
  };

  const sortOrderOf = (field: string) =>
    paging.sort.field === field ? (paging.sort.order === 'asc' ? 'ascend' : 'descend') : null;

  // key가 곧 listWorkers의 정렬 필드다
  const numeric = (title: string, key: string, render: (w: Worker) => string | number, width = 90) =>
    ({
      title,
      key,
      width,
      align: 'right' as const,
      sorter: true,
      sortOrder: sortOrderOf(key),
      sortDirections: ['descend' as const, 'ascend' as const],
      render: (_: unknown, worker: Worker) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{render(worker)}</span>
      ),
    }) satisfies TableColumnsType<Worker>[number];

  const columns: TableColumnsType<Worker> = [
    {
      title: 'Worker',
      key: 'WorkerId',
      sorter: true,
      sortOrder: sortOrderOf('WorkerId'),
      render: (_, worker) => (
        <Space size={6}>
          <Link to={`/workers/${worker.WorkerId}`}>
            <Typography.Text code>{worker.WorkerId}</Typography.Text>
          </Link>
          {worker.note && (
            <Tooltip title={worker.note}>
              <FileTextOutlined style={{ color: 'rgba(0, 0, 0, 0.45)' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    numeric('Subm', 'stats.total', (w) => w.stats.total, 80),
    numeric('Appr', 'stats.approved', (w) => w.stats.approved, 80),
    numeric('Rej', 'stats.rejected', (w) => w.stats.rejected, 80),
    numeric('Rej%', 'stats.rejectRate', (w) => formatPercent(w.stats.rejectRate)),
    numeric('Attn fail', 'stats.attentionFailRate', (w) => formatPercent(w.stats.attentionFailRate), 100),
    numeric('Med time', 'stats.medianWorkTimeInSeconds', (w) => formatSeconds(w.stats.medianWorkTimeInSeconds), 100),
    numeric('Agree', 'stats.majorityAgreement', (w) => formatPercent(w.stats.majorityAgreement)),
    numeric('Batches', 'stats.batchCount', (w) => w.stats.batchCount),
    {
      title: 'Pools',
      key: 'pools',
      width: 190,
      render: (_, worker) => (
        <>
          {worker.poolIds.map((id) => (
            <Tag key={id}>{poolName(id)}</Tag>
          ))}
          {worker.blocked && <Tag color="red">Blocked</Tag>}
        </>
      ),
    },
    {
      title: 'Last active',
      key: 'stats.lastActiveAt',
      width: 120,
      sorter: true,
      sortOrder: sortOrderOf('stats.lastActiveAt'),
      render: (_, worker) => formatDate(worker.stats.lastActiveAt),
    },
  ];

  const onTableChange: TableProps<Worker>['onChange'] = (pagination, _filters, sorter) => {
    const active = Array.isArray(sorter) ? sorter[0] : sorter;
    setPaging((previous) => ({
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? previous.pageSize,
      sort:
        active?.order && typeof active.columnKey === 'string'
          ? { field: active.columnKey, order: active.order === 'ascend' ? 'asc' : 'desc' }
          : DEFAULT_SORT,
    }));
  };

  return (
    <>
      <Flex justify="space-between" align="center" gap={16} style={{ marginBottom: 12 }}>
        <Space>
          <PoolMenuButton
            mode="add"
            pools={pools.data}
            workerIds={selectedIds}
            disabled={actions.busy}
            onPick={(pool) => actions.addToPool(pool, selectedIds).then((ok) => ok && clearSelection())}
          />
          <PoolMenuButton
            mode="remove"
            pools={pools.data}
            workerIds={selectedIds}
            disabled={actions.busy}
            onPick={(pool) => actions.removeFromPool(pool, selectedIds).then((ok) => ok && clearSelection())}
          />
          {allBlocked ? (
            <Button
              disabled={actions.busy}
              onClick={() => void actions.unblock(selectedIds).then((ok) => ok && clearSelection())}
            >
              Unblock
            </Button>
          ) : (
            <Button danger disabled={selected.length === 0 || actions.busy} onClick={() => setBlockOpen(true)}>
              Block…
            </Button>
          )}
          <Typography.Text type="secondary" style={{ marginLeft: 4 }}>
            {selected.length} selected
          </Typography.Text>
          {selected.length > 0 && (
            <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={clearSelection}>
              Clear
            </Button>
          )}
        </Space>
        <Space size="middle">
          <Select
            style={{ width: 170 }}
            value={filters.poolId}
            onChange={(poolId) => changeFilter({ poolId })}
            loading={pools.isLoading}
            options={[
              { value: '', label: 'Any pool' },
              ...(pools.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.workerIds.length})` })),
            ]}
          />
          <Space size={6}>
            <Switch
              size="small"
              id="blocked-only"
              checked={filters.blockedOnly}
              onChange={(blockedOnly) => changeFilter({ blockedOnly })}
            />
            <label htmlFor="blocked-only">Blocked only</label>
          </Space>
          <Input.Search
            allowClear
            placeholder="Search WorkerId"
            style={{ width: 240 }}
            onSearch={(search) => changeFilter({ search: search.trim() })}
          />
        </Space>
      </Flex>
      <QueryErrorAlert error={workers.error} />
      <Table
        rowKey="WorkerId"
        columns={columns}
        dataSource={workers.data?.items}
        loading={workers.isFetching || actions.busy}
        onChange={onTableChange}
        size="middle"
        rowSelection={{
          selectedRowKeys: selectedIds,
          preserveSelectedRowKeys: true,
          onChange: (_keys, rows) => setSelected(rows.filter(Boolean)),
        }}
        pagination={{
          current: paging.page,
          pageSize: paging.pageSize,
          total: workers.data?.total,
          showSizeChanger: true,
          pageSizeOptions: [25, 50, 100],
          showTotal: (count) => countWorkers(count),
        }}
      />

      {blockOpen && (
        <BlockWorkersModal
          workerIds={selectedIds}
          onCancel={() => setBlockOpen(false)}
          onDone={() => {
            setBlockOpen(false);
            clearSelection();
          }}
        />
      )}
    </>
  );
}
