/**
 * Playwright tour of the running UI: visits every page, performs a few real interactions, saves
 * screenshots and fails if any page logs a console error or shows an error banner unexpectedly.
 *
 *   SHOTS_DIR=../aws-emulator-ui-shots npm run shots
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { chromium, type Page } from 'playwright';

const UI = process.env.UI_URL || 'http://127.0.0.1:3297';
const OUT = path.resolve(process.env.SHOTS_DIR || '../aws-emulator-ui-shots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|gush-bg|cdn\.gushwork/i.test(m.text())) problems.push(`[${page.url()}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${page.url()}] pageerror: ${e.message}`));
  const shots: string[] = [];
  const shot = async (name: string, full = false) => {
    await page.waitForTimeout(400);
    const file = path.join(OUT, `${name}.png`);
    if (full) {
      // <main> is its own scroll container, so grow the viewport to its content height for a full capture.
      const h = await page.evaluate(() => (document.querySelector('main')?.scrollHeight ?? 900) + 60);
      await page.setViewportSize({ width: 1600, height: Math.min(Math.max(h, 1000), 4000) });
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: file });
    if (full) await page.setViewportSize({ width: 1600, height: 1000 });
    shots.push(file);
    console.log('  📸', file);
  };
  const go = async (p: string) => {
    await page.goto(UI + p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
  };
  const row = (p: Page, text: string) => p.locator('tbody tr', { hasText: text }).first();
  const noAlerts = async (where: string) => {
    // Our error banners use role=alert; ignore Next.js's empty route announcer.
    const texts = (await page.locator('[role=alert]').allInnerTexts()).filter((t) => t.trim());
    if (texts.length) problems.push(`[${where}] error banner: ${texts[0].slice(0, 200)}`);
  };

  await go('/');
  await page.getByText('Healthy').waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('…'), null, { timeout: 15000 }).catch(() => undefined);
  await shot('01-overview', true);

  await go('/lambda');
  await row(page, 'demo-py').click();
  await page.getByTestId('invoke-button').click();
  await page.getByText('Status 200').waitFor();
  await shot('02-lambda-invoke');
  await noAlerts('lambda');

  await go('/sqs');
  await row(page, 'demo-jobs').first().click();
  await page.getByLabel('Visibility timeout (s)').fill('0');
  await page.getByTestId('receive-button').click();
  await page.waitForTimeout(1500);
  await shot('03-sqs-receive');
  await noAlerts('sqs');

  await go('/sns');
  await row(page, 'demo-notifications').click();
  await page.waitForTimeout(600);
  await shot('04-sns');

  await go('/s3');
  await row(page, 'demo-assets').click();
  await page.waitForTimeout(600);
  await row(page, 'reports').click();
  await page.waitForTimeout(600);
  await shot('05-s3-objects');
  await noAlerts('s3');

  await go('/secrets');
  await row(page, 'demo/db-credentials').click();
  await page.waitForTimeout(500);
  await shot('06-secrets-masked');

  await go('/eventbridge');
  await page.getByLabel('Event bus', { exact: true }).selectOption('demo-bus');
  await page.waitForTimeout(600);
  await row(page, 'demo-order-created').click();
  await page.waitForTimeout(600);
  await shot('07-eventbridge-rule', true);
  await page.getByRole('tab', { name: 'Scheduler' }).click();
  await page.waitForTimeout(600);
  await row(page, 'demo-hourly-report').click();
  await page.waitForTimeout(600);
  await shot('08-eventbridge-scheduler');

  await go('/stepfunctions');
  await row(page, 'demo-order-flow').click();
  await page.getByTestId('start-execution').click();
  await page.waitForTimeout(1500);
  await page.locator('tbody tr').filter({ hasText: 'SUCCEEDED' }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await shot('09-stepfunctions-execution', true);
  await noAlerts('stepfunctions');

  await go('/logs');
  await row(page, '/demo/app').click();
  await page.getByTestId('log-events').waitFor();
  await shot('10-logs-tail');

  await go('/dynamodb');
  await row(page, 'demo-users').click();
  await page.waitForTimeout(800);
  await shot('11-dynamodb-scan', true);
  await noAlerts('dynamodb');

  await go('/ecs');
  await row(page, 'demo-cluster').click();
  await page.waitForTimeout(800);
  await shot('12-ecs-cluster');
  await noAlerts('ecs');

  await go('/apigateway');
  await row(page, 'demo-rest-api').click();
  await page.waitForTimeout(800);
  await shot('13-apigateway-rest', true);
  await page.getByRole('tab', { name: 'HTTP APIs (v2)' }).click();
  await page.waitForTimeout(500);
  await row(page, 'demo-http-api').click();
  await page.waitForTimeout(600);
  await page.getByTestId('export-openapi').click();
  await page.getByTestId('not-supported').waitFor();
  await shot('14-apigateway-http-export-not-supported', true);

  await go('/elb');
  await row(page, 'demo-alb').click();
  await page.waitForTimeout(800);
  await shot('15-elb');
  await page.getByRole('tab', { name: 'Target groups' }).click();
  await page.waitForTimeout(500);
  await row(page, 'demo-web-tg').click();
  await page.waitForTimeout(600);
  await shot('16-elb-target-health');

  await go('/ecr');
  await row(page, 'demo/web').click();
  await page.waitForTimeout(600);
  await shot('17-ecr-images');
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.waitForTimeout(300);
  await shot('18-confirm-dialog');
  await page.keyboard.press('Escape');

  await go('/settings');
  await page.getByText('Connected').first().waitFor();
  await shot('19-settings');

  await browser.close();
  writeFileSync(path.join(OUT, 'problems.json'), JSON.stringify(problems, null, 2));
  console.log(`\n${shots.length} screenshots in ${OUT}`);
  if (problems.length) {
    console.log('Problems:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('No console errors or unexpected error banners.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
