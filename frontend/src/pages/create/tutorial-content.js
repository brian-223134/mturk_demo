// Create → Tutorial 의 문구. 한국어(ko)와 영어(en)가 같은 구조를 갖는다 (tests/tutorial-content.test.js 가 대조한다).
// 글은 문자열과 표시 토큰의 배열이다: { ui } 화면 글자, { code } 코드, { strong } 강조. 화면 글자와 코드는 두 언어에서 같아야 한다.
// 블록: p, note, flow, table, steps, faq, code, subtitle, actions, examples. 그리는 일은 pages/create/tutorial.js 가 맡는다.

const u = (ui) => ({ ui });
const c = (code) => ({ code });
const b = (strong) => ({ strong });

export const LANGUAGES = [
  { value: 'ko', label: 'KR' },
  { value: 'en', label: 'EN' },
];
export const DEFAULT_LANGUAGE = 'ko';
export const LANGUAGE_KEY = 'mturk-console:tutorial-language';

const LAYOUT_CODE = '<script src="/elements/ann-elements.js"></script>\n<ann-form>\n  <ann-text label="Passage">${passage}</ann-text>\n  <ann-choice name="relevance" header="Is the passage relevant?" required>\n    <ann-option value="relevant">Relevant</ann-option>\n    <ann-option value="not_relevant">Not relevant</ann-option>\n  </ann-choice>\n</ann-form>';

