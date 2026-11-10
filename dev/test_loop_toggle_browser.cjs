/** 실제 Loop 버튼과 재생 제어기의 즉시 동기화를 로컬 Vite에서 확인한다. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

/**
 * 반복 중 Off 클릭 후 위치 보존과 기존 끝점 통과를 확인한다.
 * - 인수 : 없음
 * - 반환값 : 검사 완료 Promise
 */
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/src/app/main.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('const appSession = {', `window.__loopProbe = {
        prepare: async () => {
          state = {...state, loop: {...state.loop, enabled: true, startTick: 0, endTick: 1}};
          syncUiControls(dom, state);
          const loop = createPlaybackLoopStateFromApp(state, playbackRuntime);
          await playbackRuntime.controller.playFromSeconds(0, loop);
          return loop.endSeconds;
        },
        read: () => ({...playbackRuntime.controller.getState(), seconds: playbackRuntime.controller.getCurrentScoreSeconds()}),
        stop: () => playbackRuntime.controller.stop()
      }; const appSession = {`);
      await route.fulfill({ response, body });
    });
    await page.goto(process.env.SPRED_TEST_URL || 'http://127.0.0.1:5193/');
    await page.waitForFunction(() => window.__loopProbe);
    const end = await page.evaluate(() => window.__loopProbe.prepare());
    await page.waitForTimeout(end * 2100);
    await page.locator('.loop-menu-button').click();
    await page.locator('.loop-toggle').click();
    const off = await page.evaluate(() => window.__loopProbe.read());
    assert.equal(off.kind, 'playing');
    assert.equal(off.loop.enabled, false);
    await page.waitForTimeout((end + 0.1) * 1000);
    const advanced = await page.evaluate(() => window.__loopProbe.read());
    assert(advanced.seconds > end, 'Off must pass the old loop end without pausing.');
    await page.locator('.loop-toggle').click();
    assert.equal((await page.evaluate(() => window.__loopProbe.read())).loop.enabled, true);
    await page.evaluate(() => window.__loopProbe.stop());
    assert.deepEqual(errors, []);
    console.log('Loop toggle browser checks passed.');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
