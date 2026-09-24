// 설계 명세 4장의 데이터 모델과 6장 API가 주고받는 타입.
// PascalCase 필드는 MTurk API(boto3) 응답과 같은 이름이고, camelCase 필드는 콘솔이 추가한 것이다.

export type Env = 'mock' | 'sandbox' | 'production';

export interface Template {
  id: string;
  name: string;
  html: string; // instruction + 문항 UI가 든 단일 HTML
  placeholders: string[]; // html에서 추출한 ${...} 이름 (저장할 때 계산)
  updatedAt: string; // ISO 8601
}

// MTurk CreateHITType + CreateHIT 파라미터와 1:1
export interface HitSettings {
  Title: string;
  Description: string;
  Keywords: string; // 쉼표 구분
  Reward: string; // USD. MTurk와 같이 문자열 ("0.10")
  MaxAssignments: number; // HIT당 목표 라벨 수
  AssignmentDurationInSeconds: number;
  LifetimeInSeconds: number;
  AutoApprovalDelayInSeconds: number;
  QualificationRequirements: QualificationRequirement[];
}

// MTurk 구조 그대로
export interface QualificationRequirement {
  QualificationTypeId: string;
  Comparator:
    | 'GreaterThanOrEqualTo'
    | 'LessThan'
    | 'EqualTo'
    | 'In'
    | 'NotIn'
    | 'Exists'
    | 'DoesNotExist';
  IntegerValues?: number[];
  LocaleValues?: { Country: string }[];
  ActionsGuarded?: 'Accept' | 'PreviewAndAccept' | 'DiscoverPreviewAndAccept';
}

export interface AttentionRule {
  namePrefix: string; // 기본 "attention_"
  expectedValue: string; // 예: "not_grounded"
  minCorrectRatio: number; // 통과 기준. 기본 1.0 (전부 정답)
}

/** Review에서 답을 대조하는 기준. 없으면(옛 저장본) majority로 본다. */
export type ReviewReference =
  | { source: 'majority' } // 같은 HIT의 다른 worker들(반려 제외)의 majority
  | { source: 'column'; column: string }; // 입력 CSV의 컬럼 (GT 또는 LLM 라벨). inputColumns에 있어야 한다

export interface Batch {
  id: string;
  name: string;
  env: Env;
  templateId: string;
  templateHtml: string; // 게시 시점의 템플릿 사본. 이후 템플릿 수정과 무관
  inputColumns: string[];
  settings: HitSettings;
  attentionRule: AttentionRule | null;
  reference?: ReviewReference; // Review의 대조 기준. 없으면 majority
  requiredPoolIds: string[]; // 이 pool의 worker만 참여
  excludedPoolIds: string[]; // 이 pool의 worker는 제외
  createdAt: string;
  /**
   * 미리보기에서 읽어 낸 문항 목록 (name과 선택지). 콘솔은 템플릿 내용을 해석하지 않으므로,
   * 응답이 아직 없는 batch에 가짜 제출(7.3)을 만들 때 이 값을 쓴다. 없어도 된다.
   */
  answerSchema?: AnswerField[];
}

export interface AnswerField {
  name: string;
  values: string[];
}

export type HITStatus = 'Assignable' | 'Unassignable' | 'Reviewable' | 'Reviewing' | 'Disposed';

export interface Hit {
  HITId: string;
  HITStatus: HITStatus;
  MaxAssignments: number; // 재모집하면 늘어남
  NumberOfAssignmentsPending: number;
  NumberOfAssignmentsAvailable: number;
  NumberOfAssignmentsCompleted: number;
  CreationTime: string;
  Expiration: string;
  batchId: string;
  rowIndex: number; // 입력 CSV의 몇 번째 행인지 (0부터)
  input: Record<string, string>; // CSV 1행. 셀 값은 문자열 그대로
  initialMaxAssignments: number; // 생성 시 값. 10개 상한 판정에 필요 (8.3)
}

export interface AnswerItem {
  name: string;
  value: string;
}

export type AssignmentStatus = 'Submitted' | 'Approved' | 'Rejected';

export interface AttentionResult {
  total: number;
  correct: number;
  passed: boolean;
}

export interface Assignment {
  AssignmentId: string;
  HITId: string;
  WorkerId: string;
  AssignmentStatus: AssignmentStatus;
  AcceptTime: string;
  SubmitTime: string;
  AutoApprovalTime: string;
  ApprovalTime?: string;
  RejectionTime?: string;
  RequesterFeedback?: string;
  answers: AnswerItem[]; // 파싱된 응답
  workTimeInSeconds: number; // SubmitTime - AcceptTime
  attention: AttentionResult | null; // 8.2. attention 문항이 없으면 null
}

// 8.5. 비율은 분모가 0이면 null이다.
export interface WorkerStats {
  total: number; // 제출한 assignment 수 (상태 무관)
  approved: number;
  rejected: number;
  pending: number; // Submitted (검수 대기)
  rejectRate: number | null; // 반려 / (승인 + 반려)
  attentionFailRate: number | null; // attention 미통과 / attention 판정이 있는 assignment
  medianWorkTimeInSeconds: number | null;
  majorityAgreement: number | null; // 같은 문항의 다른 worker들 majority와 같은 비율
  batchCount: number;
  lastActiveAt: string | null; // 마지막 SubmitTime
}