export const TUTORIAL = {
  ko: {
    intro: 'Create에서 annotation 작업을 만들고 worker에게 내보내는 방법을 순서대로 따라 해 봅니다. 단계마다 있는 버튼을 누르면 그 화면으로 바로 갑니다.',
    examples: {
      loading: '예시 prompt를 불러오는 중입니다.',
      label: 'Example prompts',
      empty: '이 서버에는 예시 prompt가 없습니다.',
      unavailable: '예시 prompt는 backend(FastAPI)에 붙었을 때만 불러올 수 있습니다.',
      storage: '브라우저 저장소를 쓸 수 없어 예시를 넘기지 못했습니다. Generate from raw data에서 prompt를 직접 붙여 넣으세요.',
    },
    sections: [
      {
        id: 'tutorial-concepts',
        toc: 'Project와 Batch',
        title: 'Project와 Batch',
        blocks: [
          { p: ['Create는 MTurk의 Requester 화면처럼 두 단계로 나뉩니다. ', b('Project'), '는 어떤 작업인지 정한 틀이고, ', b('Batch'), '는 그 틀에 실제 데이터를 넣어 worker에게 내보낸 한 번의 게시입니다.'] },
          { flow: [{ title: 'New Project', text: '작업의 틀을 만듭니다' }, { title: 'Project', text: '화면 + 속성', accent: true }, { title: 'Publish Batch', text: 'JSON을 올립니다' }, { title: 'Batch', text: '객체 하나 = HIT 하나', accent: true }, { title: 'Manage', text: '검수와 결과' }] },
          {
            table: {
              head: [[''], [u('New Project')], [u('New Batch with an Existing Project')]],
              rows: [
                [['만드는 것'], ['Project: 어떤 작업인지 정한 틀'], ['Batch: 실제 데이터로 내보낸 한 번의 게시']],
                [['담는 것'], ['worker가 보는 화면(layout), 제목·설명, 보상, HIT당 인원, 기간, worker 조건'], ['JSON(객체 하나 = HIT 하나), 이번 게시의 검수 설정(attention, 대조 기준), Batch 이름']],
                [['횟수'], ['작업 종류마다 한 번'], ['같은 Project로 여러 번 (예: 파일럿 20개 → 본 실험 400개)']],
                [['결과'], ['저장만 됩니다. worker에게는 아직 아무것도 나가지 않습니다'], ['Manage에 Batch와 HIT가 생기고, 비용이 잔액에서 빠집니다']],
              ],
            },
          },
          { note: ['Project를 고쳐도 이미 게시한 Batch는 게시할 때의 화면 사본을 갖고 있어서 바뀌지 않습니다.'] },
        ],
      },
      {
        id: 'tutorial-design',
        toc: 'Rough design으로 시작하기',
        title: 'Rough design으로 시작하기',
        blocks: [
          { p: ['화면 배치 가안을 고르고, 이미 HIT로 묶인 데이터를 넣어 worker 화면을 미리 본 뒤 Project로 저장합니다. ', u('New Project'), '의 기본 흐름입니다.'] },
          { actions: [{ open: '/create/new', label: 'New Project 열기', primary: true }, { download: '/example/6-rough-design/chunk-fact-hits.json', file: 'chunk-fact-hits.json', label: '예시 데이터 내려받기' }, { download: '/example/6-rough-design/chunk-fact.binding.json', file: 'chunk-fact.binding.json', label: '예시 binding 내려받기' }] },
          {
            steps: [
              [u('Rough design'), ': 도형으로 그린 가안 5개 중 하나를 고르고 ', u('Next'), '를 누릅니다. 예시 데이터에는 ', u('E. Item by item'), '이 잘 맞습니다.'],
              [u('Task type and preview'), ': ', u('Vision'), ', ', u('Video'), ', ', u('Text'), ' 중 하나를 고르면 예시 자료를 넣은 화면이 보입니다. 예시 데이터에는 ', u('Text'), '를 고르고 ', u('Next'), '를 누릅니다.'],
              [u('HIT data'), ': 내려받은 예시 데이터를 올립니다. 객체 하나가 HIT 하나인 JSON 배열이며, 파일은 브라우저 탭에만 있고 서버로 보내지 않습니다.'],
              ['binding은 어떤 값을 어느 칸에 넣을지 적은 설정입니다. 왼쪽 폼의 드롭다운으로 고르거나, ', u('Upload binding'), '으로 예시 binding을 올리면 HIT 하나에 탭 11개가 보입니다. 위쪽에서 가안을 바꿔 비교하고 HIT 번호를 넘겨 봅니다. JSON으로 고치려면 ', u('Edit as JSON (advanced)'), '를 엽니다.'],
              ['LLM에게 쓰게 하려면 ', u('What should workers judge?'), '에 요청을 적고 ', u('Allow API calls (uses credits)'), '를 체크한 뒤 ', u('Write the binding'), '을 누릅니다. 유료 호출이지만 한 번에 1센트 미만이었습니다.'],
              ['고칠 것이 있으면 ', u('What should change?'), '에 적고 ', u('Revise the binding'), '을 누릅니다. 답마다 바뀐 항목이 보이고, ', u('Restore'), '로 이전 버전으로 돌아갑니다. 가안을 바꾸는 요청은 위쪽의 ', u('Rough design'), ' 버튼으로 안내합니다.'],
              [u('Project name'), '을 확인하고 ', u('Use this design'), '을 누르면 Project가 저장되고, 데이터가 올라간 Publish Batch가 열립니다. 대조 기준과 attention 설정도 binding대로 채워져 있습니다.'],
            ],
          },
          { note: ['worker에게 보이는 글(안내문, 문항, 라벨, 선택지)은 영어로 씁니다. 원본 데이터 파일을 올리는 기능은 아직 없으며, 이미 HIT로 묶인 파일만 받습니다.'] },
        ],
      },
      {
        id: 'tutorial-starter',
        toc: 'Starter로 만들어 게시하기',
        title: 'Starter로 만들어 게시하기',
        blocks: [
          { p: ['연구실에서 자주 쓰는 형태의 starter 템플릿으로 Project를 만들고, attention check가 들어 있는 예시 JSON으로 Batch를 게시해 봅니다.'] },
          { actions: [{ gallery: 'passage-relevance', label: 'Passage relevance 열기', primary: true }, { download: '/example/5-project/passage-relevance.json', file: 'passage-relevance.json', label: '예시 JSON 내려받기', id: 'tutorial-example-json' }] },
          {
            steps: [
              [u('New Project'), '의 ', u('Other ways to start'), ' → ', u('Starter templates'), '에서 ', u('Passage relevance'), '를 고르면 오른쪽에 worker 화면이 표본 데이터로 보입니다. ', u('Submit'), '을 눌러 제출되는 답의 모양도 볼 수 있습니다. ', u('Create Project'), '를 누릅니다.'],
              [u('Enter Properties'), ': worker에게 보일 제목과 설명, 보상($0.05), HIT당 인원(3명), 시간, worker 조건이 채워져 있습니다. 아래에 HIT 하나의 비용이 계산되어 보입니다.'],
              [u('Design Layout'), ': 왼쪽에서 HTML을 고치면 오른쪽 미리보기가 바로 바뀝니다. ', u('Insert element…'), '로 문항을 넣어 보고, ', u('Checks'), '에 오류가 없는지 확인합니다.'],
              [u('Preview and Finish'), '에서 ', u('Finish and publish a batch'), '를 누르면 Project가 저장되고 Publish Batch가 열립니다.'],
              [u('Upload JSON'), '에 내려받은 예시 JSON을 올립니다. ', u('2/2 matched'), '가 보이면 화면이 쓰는 컬럼이 모두 있는 것입니다. 쓰이지 않는 ', c('gold'), ', ', c('attention_expected'), ' 컬럼과 빈 셀 경고는 정상입니다.'],
              [u('Preview tasks'), ': HIT를 넘겨 보면 5번째와 8번째가 질문과 상관없는 passage를 붙인 attention 항목입니다.'],
              [u('Review settings'), ': ', u('Attention check'), '를 켜고 ', u('Expected answers column'), ' → ', c('attention_expected'), '를 고릅니다. ', u('Compare answers with'), '에서는 ', c('gold'), '를 고릅니다.'],
              [u('Confirm and publish'), ': 8 HITs × 3명 × $0.05 = $1.20, 수수료 $0.24, 합계 $1.44를 확인하고 게시하면 Manage의 Overview로 갑니다.'],
            ],
          },
        ],
      },
      {
        id: 'tutorial-generate',
        toc: '원본 데이터에서 자동으로 만들기',
        title: '원본 데이터에서 자동으로 만들기',
        blocks: [
          { p: ['원본 데이터(JSON)와 "무엇을 판정하게 할지" 적은 prompt만 주면 agent가 화면과 HIT 데이터를 만듭니다. LLM은 작업 명세(', c('task_spec.json'), ') 하나만 쓰고, 데이터를 HIT로 자르고 HTML을 그리는 일은 코드가 합니다.'] },
          { flow: [{ title: '원본 + prompt', text: '한 문장이어도 됩니다' }, { title: '후보 3개', text: '모델만 바꿔 동시에 profile → plan → preprocess → render → validate', accent: true }, { title: 'Compare and choose', text: '나란히 비교하고 하나를 고릅니다' }, { title: 'Project + Publish Batch', text: 'HIT 데이터가 올라간 상태', accent: true }] },
          { actions: [{ gallery: 'generate', label: 'Generate from raw data 열기', primary: true }] },
          { subtitle: '예시로 해 보기' },
          { p: ['처음이라면 예시 prompt로 시작합니다. 네 가지 모두 합성 예시 데이터 6개 레코드와 같은 HIT 구성을 쓰고, 판정 기준과 데이터 설명을 적는 방식만 다릅니다(', c('docs/prompt-experiments.md'), '). ', u('Load prompt'), '는 prompt와 이름만, ', u('Load prompt + example data'), '는 합성 예시 원본까지 채운 채로 Generate from raw data를 엽니다. 이미 적어 둔 prompt와 이름은 예시로 바뀝니다.'] },
          { examples: true },
          {
            steps: [
              [u('Name'), '에 이름을 적고, ', u('Raw data'), '에 원본을, ', u('Prompt text'), '에 무엇을 판정하게 할지 적습니다. 예: "chunk 하나를 보여주고 atomic fact 중 그 chunk가 지지하는 걸 전부 고르게 하자. BM25 top-10, HIT 20개"'],
              [u('Models for the candidates'), '에서 후보 A, B, C가 쓸 모델을 고릅니다. 처음에는 서로 다른 모델 세 개가 골라져 있습니다. 모든 모델이 temperature 0이라 같은 모델을 두 번 고르면 거의 같은 후보가 나옵니다.'],
              [u('Allow API calls (uses credits)'), '를 체크하고 ', u('Generate 3 candidates'), '를 누릅니다. 유료 호출이라 ', c('environment/.env'), '에 ', c('AGENT_ALLOW_API=1'), '을 적고 backend를 다시 시작해 둬야 체크할 수 있습니다. 후보 세 개가 동시에 돌기 때문에 비용은 후보마다 1센트 안팎씩 들고, 시간은 가장 늦은 후보만큼(2~4분) 걸립니다. 일부 후보는 실패할 수도 있습니다.'],
              ['아래 ', u('Templates'), ' 목록에 후보 세 개가 카드 하나로 묶여 보입니다. 후보마다 진행 단계, HIT 수, 비용이 보이고, ', u('Details'), '에서 검증 결과와 파일을 봅니다.'],
              ['모두 끝나면 ', u('Compare and choose'), '를 누릅니다. 성공한 후보의 명세(', u('Task spec'), ')와 worker 화면이 나란히 열립니다. 안내문의 기준이 정답 라벨과 맞는지, HIT 구성이 요청대로인지 비교합니다.'],
              ['마음에 드는 후보의 ', u('Choose this template'), '을 누릅니다. 이름으로 Project가 저장되고, HIT 데이터가 올라간 Publish Batch가 열립니다. attention과 대조 기준 설정도 채워져 있습니다. 고른 후보에는 ', u('Chosen'), '이 표시됩니다.'],
              ['명세를 고쳐야 하면 후보의 ', u('Details'), ' → ', u('Files'), '에서 ', c('task_spec.json'), '을 내려받아 고치고, ', u('Reuse inputs'), '를 누른 뒤 ', u('Optional task spec · offline replay'), '에 고친 파일을 올려 다시 ', u('Generate'), '합니다. LLM을 부르지 않으므로 후보 없이 job 하나만 만들어지고, 비용이 없으며 몇 초면 끝납니다. 그 카드의 ', u('Use this result'), '로 Project를 만듭니다.'],
            ],
          },
          { note: ['Templates 목록의 후보는 Project가 아닙니다. 목록은 Generate from raw data 안에만 있고, 같은 이름의 Project가 있으면 후보를 고를 때 그 Project를 덮어씁니다. 시도마다 다른 이름을 쓰세요.'] },
        ],
      },
      {
        id: 'tutorial-previews',
        toc: '단계별 미리보기',
        title: '단계별 미리보기',
        blocks: [
          { p: ['worker 화면을 미리 보는 곳이 네 군데 있고, 보는 시점과 데이터가 다릅니다.'] },
          {
            table: {
              head: [['어디서'], ['화면'], ['보는 것']],
              rows: [
                [[u('HIT data')], ['New Project → 가안 → Task 종류 → 세 번째 단계'], ['Project를 만들기 전에, 올린 데이터를 가안에 넣은 worker 화면. 가안과 HIT를 바꿔 봅니다']],
                [[u('Compare and choose')], ['New Project → Generate from raw data → Templates의 후보 카드'], ['후보마다 LLM에 준 prompt, LLM이 쓴 명세, HIT 한 행의 worker 화면. 나란히 비교하고 Project로 쓸 후보를 고릅니다']],
                [[u('Preview and Finish')], ['Project 목록의 Edit → 세 번째 탭'], ['Project의 속성 요약과, 표본 값으로 그린 worker 화면']],
                [[u('Preview tasks')], ['Project 목록의 Publish Batch → 두 번째 단계'], ['올린 데이터의 HIT를 하나씩 넣은 실제 worker 화면']],
              ],
            },
          },
          { note: ['어느 미리보기에서든 Submit을 누르면 실제로 제출되지 않고, 제출되었을 답을 보여 줍니다.'] },
        ],
      },
      {
        id: 'tutorial-layout',
        toc: '템플릿 직접 고치기',
        title: '템플릿 직접 고치기',
        blocks: [
          { p: ['starter는 콘솔이 제공하는 ', c('<ann-*>'), ' 요소로 쓴 짧은 HTML입니다. 요소가 문항을 그리고, 필수 문항을 검사하고, Review가 읽는 형식으로 답을 제출합니다.'] },
          { code: LAYOUT_CODE },
          {
            steps: [
              [c('${passage}'), '처럼 쓴 자리에 HIT 데이터의 같은 이름 키 값이 들어갑니다.'],
              ['문항의 ', c('name'), '이 답 이름이 되어 Review와 결과 CSV에 나옵니다. 문항마다 달라야 합니다.'],
              [u('Design Layout'), '의 ', u('Element reference'), '에 요소와 속성이 정리되어 있고, ', u('Insert element…'), '로 예시를 넣을 수 있습니다.'],
            ],
          },
          { note: ['자동 생성 결과는 아직 crowd-form 방식(25KB 안팎)이라 직접 고치기 어렵습니다. 크게 바꿀 때는 명세를 고쳐 다시 만드는 편이 쉽습니다.'] },
        ],
      },
      {
        id: 'tutorial-faq',
        toc: 'Pre Q&A',
        title: 'Pre Q&A',
        blocks: [
          { p: ['헷갈리기 쉬운 부분을 미리 질문과 답으로 정리했습니다.'] },
          {
            faq: [
              { q: 'Project를 고치면 이미 게시한 Batch도 바뀌나요?', a: ['아니요. Batch는 게시할 때의 화면 사본을 따로 갖고 있습니다.'] },
              { q: 'binding이 무엇인가요?', a: ['어떤 값을 가안의 어느 칸에 넣을지 적은 JSON입니다. 화면은 코드가 만들기 때문에, 사람이 쓰든 LLM이 쓰든 답 형식과 Review 호환은 같습니다.'] },
              { q: 'attention check는 어떻게 넣나요?', a: ['HIT 데이터에 attention 항목을 섞고, 그 항목의 기대 답을 ', c('{"answer name": "expected value"}'), ' 모양으로 한 키에 적습니다. Review settings에서 그 컬럼을 고르면 Review가 통과 여부를 판정합니다. 자동 생성 결과에는 이 컬럼(', c('attention_expected'), ')이 이미 들어 있습니다. Rough design에서는 binding의 ', c('attention'), '이 이 컬럼을 만듭니다.'] },
              { q: '정답이나 LLM 라벨과 비교하려면?', a: ['Review settings의 ', u('Compare answers with'), '에서 그 값이 든 컬럼을 고릅니다. 고르지 않으면 같은 HIT를 한 다른 worker들의 majority와 비교합니다. Rough design에서는 binding의 ', c('reference'), '가 이 컬럼을 만듭니다.'] },
              { q: 'Templates 목록에서 오래된 후보를 빼려면?', a: ['화면에는 지우는 버튼이 없습니다. ', c('output/jobs/'), '의 job 폴더를 다른 곳(예: ', c('output/jobs-archive/'), ')으로 옮기고 backend를 다시 시작합니다.'] },
              { q: '더 자세한 설명은?', a: ['저장소의 ', c('docs/create-projects.md'), '(화면별 설명)와 ', c('docs/annotation-elements.md'), '(요소 설명)를 봅니다.'] },
            ],
          },
        ],
      },
    ],
  },
  en: {
    intro: 'Follow these steps to create an annotation task in Create and send it to workers. The button in each step takes you straight to that screen.',
    examples: {
      loading: 'Loading example prompts…',
      label: 'Example prompts',
      empty: 'This server has no example prompts.',
      unavailable: 'Example prompts are available only when the console is connected to the backend (FastAPI).',
      storage: 'The browser storage is not available, so the example could not be passed on. Paste the prompt into Generate from raw data yourself.',
    },
    sections: [
      {
        id: 'tutorial-concepts',
        toc: 'Projects and batches',
        title: 'Projects and batches',
        blocks: [
          { p: ['Like the MTurk Requester website, Create has two stages. A ', b('Project'), ' is the frame that defines the task, and a ', b('Batch'), ' is one publication of that frame with real data, sent to workers.'] },
          { flow: [{ title: 'New Project', text: 'Build the frame of the task' }, { title: 'Project', text: 'Page + properties', accent: true }, { title: 'Publish Batch', text: 'Upload a JSON file' }, { title: 'Batch', text: 'One object = one HIT', accent: true }, { title: 'Manage', text: 'Review and results' }] },
          {
            table: {
              head: [[''], [u('New Project')], [u('New Batch with an Existing Project')]],
              rows: [
                [['What it makes'], ['A Project: the frame that defines the task'], ['A Batch: one publication with real data']],
                [['What it holds'], ['The page workers see (layout), title and description, reward, workers per HIT, time, worker requirements'], ['The JSON file (one object = one HIT), the review settings of this batch (attention, reference), the batch name']],
                [['How often'], ['Once per kind of task'], ['Many times from one Project (for example, a pilot of 20, then a main run of 400)']],
                [['Result'], ['It is only saved. Nothing goes out to workers yet'], ['The batch and its HITs appear in Manage, and the cost is taken from the balance']],
              ],
            },
          },
          { note: ['Editing a Project does not change batches already published, because each batch keeps its own copy of the page.'] },
        ],
      },
      {
        id: 'tutorial-design',
        toc: 'Start from a rough design',
        title: 'Start from a rough design',
        blocks: [
          { p: ['Choose a page layout, put in data that is already grouped into HITs, preview the worker page, and save it as a Project. This is the main path in ', u('New Project'), '.'] },
          { actions: [{ open: '/create/new', label: 'Open New Project', primary: true }, { download: '/example/6-rough-design/chunk-fact-hits.json', file: 'chunk-fact-hits.json', label: 'Download the example data' }, { download: '/example/6-rough-design/chunk-fact.binding.json', file: 'chunk-fact.binding.json', label: 'Download the example binding' }] },
          {
            steps: [
              [u('Rough design'), ': choose one of the five layouts drawn as shapes and press ', u('Next'), '. ', u('E. Item by item'), ' suits the example data.'],
              [u('Task type and preview'), ': choose ', u('Vision'), ', ', u('Video'), ' or ', u('Text'), ' to see the page with sample material. For the example data, choose ', u('Text'), ' and press ', u('Next'), '.'],
              [u('HIT data'), ': upload the example data. It is a JSON array with one object per HIT. The file stays in your browser tab and is not sent to the server.'],
              ['A binding says which value goes into which slot. Choose values from the dropdowns in the form on the left, or upload the example binding with ', u('Upload binding'), ' to see 11 tabs per HIT. Switch layouts at the top to compare them, and move between HITs. To edit the JSON, open ', u('Edit as JSON (advanced)'), '.'],
              ['To let the LLM write it, enter your request in ', u('What should workers judge?'), ', check ', u('Allow API calls (uses credits)'), ' and press ', u('Write the binding'), '. These calls are paid, but each cost under one cent.'],
              ['To change something, describe it in ', u('What should change?'), ' and press ', u('Revise the binding'), '. Each answer lists what changed, and ', u('Restore'), ' goes back to an earlier version. A request for another layout is pointed to the ', u('Rough design'), ' buttons at the top.'],
              ['Check the ', u('Project name'), ' and press ', u('Use this design'), '. The Project is saved and Publish Batch opens with the data loaded. The reference and attention settings are filled in from the binding.'],
            ],
          },
          { note: ['Text that workers see (instructions, questions, labels, options) is written in English. Uploading raw data files here is not available yet; only files already grouped into HITs are accepted.'] },
        ],
      },
      {
        id: 'tutorial-starter',
        toc: 'Publish from a starter',
        title: 'Publish from a starter',
        blocks: [
          { p: ['Create a Project from a starter template in a form the lab often uses, then publish a batch with an example JSON file that includes attention checks.'] },
          { actions: [{ gallery: 'passage-relevance', label: 'Open Passage relevance', primary: true }, { download: '/example/5-project/passage-relevance.json', file: 'passage-relevance.json', label: 'Download the example JSON', id: 'tutorial-example-json' }] },
          {
            steps: [
              ['In ', u('New Project'), ', go to ', u('Other ways to start'), ' → ', u('Starter templates'), ' and choose ', u('Passage relevance'), '. The worker page appears on the right with sample data. Press ', u('Submit'), ' to see what the answers look like, then press ', u('Create Project'), '.'],
              [u('Enter Properties'), ': the title and description workers see, the reward ($0.05), workers per HIT (3), the time and the worker requirements are filled in. The cost of one HIT is calculated below.'],
              [u('Design Layout'), ': edit the HTML on the left and the preview on the right changes at once. Try adding a question with ', u('Insert element…'), ' and make sure ', u('Checks'), ' shows no errors.'],
              ['In ', u('Preview and Finish'), ', press ', u('Finish and publish a batch'), '. The Project is saved and Publish Batch opens.'],
              ['Upload the example JSON in ', u('Upload JSON'), '. ', u('2/2 matched'), ' means every column the page reads is there. The warnings about the unused ', c('gold'), ' and ', c('attention_expected'), ' columns and about empty cells are normal.'],
              [u('Preview tasks'), ': move through the HITs. The 5th and 8th are attention items that pair the question with an unrelated passage.'],
              [u('Review settings'), ': turn on ', u('Attention check'), ' and choose ', u('Expected answers column'), ' → ', c('attention_expected'), '. In ', u('Compare answers with'), ', choose ', c('gold'), '.'],
              [u('Confirm and publish'), ': check 8 HITs × 3 workers × $0.05 = $1.20, a $0.24 fee, $1.44 in total, then publish. You land on the Overview in Manage.'],
            ],
          },
        ],
      },
      {
        id: 'tutorial-generate',
        toc: 'Generate from raw data',
        title: 'Generate from raw data',
        blocks: [
          { p: ['Give raw data (JSON) and a prompt that says what to judge, and the agent makes the page and the HIT data. The LLM writes only the task spec (', c('task_spec.json'), '); code cuts the data into HITs and draws the HTML.'] },
          { flow: [{ title: 'Raw data + prompt', text: 'One sentence is enough' }, { title: 'Three candidates', text: 'Different models, at the same time: profile → plan → preprocess → render → validate', accent: true }, { title: 'Compare and choose', text: 'Compare side by side and choose one' }, { title: 'Project + Publish Batch', text: 'With the HIT data loaded', accent: true }] },
          { actions: [{ gallery: 'generate', label: 'Open Generate from raw data', primary: true }] },
          { subtitle: 'Try an example' },
          { p: ['If this is your first time, start from an example prompt. All four use the same HIT setup over six synthetic records; they differ only in how they state the criteria and describe the data (', c('docs/prompt-experiments.md'), '). ', u('Load prompt'), ' fills in the prompt and the name, and ', u('Load prompt + example data'), ' also fills in the synthetic raw data, then Generate from raw data opens. A prompt and name you already wrote are replaced by the example.'] },
          { examples: true },
          {
            steps: [
              ['Enter a name in ', u('Name'), ', the raw data in ', u('Raw data'), ', and what to judge in ', u('Prompt text'), '. For example: "Show one chunk and have workers pick every atomic fact that chunk supports. BM25 top-10, 20 HITs."'],
              ['In ', u('Models for the candidates'), ', choose the models for candidates A, B and C. Three different models are chosen at first. Every model runs at temperature 0, so choosing the same model twice gives nearly the same candidate.'],
              ['Check ', u('Allow API calls (uses credits)'), ' and press ', u('Generate 3 candidates'), '. These calls are paid, so you can check the box only after adding ', c('AGENT_ALLOW_API=1'), ' to ', c('environment/.env'), ' and restarting the backend. Each candidate costs around one cent, and the time is that of the slowest candidate (2 to 4 minutes). Some candidates may fail.'],
              ['The three candidates appear as one card in the ', u('Templates'), ' list below. Each shows its progress, HIT count and cost, and ', u('Details'), ' has the validation result and the files.'],
              ['When they finish, press ', u('Compare and choose'), '. The specs (', u('Task spec'), ') and worker pages of the successful candidates open side by side. Check that the criteria in the instructions match the labels and that the HITs are what you asked for.'],
              ['Press ', u('Choose this template'), ' on the candidate you like. A Project is saved under the name, and Publish Batch opens with the HIT data loaded and the attention and reference settings filled in. The chosen candidate is marked ', u('Chosen'), '.'],
              ['To correct a spec, download ', c('task_spec.json'), ' from ', u('Details'), ' → ', u('Files'), ' of the candidate and edit it. Press ', u('Reuse inputs'), ', upload the edited file in ', u('Optional task spec · offline replay'), ' and press ', u('Generate'), ' again. No LLM is called, so one job is made instead of candidates, at no cost, in a few seconds. Make the Project with ', u('Use this result'), ' on its card.'],
            ],
          },
          { note: ['Candidates in the Templates list are not Projects. The list exists only inside Generate from raw data, and choosing a candidate overwrites a Project with the same name. Use a different name for each attempt.'] },
        ],
      },
      {
        id: 'tutorial-previews',
        toc: 'Previews at each stage',
        title: 'Previews at each stage',
        blocks: [
          { p: ['You can preview the worker page in four places. They differ in when you see it and with what data.'] },
          {
            table: {
              head: [['Where'], ['Screen'], ['What you see']],
              rows: [
                [[u('HIT data')], ['New Project → layout → task type → third step'], ['Before a Project exists, the worker page with your data in the layout. Try other layouts and HITs']],
                [[u('Compare and choose')], ['New Project → Generate from raw data → candidate card in Templates'], ['For each candidate, the prompt given to the LLM, the spec it wrote, and the worker page of one HIT. Compare them and choose one for the Project']],
                [[u('Preview and Finish')], ['Edit in the Project list → third tab'], ['A summary of the Project properties, and the worker page drawn with sample values']],
                [[u('Preview tasks')], ['Publish Batch in the Project list → second step'], ['The real worker page for each HIT of the uploaded data']],
              ],
            },
          },
          { note: ['In every preview, Submit sends nothing. It shows the answers that would have been submitted.'] },
        ],
      },
      {
        id: 'tutorial-layout',
        toc: 'Edit a template yourself',
        title: 'Edit a template yourself',
        blocks: [
          { p: ['A starter is short HTML written with the ', c('<ann-*>'), ' elements of this console. The elements draw the questions, check required answers and submit answers in the format Review reads.'] },
          { code: LAYOUT_CODE },
          {
            steps: [
              ['A place written like ', c('${passage}'), ' receives the value of the key with the same name in the HIT data.'],
              ['The ', c('name'), ' of a question becomes the answer name in Review and in the results CSV. Each question needs its own.'],
              ['The ', u('Element reference'), ' in ', u('Design Layout'), ' lists the elements and their attributes, and ', u('Insert element…'), ' adds examples.'],
            ],
          },
          { note: ['Generated results still use crowd-form (around 25 KB) and are hard to edit by hand. For big changes, correct the spec and generate again.'] },
        ],
      },
      {
        id: 'tutorial-faq',
        toc: 'Pre Q&A',
        title: 'Pre Q&A',
        blocks: [
          { p: ['Answers to the questions that come up most often.'] },
          {
            faq: [
              { q: 'Does editing a Project change batches already published?', a: ['No. Each batch keeps its own copy of the page from when it was published.'] },
              { q: 'What is a binding?', a: ['A JSON object that says which value goes into which slot of a layout. Code draws the page, so the answer format and Review work the same whether a person or the LLM wrote it.'] },
              { q: 'How do I add attention checks?', a: ['Mix attention items into the HIT data and write their expected answers under one key, in the form ', c('{"answer name": "expected value"}'), '. Choose that column in Review settings and Review decides who passed. Generated results already include this column (', c('attention_expected'), '). With a rough design, ', c('attention'), ' in the binding makes this column.'] },
              { q: 'How do I compare answers with gold or LLM labels?', a: ['In Review settings, choose the column with those values in ', u('Compare answers with'), '. Otherwise answers are compared with the majority of the other workers on the same HIT. With a rough design, ', c('reference'), ' in the binding makes this column.'] },
              { q: 'How do I remove old candidates from the Templates list?', a: ['The screen has no delete button. Move the job folder out of ', c('output/jobs/'), ' (for example, to ', c('output/jobs-archive/'), ') and restart the backend.'] },
              { q: 'Where can I read more?', a: [c('docs/create-projects.md'), ' (each screen) and ', c('docs/annotation-elements.md'), ' (the elements) in the repository. They are written in Korean.'] },
            ],
          },
        ],
      },
    ],
  },
};

/** 보여 줄 언어: 주소의 ?lang= → 저장해 둔 값 → 기본(ko). 모르는 값은 건너뛴다. */
export function tutorialLanguage(search, stored) {
  const known = (value) => LANGUAGES.some((language) => language.value === value);
  const fromUrl = new URLSearchParams(search ?? '').get('lang');
  if (known(fromUrl)) return fromUrl;
  return known(stored) ? stored : DEFAULT_LANGUAGE;
}
