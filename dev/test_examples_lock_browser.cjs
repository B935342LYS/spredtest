/** 베타 입력 잠금·재개방·프로그램 이벤트 차단과 Info 상단 안내를 실제 브라우저에서 확인한다. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

/**
 * 외부 서비스 대신 고정 manifest를 사용하여 UI와 요청 차단을 검사한다.
 * - 인수 : 없음
 * - 반환값 : 검사 완료 Promise
 */
async function main() {
  const { createServer } = await import('vite');
  const server = await createServer({ root: path.resolve(__dirname, '..'), server: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const requests = [];
    const errors = [];
    let failNext = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/functions/v1/get-example-manifest', async route => {
      requests.push(JSON.parse(route.request().postData()).accessWord);
      await route.fulfill(failNext ? { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MANIFEST_UNAVAILABLE', message: 'Fixture unavailable' } }) }
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, examples: [{ id: 'public', title: 'Public fixture', artist: 'Test', supportedTracks: ['basic'], scoreUrl: 'https://example.com/public.json' }] }) });
    });
    await page.goto(process.env.SPRED_TEST_URL || server.resolvedUrls.local[0]);
    await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); });
    await page.locator('.examples-button').evaluate(button => button.click());
    await page.locator('.example-row').waitFor();
    const input = page.locator('.examples-access-word-input');
    const loadList = page.locator('.examples-load-list-button');
    assert(await input.isDisabled());
    assert(await loadList.isDisabled());
    assert.deepEqual(requests, ['']);
    // disabled 속성을 바꿔도 클릭·submit handler는 베타 요청을 만들지 않는다.
    await page.evaluate(() => {
      const input = document.querySelector('.examples-access-word-input');
      const button = document.querySelector('.examples-load-list-button');
      input.disabled = button.disabled = false;
      input.value = 'previous-beta-word';
      button.click();
      document.querySelector('.examples-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150);
    assert.deepEqual(requests, ['']);
    await page.locator('.examples-close-button').click();
    await page.locator('.examples-button').evaluate(button => button.click());
    await page.locator('.example-row').waitFor();
    assert(await input.isDisabled());
    assert(await loadList.isDisabled());
    assert.equal(await input.inputValue(), '');
    await page.locator('.example-row').click();
    assert(!(await page.locator('.examples-load-button').isDisabled()), 'Public score selection remains available');
    await page.locator('.examples-close-button').click();
    failNext = true;
    await page.locator('.examples-button').evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelector('.examples-notice')?.textContent.includes('Fixture unavailable'));
    assert(await input.isDisabled());
    assert(await loadList.isDisabled());
    assert(requests.every(word => word === ''));
    await page.locator('.examples-close-button').click();
    await page.evaluate(() => document.querySelector('#legal-info').showModal());
    assert.equal(await page.locator('#legal-info section').first().getAttribute('class'), 'info-use-notice');
    assert.match(await page.locator('.info-use-notice').innerText(), /공유·게시·배포하지/);
    assert.match(await page.locator('.info-use-notice').innerText(), /Do not share/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.locator('.info-use-notice').isVisible());
    const overflow = await page.locator('#legal-info form').evaluate(form => form.scrollWidth > form.clientWidth);
    assert(!overflow, 'Notice must not overflow horizontally on mobile');
    assert.deepEqual(errors, []);
    console.log('Examples beta lock and Info browser checks passed; external requests mocked.');
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
