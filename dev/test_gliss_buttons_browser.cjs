/**
 * 로컬 Vite에서 Long/Trem/Gliss 버튼 선택·해제와 편집 패널 배치를 검사한다.
 * PLAYWRIGHT_MODULE, BROWSER_PATH, SPRED_TEST_URL로 실행 환경을 지정한다.
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

/**
 * 실제 버튼·키보드 입력과 rawText preview, 배율별 카드 크기를 확인한다.
 * - 인수 : 없음
 * - 반환값 : 검사 완료 Promise
 */
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/src/app/main.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('const appSession = {',
        'window.__glissProbe = {setBusy: (busy) => { state = {...state, busy}; syncUiControls(dom, state); }}; const appSession = {');
      await route.fulfill({ response, body });
    });
    await page.goto(process.env.SPRED_TEST_URL || 'http://127.0.0.1:5193/');
    await page.waitForFunction(() => window.__glissProbe);
    const buttons = page.locator('[data-gliss-kind]');
    const button = kind => page.locator(`[data-gliss-kind="${kind}"]`);
    const preview = () => page.locator('.current-raw-text-preview').getAttribute('title');
    assert.equal(await buttons.count(), 4);
    assert(await button('S').isDisabled());
    await page.locator('label[for="edit-mode-toggle"]').click();
    await page.locator('.default-mode-select').selectOption('custom');
    await page.locator('.custom-text-input').fill('C4');
    const hold = value => page.locator(`[data-hold-token="${value}"]`);
    const trem = value => page.locator(`[data-trem-division="${value}"]`);
    // 한 글자 버튼의 단일 선택·해제와 두 그룹의 독립적인 합성을 확인한다.
    for (const value of ['-', '~']) {
      await hold(value).click();
      assert.equal(await preview(), `${value}C4`);
      await hold(value).click();
      assert.equal(await preview(), 'C4');
    }
    for (const value of ['2', '3', '4']) {
      await trem(value).click();
      assert.equal(await preview(), `C4@t(${value})`);
      await trem(value).click();
      assert.equal(await preview(), 'C4');
    }
    await hold('~').click();
    await hold('-').click();
    assert.equal(await hold('~').getAttribute('aria-pressed'), 'false');
    await trem('2').click();
    await trem('4').click();
    assert.equal(await trem('2').getAttribute('aria-pressed'), 'false');
    assert.equal(await preview(), '-C4@t(4)');
    await hold('~').click();
    assert.match(await preview(), /cannot be used together/);
    await hold('-').click();
    await hold('-').focus();
    await page.keyboard.press('Space');
    assert.equal(await preview(), 'C4@t(4)');
    await trem('4').focus();
    await page.keyboard.press('Enter');
    assert.equal(await preview(), 'C4');
    assert(await page.locator('.gliss-id-select').isDisabled());
    // 네 가지 입력이 기존 composer의 rawText 계약을 그대로 사용한다.
    for (const [kind, expected] of [['S','C4@g(a,S)'], ['holdStart','-@g(a,S)'], ['M','C4@g(a,M)'], ['E','C4@g(a,E)']]) {
      await button(kind).click();
      assert.equal(await page.locator('[data-gliss-kind][aria-pressed="true"]').count(), 1);
      assert.equal(await preview(), expected);
      await button(kind).click();
      assert.equal(await page.locator('[data-gliss-kind][aria-pressed="true"]').count(), 0);
      assert.equal(await preview(), 'C4');
      assert(await page.locator('.gliss-id-select').isDisabled());
    }
    await button('S').click();
    await button('E').click();
    assert.equal(await button('S').getAttribute('aria-pressed'), 'false');
    await page.locator('.gliss-id-select').selectOption('c');
    assert.equal(await preview(), 'C4@g(c,E)');
    await button('E').focus();
    await page.keyboard.press('Space');
    assert.equal(await preview(), 'C4');
    await button('holdStart').focus();
    await page.keyboard.press('Enter');
    assert.equal(await preview(), '-@g(c,S)');
    await hold('-').click();
    await trem('3').click();
    assert.equal(await preview(), '-@g(c,S)', 'holdStart must retain its existing override behavior');
    for (const mode of ['comment','eraser']) {
      await page.locator('.default-mode-select').selectOption(mode);
      assert(await button('S').isDisabled());
      assert(await page.locator('.gliss-id-select').isDisabled());
      assert(await hold('-').isDisabled());
      assert(await trem('3').isDisabled());
    }
    await page.locator('.default-mode-select').selectOption('custom');
    assert.equal(await preview(), '-@g(c,S)');
    await page.evaluate(() => window.__glissProbe.setBusy({kind:'loadingScore',message:'test'}));
    assert(await button('S').isDisabled());
    assert(await hold('-').isDisabled());
    assert(await trem('3').isDisabled());
    await page.evaluate(() => window.__glissProbe.setBusy({kind:'idle'}));
    await page.locator('label[for="edit-mode-toggle"]').click();
    assert(await button('S').isDisabled());
    await page.locator('label[for="edit-mode-toggle"]').click();
    assert.equal(await button('holdStart').getAttribute('aria-pressed'), 'true');
    assert.equal(await hold('-').getAttribute('aria-pressed'), 'true');
    assert.equal(await trem('3').getAttribute('aria-pressed'), 'true');

    // 최소 폭과 compact 배율에서도 버튼 글자가 잘리거나 패널 높이가 넘치지 않아야 한다.
    for (const width of [1920, 1280, 900, 390]) {
      await page.setViewportSize({width, height:1080});
      const metrics = await page.evaluate(() => {
        const row = document.querySelector('.edit-row');
        const gliss = document.querySelector('.gliss-card');
        const actions = document.querySelector('.actions-card');
        const modifiers = [...document.querySelectorAll('.modifier-kind-buttons')];
        const controls = [...gliss.querySelectorAll('button,select'), ...actions.querySelectorAll('button,.edit-card-title,.pending-pill'), ...document.querySelectorAll('.modifier-kind-buttons button')];
        return {width:innerWidth, tracks:getComputedStyle(row).gridTemplateColumns,
          gliss:gliss.offsetWidth, actions:actions.offsetWidth,
          modifierWidths:modifiers.map(el=>el.offsetWidth),
          buttonWidths:[...document.querySelectorAll('.modifier-kind-buttons button')].map(el=>el.offsetWidth),
          overflow:controls.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.textContent.trim()),
          height:row.scrollHeight, clientHeight:row.clientHeight};
      });
      assert.deepEqual(metrics.overflow, []);
      assert.deepEqual(metrics.modifierWidths, [59, 88]);
      assert(metrics.buttonWidths.every(width=>width===28));
      assert(metrics.height <= metrics.clientHeight + 1, 'Panel must not gain vertical clipping');
      console.log(JSON.stringify(metrics));
    }
    await page.setViewportSize({width:1920,height:1080});
    await page.locator('.edit-row').evaluate(el => {el.scrollLeft=0;});
    if (process.env.GLISS_SCREENSHOT) await page.locator('.edit-panel').screenshot({path:process.env.GLISS_SCREENSHOT});
    await page.getByRole('button', {name:'View', exact:true}).hover();
    await page.locator('.theme-button').click();
    const colors = await buttons.evaluateAll(elements => elements.map(el => ({
      pressed:el.getAttribute('aria-pressed'), background:getComputedStyle(el).backgroundColor,
    })));
    assert.notEqual(colors.find(c=>c.pressed==='true').background, colors.find(c=>c.pressed==='false').background);
    for (const selector of ['[data-hold-token]', '[data-trem-division]']) {
      const groupColors = await page.locator(selector).evaluateAll(es => es.map(el=>({pressed:el.getAttribute('aria-pressed'),bg:getComputedStyle(el).backgroundColor})));
      assert.notEqual(groupColors.find(c=>c.pressed==='true').bg, groupColors.find(c=>c.pressed==='false').bg);
    }
    assert.deepEqual(errors, []);
    console.log('PASS Long/Trem/Gliss: rawText, none, exclusive choice, conflicts, id, keyboard, disabled states, compact layout; pageerror 0');
  } finally { await browser.close(); }
}
main().catch(error => {console.error(error);process.exitCode=1;});