export interface Worker {
  WorkerId: string;
  stats: WorkerStats;
  poolIds: string[];
  blocked: boolean;
  note: string;
}

export interface WorkerPool {
  id: string;
  name: string;
  description: string;
  QualificationTypeId?: string; // 연동 후 채워짐
  workerIds: string[];
}

// ---------------------------------------------------------------------------
// 파생 값. 저장하지 않고 계산한다.

export type BatchStatus = 'in_progress' | 'completed' | 'expired';

export interface BatchProgress {
  hitsTotal: number;
  hitsCompleted: number; // approved ≥ target 인 HIT 수 (8.3)
  submitted: number;
  approved: number;
  rejected: number;
  open: number; // 아직 아무도 제출하지 않은 자리
  rejectRate: number | null; // 반려 / (승인 + 반려)
}

// 금액은 센트 단위 숫자다. 수수료 때문에 소수 센트가 나올 수 있고, 표시할 때 반올림한다.
export interface BatchCost {
  spentCents: number; // Approved assignment의 reward + 수수료
  estimatedCents: number; // 남은 자리가 전부 승인된다고 볼 때의 총액
}

export interface BatchSummary {
  batch: Omit<Batch, 'templateHtml'>; // 목록에서는 템플릿 사본을 빼고 보낸다
  status: BatchStatus;
  needsReview: boolean; // Submitted가 1건 이상
  progress: BatchProgress;
  cost: BatchCost;
}

export interface BatchDetail extends Omit<BatchSummary, 'batch'> {
  batch: Batch;
}

export interface HitProgressSummary {
  submitted: number;
  approved: number;
  rejected: number;
  open: number;
  completed: boolean;
  shortfall: number; // 'fill-to-target' 재모집으로 추가될 수 (8.3)
}

/** HIT 목록의 항목. 입력 셀이 수십 KB라 목록에서는 잘라서 보내고, 전체는 getHit으로 받는다. */
export interface HitListItem extends Omit<Hit, 'input'> {
  inputPreview: Record<string, string>;
  progress: HitProgressSummary;
  expired: boolean;
}

/** Assignment 목록의 항목. Review 표의 Row, Answers, Agree 열에 쓴다. */
export interface AssignmentListItem extends Assignment {
  rowIndex: number;
  /** 문항 이름 → 대조 기준 값. attention 문항은 batch의 expectedValue. 기준이 없는 문항은 키가 없다 */
  reference: Record<string, string>;
  /** 일반 문항(attention 제외) 중 reference와 같은 비율. 비교할 문항이 없으면 null */
  agreement: number | null;
}

export interface WorkerAssignmentSummary {
  AssignmentId: string;
  HITId: string;
  batchId: string;
  rowIndex: number;
  AssignmentStatus: AssignmentStatus;
  SubmitTime: string;
  workTimeInSeconds: number;
  attention: AttentionResult | null;
  RequesterFeedback?: string;
}

export interface WorkerDetail extends Worker {
  batches: { batchId: string; batchName: string; total: number; approved: number; rejected: number; pending: number }[];
  assignments: WorkerAssignmentSummary[]; // 최근 제출부터
  blockReason?: string;
}

// ---------------------------------------------------------------------------
// 6장 API의 요청과 응답

export interface ListQuery {
  page: number; // 1부터
  pageSize: number;
  sort?: { field: string; order: 'asc' | 'desc' };
  filters?: Record<string, unknown>;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export type ApiErrorCode = 'NOT_FOUND' | 'INVALID_REQUEST' | 'NOT_IMPLEMENTED' | 'NETWORK' | 'UNKNOWN';

export class ApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export interface Account {
  env: Env;
  AvailableBalance: string; // MTurk GetAccountBalance와 같이 문자열 ("500.00")
}

export interface SaveTemplateRequest {
  id?: string; // 없으면 새로 만든다
  name: string;
  html: string;
}

export interface CreateBatchRequest {
  name: string;
  templateId: string;
  rows: Record<string, string>[]; // CSV 1행 = HIT 1개
  inputColumns: string[];
  settings: HitSettings;
  attentionRule: AttentionRule | null;
  reference?: ReviewReference; // 없으면 majority. 서버가 column ∈ inputColumns를 검증한다
  requiredPoolIds: string[];
  excludedPoolIds: string[];
  answerSchema?: AnswerField[];
}

export type AddAssignmentsMode = number | 'fill-to-target';

export interface AddAssignmentsResult {
  added: { HITId: string; count: number; expirationExtended: boolean }[]; // 만료된 HIT는 게시 기간도 연장한다 (8.3)
  skipped: { HITId: string; reason: string }[]; // 예: 9개 상한 (8.3)
}

export interface ItemResult {
  key: string; // "<rowIndex>:<answerName>"
  rowIndex: number;
  answerName: string;
  votes: string[];
  workers: string[]; // votes와 같은 순서
  majority: string | null; // 동률이면 null
  unanimous: boolean;
}

export interface BatchResults {
  target: number; // batch.settings.MaxAssignments
  items: ItemResult[];
  unanimousRatio: number | null;
  fleissKappa: number | null;
  kappaItemCount: number; // 투표 수가 정확히 target이라 κ 계산에 들어간 문항 수
  labelDistribution: Record<string, number>;
}

export type ExportFormat = 'mturk-csv' | 'labels-json';

export interface ExportFile {
  filename: string;
  mimeType: string;
  content: string;
}
