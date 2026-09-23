// 5.2 Create: 템플릿과 CSV를 받아 batch를 게시하는 5단계 wizard.
// 입력은 draft 하나에 모으고(useCreateDraft), 각 단계는 draft의 일부를 읽고 고친다.

import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Flex, Skeleton, Space, Steps, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import { api } from '../../api/client';
import { formatDateTime } from '../../components/format';
import { checkData } from '../../domain/dataCheck';
import { LAST_STEP, STEP_TITLES } from './draft';
import { estimateFor } from './settings';
import DataStep from './steps/DataStep';
import PreviewStep from './steps/PreviewStep';
import PublishStep from './steps/PublishStep';
import SettingsStep from './steps/SettingsStep';
import TemplateStep from './steps/TemplateStep';
import { useCreateDraft } from './useCreateDraft';

export default function CreatePage() {
  const { draft, ready, restoredFrom, update, reset } = useCreateDraft();
  const { modal } = App.useApp();

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.listTemplates() });
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => api.listPools() });
  const account = useQuery({ queryKey: ['account'], queryFn: () => api.getAccount() });

  const template = templates.data?.find((t) => t.id === draft.templateId) ?? null;
  const { data } = draft;

  // 수 MB의 CSV를 훑으므로 placeholder나 CSV가 바뀔 때만 다시 계산한다.
  // template 객체는 목록을 다시 받을 때마다 새로 만들어지므로 내용(문자열)으로 비교한다.
  const placeholderKey = template ? template.placeholders.join('\n') : null;
  const check = useMemo(
    () => (placeholderKey !== null && data ? checkData(placeholderKey === '' ? [] : placeholderKey.split('\n'), data.columns, data.rows) : null),
    [placeholderKey, data],
  );
  const estimate = useMemo(() => estimateFor(draft.settings, data?.rows.length ?? 0), [draft.settings, data]);

  // 앞 단계의 조건이 깨지면(템플릿 삭제, placeholder가 맞지 않는 템플릿으로 교체) 그 단계로 돌려보낸다
  const templatesSettled = templates.isSuccess && !templates.isFetching;
  const waitingForTemplate = draft.templateId !== null && template === null && !templatesSettled && !templates.isError;
  const maxStep = !template ? 0 : !data || !check || check.missingColumns.length > 0 ? 1 : LAST_STEP;
  const step = Math.min(draft.step, maxStep);

  useEffect(() => {
    if (!ready || waitingForTemplate) return;
    if (draft.templateId !== null && template === null && templatesSettled) update({ templateId: null, step: 0 });
    else if (step !== draft.step) update({ step });
  }, [ready, waitingForTemplate, templatesSettled, template, draft.templateId, draft.step, step, update]);

  // "Reset to fixtures"로 사라진 pool이 설정에 남아 있으면 게시가 실패하므로 걸러 낸다
  useEffect(() => {
    if (!ready || !pools.data) return;
    const known = new Set(pools.data.map((p) => p.id));
    const { requiredPoolIds, excludedPoolIds } = draft.settings;
    if ([...requiredPoolIds, ...excludedPoolIds].every((id) => known.has(id))) return;
    update((current) => ({
      settings: {
        ...current.settings,
        requiredPoolIds: requiredPoolIds.filter((id) => known.has(id)),
        excludedPoolIds: excludedPoolIds.filter((id) => known.has(id)),
      },
    }));
  }, [ready, pools.data, draft.settings, update]);

  const goTo = (next: number) => {
    update({ step: Math.min(Math.max(0, next), LAST_STEP) });
    window.scrollTo({ top: 0 });
  };

  const hasInput = draft.templateId !== null || data !== null || draft.editor.html !== '' || draft.step > 0;
  const startOver = () =>
    modal.confirm({
      title: 'Start over?',
      content: 'The template choice, the uploaded CSV and the settings of this draft are discarded. Saved templates are kept.',
      okText: 'Start over',
      okButtonProps: { danger: true },
      onOk: reset,
    });

  let body;
  if (!ready || waitingForTemplate) {
    body = (
      <Card>
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  } else if (step === 0 || !template) {
    body = (
      <TemplateStep
        draft={draft}
        update={update}
        templates={templates.data}
        loading={templates.isLoading}
        error={templates.error}
        selected={template}
        onNext={() => goTo(1)}
      />
    );
  } else if (step === 1 || !data) {
    body = <DataStep template={template} data={data} check={check} update={update} onBack={() => goTo(0)} onNext={() => goTo(2)} />;
  } else if (step === 2) {
    body = (
      <SettingsStep
        settings={draft.settings}
        update={update}
        data={data}
        pools={pools.data}
        poolsLoading={pools.isLoading}
        poolsError={pools.error}
        onBack={() => goTo(1)}
        onNext={() => goTo(3)}
      />
    );
  } else if (step === 3) {
    body = (
      <PreviewStep
        template={template}
        data={data}
        settings={draft.settings}
        previewRow={draft.previewRow}
        answerSchema={draft.answerSchema}
        estimate={estimate}
        account={account.data}
        accountError={account.error}
        update={update}
        onBack={() => goTo(2)}
        onNext={() => goTo(4)}
      />
    );
  } else {
    body = (
      <PublishStep
        template={template}
        data={data}
        settings={draft.settings}
        batchName={draft.batchName}
        answerSchema={draft.answerSchema}
        estimate={estimate}
        account={account.data}
        pools={pools.data}
        update={update}
        onPublished={reset}
        onBack={() => goTo(3)}
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Create batch
        </Typography.Title>
        <Space size="middle">
          {restoredFrom && hasInput && (
            <Typography.Text type="secondary">Draft restored (saved {formatDateTime(restoredFrom)})</Typography.Text>
          )}
          <Button size="small" onClick={startOver} disabled={!hasInput}>
            Start over
          </Button>
        </Space>
      </Flex>

      <Card size="small">
        <Steps
          size="small"
          current={step}
          // 앞으로 가는 것은 각 단계의 검증을 거치는 Next로만 한다
          onChange={(next) => next < step && goTo(next)}
          items={STEP_TITLES.map((title, index) => ({ title, disabled: !ready || index > step }))}
        />
      </Card>

      {body}
    </Space>
  );
}
