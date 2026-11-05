/**
 * 로컬 Vite 앱의 실제 pointer binding을 Chromium CDP touch로 검사한다.
 * 실행: PLAYWRIGHT_MODULE에 설치된 playwright 경로, 필요 시 BROWSER_PATH/ SPRED_TEST_URL 지정.
 * 제품 코드에 debug 전역을 추가하지 않고 이 브라우저의 main 응답에만 조회 probe를 삽입한다.
 * 실제 Android/iOS 하드웨어 검증을 대체하지 않는다.
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 격리 브라우저에서 실제 이벤트·스크롤·악보·이력을 비교한다.
 * - 인수 : 없음
 * - 반환값 : 모든 검사 완료 Promise
 */
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/src/app/main.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('const appSession = {',
        'window.__touchProbe = {getState: () => state, loadScoreJsonText, applyUndo, applyRedo}; const appSession = {');
      await route.fulfill({ response, body });
    });
    await page.goto(process.env.SPRED_TEST_URL || 'http://127.0.0.1:5194/');
    await page.waitForFunction(() => window.__touchProbe);
    const fixture = fs.readFileSync(path.join(__dirname, 'test_cases/minimal-valid-score.json'), 'utf8');
    await page.evaluate(text => window.__touchProbe.loadScoreJsonText(text, 'touch test'), fixture);
    await page.locator('label[for="edit-mode-toggle"]').click();
    await page.locator('.default-mode-select').selectOption('custom');
    await page.locator('.custom-text-input').fill('touch-test');
    const cdp = await context.newCDPSession(page);
    const touches = new Map();
    /**
     * 현재 접촉 목록으로 실제 Chromium touch 이벤트를 보낸다.
     * - 인수 : kind : start/move/end/cancel
     * - 인수 : id : 접촉 번호
     * - 인수 : point : 화면 좌표
     * - 반환값 : 이벤트 전달 Promise
     */
    async function touch(kind, id, point) {
      if (kind === 'touchStart' || kind === 'touchMove') touches.set(id, { id, x: point.x, y: point.y });
      else touches.delete(id);
      if (kind === 'touchCancel') touches.clear();
      await cdp.send('Input.dispatchTouchEvent', { type: kind, touchPoints: [...touches.values()] });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    /**
     * 실제 layout으로부터 보이는 note 행의 편집 좌표를 만든다.
     * - 인수 : col : 열 번호
     * - 반환값 : 화면 좌표
     */
    async function point(col = 12) {
      return page.evaluate(col => {
        const state = window.__touchProbe.getState();
        const stage = document.querySelector('.score-canvas-stage').getBoundingClientRect();
        const area = document.querySelector('.score-area').getBoundingClientRect();
        const row = state.layout.rows.find(row => row.kind === 'note' && stage.top + row.y > area.top + 25);
        if (!row) throw new Error('No visible note row: ' + JSON.stringify(state.layout.rows[4]));
        return { x: stage.left + (col + 0.5) * state.layout.columnWidth, y: stage.top + row.y + row.height / 2 };
      }, col);
    }
    /**
     * 셀 순서와 무관하게 악보·이력 및 스크롤을 조회한다.
     * - 인수 : 없음
     * - 반환값 : 비교용 상태
     */
    async function snapshot() {
      return page.evaluate(() => {
        const s = window.__touchProbe.getState();
        const area = document.querySelector('.score-area');
        return { cells: JSON.stringify([...s.document.indexes.cellMapByTrackId].map(([key, cells]) => [key, [...cells].sort()])) ,
          globals: JSON.stringify([...s.document.indexes.globalCellMapByCoord].sort()),
          history: JSON.stringify(s.history), undo: s.history.undoStack.length, redo: s.history.redoStack.length,
          x: area.scrollLeft, y: area.scrollTop, selection: s.selection, status: s.statusMessage };
      });
    }
    /**
     * 완료된 편집 및 이전 두 이력이 복원 전후 같은지 비교한다.
     * - 인수 : before : 제스처 전 상태
     * - 반환값 : 검사 Promise
     */
    async function preserved(before) {
      const after = await snapshot();
      assert.equal(after.cells, before.cells);
      assert.equal(after.globals, before.globals);
      assert.equal(after.history, before.history);
    }
    let p = await point();
    assert(Number.isFinite(p.x) && Number.isFinite(p.y), JSON.stringify(p));
    const initial = await snapshot();
    await touch('touchStart', 1, p);
    await touch('touchEnd', 1);
    assert.equal((await snapshot()).undo, initial.undo + 1);
    // 빠른 마우스 연속 클릭은 다른 제스처로 두 번 확정된다.
    await page.mouse.click(p.x + 30, p.y);
    await page.mouse.click(p.x + 60, p.y);
    assert.equal((await snapshot()).undo, initial.undo + 3);
    await page.evaluate(() => window.__touchProbe.applyUndo());
    const withRedo = await snapshot();
    assert(withRedo.undo > 0 && withRedo.redo > 0);
    p = await point(18);
    await touch('touchStart', 1, p);
    await touch('touchMove', 1, { x: p.x + 60, y: p.y });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.notEqual((await snapshot()).cells, withRedo.cells);
    await touch('touchStart', 2, { x: p.x + 100, y: p.y + 40 });
    await preserved(withRedo);
    const panStart = await snapshot();
    await touch('touchMove', 1, { x: p.x + 20, y: p.y - 20 });
    assert((await snapshot()).x > panStart.x);
    await touch('touchEnd', 1);
    const blocked = await snapshot();
    await touch('touchStart', 3, { x: p.x + 50, y: p.y + 40 });
    await touch('touchMove', 2, { x: p.x + 20, y: p.y + 20 });
    assert.equal((await snapshot()).x, blocked.x);
    await touch('touchEnd', 2);
    await touch('touchEnd', 3);
    await preserved(withRedo);
    // cancel/blur/외부 Undo는 아직 완료하지 않은 편집만 버린다.
    for (const abort of ['cancel', 'blur', 'undo']) {
      const before = await snapshot();
      p = await point(24);
      await touch('touchStart', 1, p);
      await touch('touchMove', 1, { x: p.x + 45, y: p.y });
      if (abort === 'cancel') await touch('touchCancel', 1);
      else {
        await page.evaluate(abort => abort === 'blur' ? window.dispatchEvent(new Event('blur')) : window.__touchProbe.applyUndo(), abort);
        await touch('touchEnd', 1);
      }
      if (abort !== 'undo') await preserved(before);
      else assert.equal((await snapshot()).undo, before.undo - 1);
    }
    // 세 번째 접촉과 가로 경계 반전, 세로 이동을 실제 touch stream으로 확인한다.
    await page.locator('.zoom-input').evaluate(el => { el.value = '100'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('.score-area').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    p = await point(12);
    const beforeThird = await snapshot();
    await touch('touchStart', 1, p);
    await touch('touchStart', 2, { x: p.x + 90, y: p.y + 40 });
    await touch('touchMove', 1, { x: p.x + 40, y: p.y });
    assert.equal((await snapshot()).x, 0);
    await touch('touchMove', 1, { x: p.x + 20, y: p.y - 30 });
    assert((await snapshot()).x > 0);
    assert((await snapshot()).y > 0);
    await touch('touchStart', 3, { x: p.x + 150, y: p.y + 40 });
    const thirdBlocked = await snapshot();
    await touch('touchMove', 1, { x: p.x - 20, y: p.y });
    assert.equal((await snapshot()).x, thirdBlocked.x);
    for (const id of [2, 1, 3]) await touch('touchEnd', id);
    await preserved(beforeThird);

    // 브라우저가 제공하지 않는 장애·예약 순서를 합성 pointer로 보충 검사한다.
    // capture만 대역 처리하며 제품 handler와 실제 RAF/악보 경로를 그대로 사용한다.
    await page.evaluate(() => {
      const stage = document.querySelector('.score-canvas-stage');
      const original = stage.setPointerCapture.bind(stage);
      stage.setPointerCapture = id => { if (id < 900) original(id); };
      window.__sendPointer = (type, pointerId, pointerType, point) => stage.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, pointerType, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, clientX: point.x, clientY: point.y,
      }));
    });
    p = await point(18);
    const beforePending = await snapshot();
    await page.evaluate(p => {
      window.__sendPointer('pointerdown', 901, 'touch', p);
      window.__sendPointer('pointermove', 901, 'touch', { x: p.x + 50, y: p.y });
      window.__sendPointer('pointerdown', 902, 'touch', { x: p.x + 90, y: p.y + 30 });
      window.__sendPointer('pointerup', 901, 'touch', p);
      window.__sendPointer('pointerup', 902, 'touch', p);
    }, p);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await preserved(beforePending);
    for (const abort of ['lostpointercapture', 'hidden', 'mode', 'load']) {
      const before = await snapshot();
      await page.evaluate(p => {
        window.__sendPointer('pointerdown', 903, 'touch', p);
        window.__sendPointer('pointermove', 903, 'touch', { x: p.x + 50, y: p.y });
      }, p);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      if (abort === 'load') {
        await page.evaluate(text => window.__touchProbe.loadScoreJsonText(text, 'replacement'), fixture);
      } else await page.evaluate(({abort, p}) => {
        if (abort === 'lostpointercapture') window.__sendPointer(abort, 903, 'touch', p);
        if (abort === 'hidden') {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
          delete document.hidden;
        }
        if (abort === 'mode') {
          const toggle = document.querySelector('#edit-mode-toggle');
          toggle.checked = false;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, {abort, p});
      const afterCommand = await snapshot();
      await page.evaluate(p => {
        window.__sendPointer('pointermove', 903, 'touch', { x: p.x + 80, y: p.y });
        window.__sendPointer('pointerup', 903, 'touch', p);
        window.__sendPointer('click', 903, 'touch', p);
      }, p);
      if (abort !== 'load') await preserved(before);
      else await preserved(afterCommand);
      if (abort === 'mode' || abort === 'load') await page.locator('label[for="edit-mode-toggle"]').click();
      p = await point(18);
    }
    // 펜 소유 중 터치는 편집을 인수하지 않고, 터치 소유 중 펜도 무시한다.
    await page.locator('.default-mode-select').selectOption('custom');
    await page.locator('.custom-text-input').fill('pen-test');
    const beforePen = await snapshot();
    await page.evaluate(p => {
      window.__sendPointer('pointerdown', 910, 'pen', p);
      window.__sendPointer('pointerdown', 911, 'touch', { x: p.x + 90, y: p.y });
      window.__sendPointer('pointerup', 910, 'pen', p);
      window.__sendPointer('pointerup', 911, 'touch', p);
    }, p);
    assert.equal((await snapshot()).undo, beforePen.undo + 1);
    const afterPen = await snapshot();
    await page.evaluate(p => {
      window.__sendPointer('pointerdown', 912, 'touch', p);
      window.__sendPointer('pointerdown', 913, 'pen', p);
      window.__sendPointer('pointerup', 913, 'pen', p);
      window.__sendPointer('pointercancel', 912, 'touch', p);
    }, p);
    await preserved(afterPen);
    assert.equal(await page.locator('.score-canvas-stage').evaluate(el => getComputedStyle(el).touchAction), 'none');
    assert.equal(await page.locator('.edit-panel').evaluate(el => getComputedStyle(el).touchAction), 'auto');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.touch-edit-hint').isVisible(), true);
    if (process.env.SPRED_SCREENSHOT) await page.screenshot({ path: process.env.SPRED_SCREENSHOT });
    await page.locator('label[for="edit-mode-toggle"]').click();
    assert.equal(await page.locator('.score-canvas-stage').evaluate(el => getComputedStyle(el).touchAction), 'auto');
    assert.deepEqual(errors, []);
    console.log('PASS: native Chromium tap/drag/rollback/diagonal pan/boundary reversal/2→1→2/third touch/cancel/blur/Undo; mouse clicks. Synthetic pending RAF/capture loss/hidden/mode/load/stale events/pen ownership; CSS scope. No page errors.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
