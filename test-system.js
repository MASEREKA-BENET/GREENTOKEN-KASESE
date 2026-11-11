const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const port = 31000 + Math.floor(Math.random() * 20000);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greentoken-test-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(port), GREENTOKEN_DB_PATH: path.join(tempDir, 'test.sqlite') },
  stdio: ['ignore', 'ignore', 'inherit']
});
const base = `http://127.0.0.1:${port}/api`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(endpoint, method = 'GET', payload, cookie) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return { response, data: await response.json() };
}

async function main() {
  const html = fs.readFileSync(path.join(__dirname, 'Token system.html'), 'utf8');
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(inlineScript, 'application script exists');
  new vm.Script(inlineScript[1], { filename: 'Token system.html' });
  assert(html.includes('downloadFarmersCsv') && html.includes('printFarmersList'), 'farmer CSV and print export actions are available');
  assert(html.includes('downloadLedgersCsv') && html.includes('Download Payout Ledger (CSV)'), 'finance payout ledger export is available');
  assert(html.includes('toggleNav(this)') && html.includes('@media (max-width: 600px)'), 'responsive navigation and mobile layout are present');
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base + '/missing');
      if (response.status === 401 || response.status === 404) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert(ready, 'server starts and responds');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200, 'application page is served');
  assert((await page.text()).includes('GreenToken Kasese'), 'served page is the GreenToken application');

  let result = await request('/login', 'POST', { username: 'admin', password: 'admin123' });
  assert.equal(result.response.status, 200, 'admin can log in');
  const admin = result.response.headers.get('set-cookie').split(';')[0];
  result = await request('/bootstrap', 'GET', undefined, admin);
  assert(result.data.users.length >= 4, 'seed users are available');
  assert.equal(result.data.settings.usdToUgx, 3780, 'default exchange rate is present');
  result.data.settings.usdToUgx = 4000;
  const onsiteId = Date.now();
  result.data.users.push({
    id: onsiteId, username: `onsite${onsiteId}`, password: 'temporary123', role: 'farmer',
    fullname: 'Onsite Farmer', phone: '0700000001', district: 'Kasese', trees: 20,
    estimatedCredits: 3, status: 'approved', registeredDate: new Date().toISOString()
  });
  await request('/sync', 'POST', result.data, admin);
  result = await request('/login', 'POST', { username: `onsite${onsiteId}`, password: 'temporary123' });
  assert.equal(result.data.user.mustChangePassword, true, 'admin-created farmers must change their temporary password');

  result = await request('/register', 'POST', {
    fullname: 'Test Farmer', username: 'testfarmer', password: 'strongpass123',
    phone: '0700000000', district: 'Kasese', trees: 100
  });
  assert.equal(result.response.status, 201, 'farmer can register');
  const farmerId = result.data.id;
  result = await request('/login', 'POST', { username: 'testfarmer', password: 'strongpass123' });
  assert.equal(result.response.status, 403, 'pending farmer cannot sign in');

  result = await request('/bootstrap', 'GET', undefined, admin);
  result.data.users.find(user => user.id === farmerId).status = 'approved';
  await request('/sync', 'POST', result.data, admin);
  result = await request('/login', 'POST', { username: 'testfarmer', password: 'strongpass123' });
  assert.equal(result.response.status, 200, 'approved farmer can sign in');
  const farmer = result.response.headers.get('set-cookie').split(';')[0];
  let farmerData = await request('/bootstrap', 'GET', undefined, farmer);
  assert(!farmerData.data.users.some(user => user.role === 'finance'), 'farmer cannot see finance accounts');
  farmerData.data.complaints.push({
    id: Date.now(), userId: farmerId, subject: 'Test complaint', message: 'Please check this.', priority: 'medium'
  });
  await request('/sync', 'POST', farmerData.data, farmer);

  result = await request('/login', 'POST', { username: 'finance', password: 'finance123' });
  assert.equal(result.response.status, 200, 'finance can log in');
  const finance = result.response.headers.get('set-cookie').split(';')[0];
  let financeData = await request('/bootstrap', 'GET', undefined, finance);
  assert.equal(financeData.data.settings.usdToUgx, 4000, 'admin exchange rate is shared with finance');
  financeData.data.settings.usdToUgx = 1;
  financeData.data.ledgers.push({
    id: Date.now() + 1, farmerId, creditAmount: 2, pricePerCredit: 10,
    transactionRef: `TEST-${Date.now()}`
  });
  await request('/sync', 'POST', financeData.data, finance);
  financeData = await request('/bootstrap', 'GET', undefined, finance);
  assert.equal(financeData.data.settings.usdToUgx, 4000, 'finance cannot change the admin exchange rate');
  const payout = financeData.data.ledgers.find(ledger => ledger.farmerId === farmerId);
  assert.equal(payout.farmerPayout, 16, 'server calculates an 80% farmer payout');

  result = await request('/bootstrap', 'GET', undefined, admin);
  const complaint = result.data.complaints.find(item => item.subject === 'Test complaint');
  assert(complaint, 'complaint is visible to admin');
  complaint.status = 'resolved';
  complaint.response = 'Your request has been reviewed.';
  await request('/sync', 'POST', result.data, admin);
  result = await request('/bootstrap', 'GET', undefined, farmer);
  assert.equal(result.data.complaints.find(item => item.id === complaint.id).status, 'resolved', 'farmer sees admin responses');
  console.log('PASS: authentication, onboarding, approval, role scoping, complaints, and server-calculated payouts');
}

main().catch(error => {
  console.error('FAIL:', error);
  process.exitCode = 1;
}).finally(async () => {
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});
