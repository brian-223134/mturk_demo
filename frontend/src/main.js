// 시작점: 레이아웃을 그리고 라우터에 페이지를 등록한다.

import { createLayout } from './components/layout.js';
import * as batch from './pages/batch.js';
import * as create from './pages/create.js';
import * as manage from './pages/manage.js';
import * as workers from './pages/workers.js';
import { configure, route, start } from './router.js';

const layout = createLayout(document.getElementById('app'));

configure({ container: layout.content, onNavigate: (tab) => layout.setActive(tab) });

route('/', null, { redirect: '/create' });
route('/index.html', null, { redirect: '/create' });
route('/create', create.render, { tab: 'create' });
route('/manage', manage.render, { tab: 'manage' });
route('/manage/:batchId', batch.render, { tab: 'manage' });
route('/manage/:batchId/:tab', batch.render, { tab: 'manage' });
route('/workers', workers.render, { tab: 'workers' });
route('/workers/pools', workers.renderPools, { tab: 'workers' }); // :workerId 보다 먼저 (등록 순서대로 맞춘다)
route('/workers/:workerId', workers.renderDetail, { tab: 'workers' });

start();
