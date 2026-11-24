// Against a freshly started local evaluator demo, walk the same public links an evaluator sees.
import assert from 'node:assert/strict';

const {chromium} = await import(process.env.HARBOR_TEST_PLAYWRIGHT || 'playwright');
const origin = 'http://127.0.0.1:' + (process.env.HARBOR_DEMO_PORT || '8793');
const browser = await chromium.launch({executablePath:process.env.HARBOR_TEST_CHROME || undefined});
try {
  const denied = await fetch(origin + '/demo/manager', {method:'POST',headers:{origin:'https://elsewhere.example.test'},redirect:'manual'});
  assert.equal(denied.status, 403);
  const page = await browser.newPage();
  await page.goto(origin + '/demo');
  await page.getByRole('button', {name:'Try as a sales rep'}).click();
  await page.getByRole('link', {name:'North Pier spring order', exact:true}).click();
  const repDeal = page.url();
  await page.getByText(/Avery confirmed the spring order/).first().waitFor();
  const company = page.getByRole('link', {name:'North Pier Coffee', exact:true}).first();
  await company.waitFor();
  await page.getByRole('link', {name:'Avery Linden', exact:true}).first().click();
  const attachment = page.getByRole('link', {name:'North Pier order brief.txt'});
  await attachment.waitFor();
  const href = new URL(await attachment.getAttribute('href'), origin).href;
  const bytes = await page.request.get(href);
  assert.equal(bytes.status(), 200);
  assert.match(await bytes.text(), /Spring order · \$12,000/);
  assert.equal((await fetch(href)).status, 401);
  await page.goto(repDeal);
  await page.getByRole('link', {name:'Linked tasks', exact:true}).click();
  await page.getByRole('link', {name:'Confirm the delivery window with Avery', exact:true}).click();
  await page.getByRole('button', {name:'Mark complete'}).click();
  await page.getByRole('button', {name:'Reopen task'}).waitFor();
  await page.goto(origin + '/demo');
  await page.getByRole('button', {name:'Try as the manager'}).click();
  await page.getByRole('link', {name:'North Pier spring order', exact:true}).click();
  await page.getByRole('link', {name:'Task history', exact:true}).click();
  await page.getByRole('region', {name:'Task completion history'}).getByText(/Completed by Alex Chen/).waitFor();
  console.log('Passed the local demo walkthrough: rep pipeline, linked company, note, private order brief, task completion, and manager attribution.');
} finally {
  await browser.close();
}
