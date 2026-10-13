// Create → Tutorial (/create/tutorial): Create 를 처음 쓰는 사람이 순서대로 따라 하는 안내 페이지. 읽는 사람이 연구실 구성원이라
// 설명은 한국어로 쓰고, 버튼·탭 같은 화면 글자는 영어 그대로 적는다 (docs/create-projects.md 와 같은 방식).
// 단계마다 그 화면으로 바로 가는 버튼이 있다: 갤러리의 항목을 미리 골라 두고(presetChoice) 이동하거나, 예시 파일을 내려받는다.
// 화면별 자세한 설명은 저장소의 docs/create-projects.md 에 있다.

import { el } from '../../components/dom.js';
import { navigate } from '../../router.js';
import { createSubnav } from './common.js';
import { presetChoice } from './new-project.js';

const EXAMPLE_CSV = '/example/5-project/passage-relevance.csv';

const code = (text) => el('code', {}, text);
const ui = (text) => el('code', { className: 'tutorial-ui' }, text);

/** 갤러리에서 choice 를 골라 둔 채로 New Project 를 연다. */
function openGallery(choice, label) {
  return el(
    'button',
    {
      type: 'button',
      className: 'btn btn-small btn-primary',
      dataset: { open: choice },
      onClick: () => {
        presetChoice(choice);
        navigate('/create/new');
      },
    },
    label,
  );
}

function section(id, number, title, ...children) {
  return el(
    'section',
    { className: 'panel tutorial-section', id },
    el('h3', { className: 'panel-title' }, number ? el('span', { className: 'tutorial-number' }, String(number)) : null, title),
    ...children,
  );
}

function steps(items) {
  return el('ol', { className: 'tutorial-steps' }, items.map((item) => el('li', {}, item)));
}

function simpleTable(head, rows) {
  return el(
    'table',
    { className: 'table tutorial-table' },
    el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell) => el('td', {}, cell))))),
  );
}

/** 흐름 그림: 상자와 화살표. */
function flow(boxes) {
  const parts = [];
  boxes.forEach((box, index) => {
    if (index > 0) parts.push(el('span', { className: 'tutorial-arrow', 'aria-hidden': 'true' }, '→'));
    parts.push(el('div', { className: `tutorial-box${box.accent ? ' accent' : ''}` }, el('strong', {}, box.title), box.text ? el('span', { className: 'muted small' }, box.text) : null));
  });
  return el('div', { className: 'tutorial-flow' }, parts);
}

