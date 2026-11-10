/** 실제 파일 입력·경고·열 확장·다운로드의 승인/취소 흐름을 로컬 Vite에서 확인한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

/**
 * 대용량 경고 취소 시 상태 보존과 승인 시 작업 완료를 검사한다.
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
      const body = (await response.text()).replace('const appSession = {', `window.__largeProbe = {
        remember: () => {window.__beforeDocument = state.document;},
        read: () => ({columns: state.document.score.globalLines.columnCount, same: state.document === window.__beforeDocument, busy:state.busy.kind})
      }; const appSession = {`);
      await route.fulfill({ response, body });
    });
    await page.goto(process.env.SPRED_TEST_URL || 'http://127.0.0.1:5193/');
    await page.waitForFunction(() => window.__largeProbe);
    const score = JSON.parse(fs.readFileSync(new URL('./test_cases/minimal-valid-score.json', `file://${__filename.replace(/\\/g, '/')}`), 'utf8'));
    score.globalLines.columnCount = 10001;
    const json = JSON.stringify(score);
    const file = { name: 'large.json', mimeType: 'application/json', buffer: Buffer.from(json + ' '.repeat(8 * 1024 * 1024 + 1)) };
    let accept = false;
    let prompts = 0;
    page.on('dialog', async dialog => { prompts++; assert.match(dialog.message(), /unresponsive/); await (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => window.__largeProbe.remember());
    await page.locator('.json-load-input').setInputFiles(file);
    assert.equal((await page.evaluate(() => window.__largeProbe.read())).same, true);
    accept = true;
    await page.locator('.json-load-input').setInputFiles(file);
    await page.waitForFunction(() => window.__largeProbe.read().columns === 10001 && window.__largeProbe.read().busy === 'idle');
    assert.equal(prompts, 2, 'One prompt per load, even when both thresholds are exceeded.');
    await page.evaluate(() => window.__largeProbe.remember());
    accept = false;
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    await page.locator('.expand-column-input').fill('1');
    await page.locator('.expand-right-button').click();
    assert.equal((await page.evaluate(() => window.__largeProbe.read())).same, true);
    accept = true;
    await page.locator('.expand-right-button').click();
    assert.equal((await page.evaluate(() => window.__largeProbe.read())).columns, 10002);
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.evaluate(() => window.__largeProbe.remember());
    accept = false;
    await page.locator('.json-download-button').click();
    assert.equal((await page.evaluate(() => window.__largeProbe.read())).same, true);
    accept = true;
    const downloaded = page.waitForEvent('download');
    await page.locator('.json-download-button').click();
    const result = await downloaded;
    assert.equal(JSON.parse(fs.readFileSync(await result.path(), 'utf8')).globalLines.columnCount, 10002);
    assert.deepEqual(errors, []);
    console.log('Large-score file load, expansion and download approval/cancellation checks passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
