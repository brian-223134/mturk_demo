// Chrome(headless)으로 템플릿을 HIT 마다 그려 답 칸 목록(TASK_ANSWER_SCHEMA), 화면 글, 주소를 모은다. 실험 러너(run.mjs)가 쓴다.
// 콘솔이 쓰는 renderTemplate 으로 값을 넣고, /elements/ann-elements.js 는 저장소의 파일로 바꿔 불러온다.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { measureLayout } from '../../frontend/src/lib/layout-check.js';
import { ELEMENTS_SCRIPT } from '../../frontend/src/lib/layout-lint.js';
import { jsonForScript, renderTemplate } from '../../frontend/src/lib/template.js';

const ROOT = resolve(import.meta.dirname, '../..');
const ELEMENTS_FILE = pathToFileURL(join(ROOT, 'frontend/src/elements/ann-elements.js')).href;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ERRORS = "<script>window.__errors=[];window.addEventListener('error',function(e){window.__errors.push(String(e.message))});</script>";

export function findChrome() {
  const candidates = [process.env.CHROME, MAC_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** 템플릿과 행 하나 → 파일로 열 수 있는 문서 (요소 스크립트를 저장소 파일로). */
export function pageFor(html, row) {
  return renderTemplate(ERRORS + String(html).split(ELEMENTS_SCRIPT).join(ELEMENTS_FILE), row);
}

function runChrome(chrome, workDir, args) {
  return execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--allow-file-access-from-files', `--user-data-dir=${join(workDir, 'chrome-profile')}`, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 300_000 });
}

const COLLECT = `
const measureLayout = ${measureLayout.toString()};
(async () => {
  const results = [];
  for (const doc of PAGES) {
    const frame = document.createElement('iframe');
    frame.style.width = '1100px';
    frame.style.height = '900px';
    document.body.appendChild(frame);
    await new Promise((done) => { frame.onload = done; frame.srcdoc = doc; });
    await new Promise((done) => setTimeout(done, 300));
    const win = frame.contentWindow;
    const page = frame.contentDocument;
    const clone = page.body.cloneNode(true);
    clone.querySelectorAll('script, style').forEach((node) => node.remove());
    const srcs = [...page.querySelectorAll('[src]')].map((node) => node.getAttribute('src'));
    let layout = null;
    try { layout = measureLayout(page, win); } catch (error) { layout = null; }
    results.push({ schema: win.TASK_ANSWER_SCHEMA ?? null, text: clone.textContent, srcs, layout, error: (win.__errors || []).join(' | ') || null });
    frame.remove();
  }
  document.getElementById('out').textContent = JSON.stringify(results);
})();`;

/** 행마다 그려 본 결과 [{ schema, text, srcs, layout, error }]. layout 은 lib/layout-check.js 의 측정값(폭 1100px)이다. */
export function renderPages({ html, rows, chrome, workDir, name }) {
  mkdirSync(workDir, { recursive: true });
  const file = join(workDir, `${name}.render.html`);
  const pages = rows.map((row) => pageFor(html, row));
  writeFileSync(file, `<!doctype html><html><body><pre id="out">PENDING</pre><script>const PAGES = ${jsonForScript(pages)};${COLLECT}</script></body></html>`);
  const dom = runChrome(chrome, workDir, [`--virtual-time-budget=${Math.max(20_000, rows.length * 2_000)}`, '--dump-dom', pathToFileURL(file).href]);
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  const text = match ? match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : '';
  if (!text.startsWith('[')) throw new Error(`Chrome did not finish rendering ${name} (got ${JSON.stringify(text.slice(0, 80))}).`);
  return JSON.parse(text);
}

/** 첫 HIT 의 화면 사진. 사람이 결과를 볼 때 쓴다. */
export function screenshot({ html, row, chrome, workDir, file, width = 1100, height = 1400 }) {
  const page = join(workDir, `${file}.page.html`);
  writeFileSync(page, `<!doctype html><meta charset="utf-8">${pageFor(html, row)}`);
  runChrome(chrome, workDir, ['--hide-scrollbars', `--window-size=${width},${height}`, '--virtual-time-budget=5000', `--screenshot=${join(workDir, `${file}.png`)}`, pathToFileURL(page).href]);
}