export function renderTutorial(root) {
  const toc = [
    ['tutorial-concepts', 'Project와 Batch'],
    ['tutorial-starter', 'starter로 만들어 게시하기'],
    ['tutorial-generate', '원본 데이터에서 자동으로 만들기'],
    ['tutorial-previews', '단계별 미리보기'],
    ['tutorial-layout', '템플릿 직접 고치기'],
    ['tutorial-faq', 'Pre Q&A'],
  ];

  root.append(
    el('div', { className: 'page-header' }, el('h2', { className: 'page-title' }, 'Create')),
    createSubnav('tutorial'),
    el(
      'div',
      { className: 'panel tutorial-intro' },
      el('p', {}, 'Create에서 annotation 작업을 만들고 worker에게 내보내는 방법을 순서대로 따라 해 봅니다. 단계마다 있는 버튼을 누르면 그 화면으로 바로 갑니다.'),
      el('nav', { className: 'tutorial-toc', 'aria-label': 'Tutorial' }, toc.map(([id, label], index) => el('a', { href: `#${id}`, dataset: { external: '' }, onClick: (event) => {
        event.preventDefault();
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } }, `${index + 1}. ${label}`))),
    ),

    section(
      'tutorial-concepts',
      1,
      'Project와 Batch',
      el('p', {}, 'Create는 MTurk의 Requester 화면처럼 두 단계로 나뉩니다. ', el('strong', {}, 'Project'), '는 어떤 작업인지 정한 틀이고, ', el('strong', {}, 'Batch'), '는 그 틀에 실제 데이터를 넣어 worker에게 내보낸 한 번의 게시입니다.'),
      flow([
        { title: 'New Project', text: '작업의 틀을 만듭니다' },
        { title: 'Project', text: '화면 + 속성', accent: true },
        { title: 'Publish Batch', text: 'CSV를 올립니다' },
        { title: 'Batch', text: '한 행 = HIT 하나', accent: true },
        { title: 'Manage', text: '검수와 결과' },
      ]),
      simpleTable(
        ['', ui('New Project'), ui('New Batch with an Existing Project')],
        [
          ['만드는 것', 'Project: 어떤 작업인지 정한 틀', 'Batch: 실제 데이터로 내보낸 한 번의 게시'],
          ['담는 것', 'worker가 보는 화면(layout), 제목·설명, 보상, HIT당 인원, 기간, worker 조건', 'CSV(한 행 = HIT 하나), 이번 게시의 검수 설정(attention, 대조 기준), Batch 이름'],
          ['횟수', '작업 종류마다 한 번', '같은 Project로 여러 번 (예: 파일럿 20개 → 본 실험 400개)'],
          ['결과', '저장만 됩니다. worker에게는 아직 아무것도 나가지 않습니다', 'Manage에 Batch와 HIT가 생기고, 비용이 잔액에서 빠집니다'],
        ],
      ),
      el('p', { className: 'muted' }, 'Project를 고쳐도 이미 게시한 Batch는 게시할 때의 화면 사본을 갖고 있어서 바뀌지 않습니다.'),
    ),

    section(
      'tutorial-starter',
      2,
      'starter로 만들어 게시하기',
      el('p', {}, '연구실에서 자주 쓰는 형태의 starter 템플릿으로 Project를 만들고, attention check가 들어 있는 예시 CSV로 Batch를 게시해 봅니다.'),
      el('div', { className: 'tutorial-actions' }, openGallery('passage-relevance', 'Passage relevance 열기'), el('a', { href: EXAMPLE_CSV, download: 'passage-relevance.csv', className: 'btn btn-small', id: 'tutorial-example-csv' }, '예시 CSV 내려받기')),
      steps([
        [ui('New Project'), '에서 ', ui('Passage relevance'), '를 고르면 오른쪽에 worker 화면이 표본 데이터로 보입니다. ', ui('Submit'), '을 눌러 제출되는 답의 모양도 볼 수 있습니다. ', ui('Create Project'), '를 누릅니다.'],
        [ui('Enter Properties'), ': worker에게 보일 제목과 설명, 보상($0.05), HIT당 인원(3명), 시간, worker 조건이 채워져 있습니다. 아래에 HIT 하나의 비용이 계산되어 보입니다.'],
        [ui('Design Layout'), ': 왼쪽에서 HTML을 고치면 오른쪽 미리보기가 바로 바뀝니다. ', ui('Insert element…'), '로 문항을 넣어 보고, ', ui('Checks'), '에 오류가 없는지 확인합니다.'],
        [ui('Preview and Finish'), '에서 ', ui('Finish and publish a batch'), '를 누르면 Project가 저장되고 Publish Batch가 열립니다.'],
        [ui('Upload CSV'), '에 내려받은 예시 CSV를 올립니다. ', ui('2/2 matched'), '가 보이면 화면이 쓰는 컬럼이 모두 있는 것입니다. 쓰이지 않는 ', code('gold'), ', ', code('attention_expected'), ' 컬럼과 빈 셀 경고는 정상입니다.'],
        [ui('Preview tasks'), ': 행을 넘겨 보면 5행과 8행이 질문과 상관없는 passage를 붙인 attention 행입니다.'],
        [ui('Review settings'), ': ', ui('Attention check'), '를 켜고 ', ui('Expected answers column'), ' → ', code('attention_expected'), '를 고릅니다. ', ui('Compare answers with'), '에서는 ', code('gold'), '를 고릅니다.'],
        [ui('Confirm and publish'), ': 8 HITs × 3명 × $0.05 = $1.20, 수수료 $0.24, 합계 $1.44를 확인하고 게시하면 Manage의 Overview로 갑니다.'],
      ]),
    ),

    section(
      'tutorial-generate',
      3,
      '원본 데이터에서 자동으로 만들기',
      el('p', {}, '원본 데이터(JSON, JSONL, CSV)와 "무엇을 판정하게 할지" 적은 prompt만 주면 agent가 화면과 HIT CSV를 만듭니다. LLM은 작업 명세(', code('task_spec.json'), ') 하나만 쓰고, 데이터를 HIT로 자르고 HTML을 그리는 일은 코드가 합니다.'),
      flow([
        { title: '원본 + prompt', text: '한 문장이어도 됩니다' },
        { title: 'job', text: 'profile → plan → preprocess → render → validate', accent: true },
        { title: 'Use this result', text: '' },
        { title: 'Project + Publish Batch', text: 'CSV가 올라간 상태', accent: true },
      ]),
      el('div', { className: 'tutorial-actions' }, openGallery('generate', 'Generate from raw data 열기')),
      steps([
        [ui('Candidate name'), '에 이름을 적고, ', ui('Raw data'), '에 원본을, ', ui('Prompt text'), '에 무엇을 판정하게 할지 적습니다. 예: "chunk 하나를 보여주고 atomic fact 중 그 chunk가 지지하는 걸 전부 고르게 하자. BM25 top-10, HIT 20개"'],
        [ui('Allow API calls (uses credits)'), '를 체크하고 ', ui('Generate'), '를 누릅니다. 유료 호출이라 ', code('environment/.env'), '에 ', code('AGENT_ALLOW_API=1'), '을 적고 backend를 다시 시작해 둬야 체크할 수 있습니다. 한 번에 1센트 안팎이 들고 2~4분 걸리며, 실패할 수도 있습니다.'],
        ['아래 ', ui('Templates'), ' 목록의 카드에서 진행 상황을 봅니다. 끝나면 HIT 수, 정답 라벨 분포, 검증 결과, LLM 비용이 보입니다.'],
        [ui('Preview & evaluate'), '로 LLM이 쓴 명세(', ui('Task spec'), ')와 worker 화면을 검토합니다. 안내문의 기준이 정답 라벨과 맞는지, HIT 구성이 요청대로인지 봅니다.'],
        ['명세를 고쳐야 하면 카드의 ', ui('Files'), '에서 ', code('task_spec.json'), '을 내려받아 고치고, ', ui('Reuse inputs'), '를 누른 뒤 ', ui('Optional task spec · offline replay'), '에 고친 파일을 올려 다시 ', ui('Generate'), '합니다. LLM을 부르지 않으므로 비용이 없고 몇 초면 끝납니다.'],
        ['결과가 마음에 들면 ', ui('Use this result'), '를 누릅니다. job 이름으로 Project가 저장되고, CSV가 올라간 Publish Batch가 열립니다. attention과 대조 기준 설정도 채워져 있습니다.'],
      ]),
      el('p', { className: 'muted' }, 'job은 Project가 아닙니다. job 목록은 Generate from raw data 안에만 있고, 같은 이름의 Project가 있으면 Use this result가 그 Project를 덮어씁니다. 시도마다 다른 이름을 쓰세요.'),
    ),

    section(
      'tutorial-previews',
      4,
      '단계별 미리보기',
      el('p', {}, 'worker 화면을 미리 보는 곳이 세 군데 있고, 보는 시점과 데이터가 다릅니다.'),
      simpleTable(
        ['어디서', '화면', '보는 것'],
        [
          [ui('Preview & evaluate'), 'New Project → Generate from raw data → job 카드', 'LLM에 준 prompt, LLM이 쓴 명세, HIT 한 행의 worker 화면. Project로 쓰기 전에 검토합니다'],
          [ui('Preview and Finish'), 'Project 목록의 Edit → 세 번째 탭', 'Project의 속성 요약과, 표본 값으로 그린 worker 화면'],
          [ui('Preview tasks'), 'Project 목록의 Publish Batch → 두 번째 단계', '올린 CSV의 행을 하나씩 넣은 실제 worker 화면'],
        ],
      ),
      el('p', { className: 'muted' }, '어느 미리보기에서든 Submit을 누르면 실제로 제출되지 않고, 제출되었을 답을 보여 줍니다.'),
    ),

    section(
      'tutorial-layout',
      5,
      '템플릿 직접 고치기',
      el('p', {}, 'starter는 콘솔이 제공하는 ', code('<ann-*>'), ' 요소로 쓴 짧은 HTML입니다. 요소가 문항을 그리고, 필수 문항을 검사하고, Review가 읽는 형식으로 답을 제출합니다.'),
      el('pre', { className: 'pre tutorial-code' }, '<script src="/elements/ann-elements.js"></script>\n<ann-form>\n  <ann-text label="Passage">${passage}</ann-text>\n  <ann-choice name="relevance" header="Is the passage relevant?" required>\n    <ann-option value="relevant">Relevant</ann-option>\n    <ann-option value="not_relevant">Not relevant</ann-option>\n  </ann-choice>\n</ann-form>'),
      steps([
        [code('${passage}'), '처럼 쓴 자리에 CSV의 같은 이름 컬럼 값이 들어갑니다.'],
        ['문항의 ', code('name'), '이 답 이름이 되어 Review와 결과 CSV에 나옵니다. 문항마다 달라야 합니다.'],
        [ui('Design Layout'), '의 ', ui('Element reference'), '에 요소와 속성이 정리되어 있고, ', ui('Insert element…'), '로 예시를 넣을 수 있습니다.'],
      ]),
      el('p', { className: 'muted' }, '자동 생성 결과는 아직 crowd-form 방식(25KB 안팎)이라 직접 고치기 어렵습니다. 크게 바꿀 때는 명세를 고쳐 다시 만드는 편이 쉽습니다.'),
    ),

    section(
      'tutorial-faq',
      6,
      'Pre Q&A',
      el('p', {}, '헷갈리기 쉬운 부분을 미리 질문과 답으로 정리했습니다.'),
      el(
        'dl',
        { className: 'tutorial-faq' },
        el('dt', {}, 'Project를 고치면 이미 게시한 Batch도 바뀌나요?'),
        el('dd', {}, '아니요. Batch는 게시할 때의 화면 사본을 따로 갖고 있습니다.'),
        el('dt', {}, 'attention check는 어떻게 넣나요?'),
        el('dd', {}, 'CSV에 attention 행을 섞고, 그 행의 기대 답을 ', code('{"답 이름": "기대 값"}'), ' 모양으로 한 컬럼에 적습니다. Review settings에서 그 컬럼을 고르면 Review가 통과 여부를 판정합니다. 자동 생성 결과에는 이 컬럼(', code('attention_expected'), ')이 이미 들어 있습니다.'),
        el('dt', {}, '정답이나 LLM 라벨과 비교하려면?'),
        el('dd', {}, 'Review settings의 ', ui('Compare answers with'), '에서 그 값이 든 컬럼을 고릅니다. 고르지 않으면 같은 HIT를 한 다른 worker들의 majority와 비교합니다.'),
        el('dt', {}, 'job 목록에서 오래된 job을 빼려면?'),
        el('dd', {}, '화면에는 지우는 버튼이 없습니다. ', code('output/jobs/'), '의 job 폴더를 다른 곳(예: ', code('output/jobs-archive/'), ')으로 옮기고 backend를 다시 시작합니다.'),
        el('dt', {}, '더 자세한 설명은?'),
        el('dd', {}, '저장소의 ', code('docs/create-projects.md'), '(화면별 설명)와 ', code('docs/annotation-elements.md'), '(요소 설명)를 봅니다.'),
      ),
    ),
  );
  return undefined;
}
