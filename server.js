const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const databasePath = process.env.GREENTOKEN_DB_PATH ? path.resolve(process.env.GREENTOKEN_DB_PATH) : path.join(DATA_DIR, 'greentoken.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','finance','farmer')), fullname TEXT NOT NULL,
    phone TEXT, district TEXT, trees INTEGER NOT NULL DEFAULT 0, estimated_credits INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'approved', must_change_password INTEGER NOT NULL DEFAULT 0,
    registered_date TEXT NOT NULL, last_payout TEXT, total_earned REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS ledgers (
    id INTEGER PRIMARY KEY, farmer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL, credit_amount REAL NOT NULL, price_per_credit REAL NOT NULL,
    total_amount REAL NOT NULL, commission REAL NOT NULL, farmer_payout REAL NOT NULL,
    status TEXT NOT NULL, transaction_ref TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL, user_role TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium', date TEXT NOT NULL,
    response TEXT, responded_by TEXT, responded_date TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY, sender TEXT NOT NULL, sender_name TEXT NOT NULL, receiver TEXT NOT NULL,
    message TEXT NOT NULL, timestamp TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL
  );
`);

const stmt = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
};
function checkPassword(password, stored) {
  const [, salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function seedUser(user) {
  stmt(`INSERT OR IGNORE INTO users(id,username,password_hash,role,fullname,phone,district,trees,estimated_credits,status,must_change_password,registered_date,last_payout,total_earned)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, user.username, hashPassword(user.password), user.role, user.fullname,
    user.phone || null, user.district || null, user.trees || 0, user.estimatedCredits || 0,
    user.status || 'approved', user.mustChangePassword ? 1 : 0, user.registeredDate || now(), user.lastPayout || null, user.totalEarned || 0);
}
seedUser({ id: 1, username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123', role: 'admin', fullname: 'System Administrator' });
seedUser({ id: 2, username: process.env.FINANCE_USERNAME || 'finance', password: process.env.FINANCE_PASSWORD || 'finance123', role: 'finance', fullname: 'Grace Akello', department: 'Finance' });
seedUser({ id: 3, username: 'farmer001', password: 'default123', role: 'farmer', fullname: 'John Kato', phone: '0777123456', district: 'Kasese', trees: 150, estimatedCredits: 27, status: 'approved', mustChangePassword: true });
seedUser({ id: 4, username: 'farmer002', password: 'default123', role: 'farmer', fullname: 'Grace Nambi', phone: '0788123456', district: 'Bundibugyo', trees: 85, estimatedCredits: 15, status: 'approved', mustChangePassword: true });
stmt(`INSERT OR IGNORE INTO ledgers(id,farmer_id,date,credit_amount,price_per_credit,total_amount,commission,farmer_payout,status,transaction_ref) VALUES(1,3,'2026-04-15',27,9.5,256.5,51.3,205.2,'paid','GT-001')`).run();
stmt(`INSERT OR IGNORE INTO complaints(id,user_id,user_name,user_role,subject,message,status,priority,date,response,responded_by,responded_date) VALUES(1,3,'John Kato','farmer','Payment Delay','I have not received my payout for April credits.','in-progress','high','2026-05-10','We are investigating. Will update within 48 hours.','Admin','2026-05-11')`).run();
stmt(`INSERT OR IGNORE INTO chat_messages(id,sender,sender_name,receiver,message,timestamp,read) VALUES(1,'finance','Grace Akello','admin','Hello Admin, I need to verify the latest farmer payouts.',? ,0)`).run(new Date(Date.now() - 3600000).toISOString());
stmt(`INSERT OR IGNORE INTO chat_messages(id,sender,sender_name,receiver,message,timestamp,read) VALUES(2,'admin','System Administrator','finance','Sure, I will send you the updated list shortly.',? ,0)`).run(new Date(Date.now() - 1800000).toISOString());
stmt('INSERT OR IGNORE INTO app_settings(setting_key,setting_value) VALUES(?,?)').run('usd_to_ugx', '3780');

function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role, fullname: row.fullname, phone: row.phone,
    district: row.district, trees: row.trees, estimatedCredits: row.estimated_credits, status: row.status,
    mustChangePassword: !!row.must_change_password, registeredDate: row.registered_date,
    lastPayout: row.last_payout, totalEarned: row.total_earned };
}
function userById(id) { return stmt('SELECT * FROM users WHERE id=?').get(id); }
function currentUser(req) {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('gt_session='))?.slice(11);
  if (!token) return null;
  const digest = crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex');
  const session = stmt('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(digest);
  if (!session || session.expires_at < Date.now()) {
    if (session) stmt('DELETE FROM sessions WHERE token_hash=?').run(digest);
    return null;
  }
  const user = userById(session.user_id);
  return user ? publicUser(user) : null;
}
function send(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { send(res, status, { error: message }); }
async function body(req) {
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 1_000_000) throw new Error('Request body is too large'); }
  return raw ? JSON.parse(raw) : {};
}
const list = (sql, map) => stmt(sql).all().map(map);
function bootstrap(user) {
  const allUsers = list('SELECT * FROM users ORDER BY id', publicUser);
  const allLedgers = list('SELECT * FROM ledgers ORDER BY id', r => ({ id:r.id, farmerId:r.farmer_id, date:r.date, creditAmount:r.credit_amount, pricePerCredit:r.price_per_credit, totalAmount:r.total_amount, commission:r.commission, farmerPayout:r.farmer_payout, status:r.status, transactionRef:r.transaction_ref }));
  const allComplaints = list('SELECT * FROM complaints ORDER BY id', r => ({ id:r.id, userId:r.user_id, userName:r.user_name, userRole:r.user_role, subject:r.subject, message:r.message, status:r.status, priority:r.priority, date:r.date, response:r.response, respondedBy:r.responded_by, respondedDate:r.responded_date }));
  const allChat = list('SELECT * FROM chat_messages ORDER BY id', r => ({ id:r.id, sender:r.sender, senderName:r.sender_name, receiver:r.receiver, message:r.message, timestamp:r.timestamp, read:!!r.read }));
  const users = user.role === 'farmer' ? allUsers.filter(u => u.id === user.id || u.role === 'admin') : allUsers;
  const ledgers = user.role === 'farmer' ? allLedgers.filter(l => l.farmerId === user.id) : allLedgers;
  const complaints = user.role === 'admin' ? allComplaints : user.role === 'farmer' ? allComplaints.filter(c => c.userId === user.id) : [];
  const chatMessages = user.role === 'admin' ? allChat : user.role === 'finance' ? allChat.filter(m => ['admin','finance'].includes(m.sender) && ['admin','finance'].includes(m.receiver)) : allChat.filter(m => m.sender === user.username || m.receiver === user.role);
  const rateRow = stmt('SELECT setting_value FROM app_settings WHERE setting_key=?').get('usd_to_ugx');
  return { user, users, ledgers, complaints, chatMessages, settings: { usdToUgx: Number(rateRow?.setting_value) || 3780 } };
}
function validText(value, max = 300) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const data = await body(req);
        const row = stmt('SELECT * FROM users WHERE username=?').get(String(data.username || '').trim());
        if (!row || !checkPassword(String(data.password || ''), row.password_hash)) return fail(res, 401, 'Invalid username or password');
        if (row.role === 'farmer' && row.status !== 'approved') return fail(res, 403, `Account ${row.status}. Please contact an administrator.`);
        const token = crypto.randomBytes(32).toString('base64url');
        stmt('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'), row.id, Date.now() + 7 * 86400000);
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        return send(res, 200, { user: publicUser(row) }, { 'Set-Cookie': `gt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('gt_session='))?.slice(11);
        if (token) stmt('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(decodeURIComponent(token)).digest('hex'));
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'gt_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const d = await body(req);
        const fullname = String(d.fullname || '').trim(), username = String(d.username || '').trim();
        const password = String(d.password || ''), phone = String(d.phone || '').trim(), district = String(d.district || '').trim();
        const trees = Number(d.trees);
        if (!validText(fullname, 120) || !validText(username, 40) || !/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 8 || !validText(phone, 40) || !validText(district, 80) || !Number.isInteger(trees) || trees < 1 || trees > 10000000) return fail(res, 400, 'Enter valid details; password must be at least 8 characters.');
        const result = stmt(`INSERT INTO users(username,password_hash,role,fullname,phone,district,trees,estimated_credits,status,must_change_password,registered_date,total_earned) VALUES(?,?,'farmer',?,?,?,?,?,'pending',0,?,0)`).run(username, hashPassword(password), fullname, phone, district, trees, Math.floor(trees * 0.18), now());
        return send(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
      }
      const user = currentUser(req);
      if (!user) return fail(res, 401, 'Please log in again.');
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(res, 200, bootstrap(user));
      if (req.method === 'POST' && url.pathname === '/api/password') {
        const d = await body(req), password = String(d.password || '');
        if (password.length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
        stmt('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hashPassword(password), user.id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/read-chat') {
        stmt('UPDATE chat_messages SET read=1 WHERE receiver=?').run(user.role);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const data = await body(req);
        const old = bootstrap(user);
        db.exec('BEGIN IMMEDIATE');
        try {
          const incomingChat = Array.isArray(data.chatMessages) ? data.chatMessages : [];
          const oldChatIds = new Set(old.chatMessages.map(m => m.id));
          for (const m of incomingChat.filter(m => !oldChatIds.has(m.id))) {
            if (m.sender !== user.username || !validText(m.message, 2000)) continue;
            const allowedReceivers = user.role === 'admin' ? ['finance'] : ['admin'];
            if (!allowedReceivers.includes(m.receiver)) continue;
            stmt('INSERT OR IGNORE INTO chat_messages(id,sender,sender_name,receiver,message,timestamp,read) VALUES(?,?,?,?,?,?,0)').run(Number(m.id), user.username, user.fullname, m.receiver, m.message.trim(), now());
          }
          if (user.role === 'admin') {
            const exchangeRate = Number(data.settings?.usdToUgx);
            if (Number.isFinite(exchangeRate) && exchangeRate >= 1 && exchangeRate <= 1000000) {
              stmt('UPDATE app_settings SET setting_value=? WHERE setting_key=?').run(String(Math.round(exchangeRate * 10000) / 10000), 'usd_to_ugx');
            }
            const incomingUsers = Array.isArray(data.users) ? data.users : [];
            for (const f of incomingUsers) {
              if (f.role !== 'farmer') continue;
              const existing = userById(Number(f.id));
              if (existing && existing.role === 'farmer') {
                if (f.status === 'approved' || f.status === 'rejected' || f.status === 'pending') stmt('UPDATE users SET status=? WHERE id=?').run(f.status, existing.id);
                if (f.status === 'rejected') stmt('DELETE FROM users WHERE id=?').run(existing.id);
              } else if (!existing && validText(f.username, 40) && validText(f.fullname, 120) && validText(f.password || '', 200)) {
                const username = String(f.username).trim();
                if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) continue;
                try { stmt(`INSERT INTO users(id,username,password_hash,role,fullname,phone,district,trees,estimated_credits,status,must_change_password,registered_date,total_earned) VALUES(?,?,?,'farmer',?,?,?,?,?,?,1,?,0)`).run(Number(f.id), username, hashPassword(f.password), String(f.fullname).trim(), String(f.phone || ''), String(f.district || ''), Math.max(0, Number(f.trees) || 0), Math.max(0, Number(f.estimatedCredits) || 0), f.status === 'pending' ? 'pending' : 'approved', f.registeredDate || now()); } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
              }
            }
            const incomingComplaints = Array.isArray(data.complaints) ? data.complaints : [];
            for (const c of incomingComplaints) {
              const existing = stmt('SELECT id FROM complaints WHERE id=?').get(Number(c.id));
              if (!existing) continue;
              if (['in-progress','resolved'].includes(c.status) && validText(c.response || '', 4000)) stmt('UPDATE complaints SET status=?,response=?,responded_by=?,responded_date=? WHERE id=?').run(c.status, c.response, user.fullname, now(), Number(c.id));
            }
            const incomingIds = new Set(incomingUsers.map(f => Number(f.id)));
            for (const f of old.users.filter(f => f.role === 'farmer' && !incomingIds.has(f.id))) stmt('DELETE FROM users WHERE id=? AND role=\'farmer\'').run(f.id);
          } else if (user.role === 'finance') {
            const existingIds = new Set(old.ledgers.map(l => l.id));
            for (const l of (Array.isArray(data.ledgers) ? data.ledgers : [])) {
              if (existingIds.has(l.id)) continue;
              const farmer = userById(Number(l.farmerId)), credits = Number(l.creditAmount), price = Number(l.pricePerCredit);
              if (!farmer || farmer.role !== 'farmer' || farmer.status !== 'approved' || !Number.isFinite(credits) || credits <= 0 || credits > 100000000 || !Number.isFinite(price) || price <= 0 || price > 1000000) continue;
              const total = Math.round(credits * price * 100) / 100, commission = Math.round(total * 20) / 100, payout = Math.round((total - commission) * 100) / 100;
              const ref = String(l.transactionRef || `GT-${l.id}`).slice(0, 100);
              try {
                stmt('INSERT INTO ledgers(id,farmer_id,date,credit_amount,price_per_credit,total_amount,commission,farmer_payout,status,transaction_ref) VALUES(?,?,?,?,?,?,?,?,?,?)').run(Number(l.id), farmer.id, new Date().toISOString().slice(0,10), credits, price, total, commission, payout, 'paid', ref);
                stmt('UPDATE users SET total_earned=total_earned+?,last_payout=? WHERE id=?').run(payout, new Date().toISOString().slice(0,10), farmer.id);
              } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
            }
          } else if (user.role === 'farmer') {
            const existingIds = new Set(old.complaints.map(c => c.id));
            for (const c of (Array.isArray(data.complaints) ? data.complaints : [])) {
              if (existingIds.has(c.id) || Number(c.userId) !== user.id || !validText(c.subject, 200) || !validText(c.message, 4000)) continue;
              stmt('INSERT INTO complaints(id,user_id,user_name,user_role,subject,message,status,priority,date) VALUES(?,?,?,\'farmer\',?,?,\'pending\',?,?)').run(Number(c.id), user.id, user.fullname, c.subject.trim(), c.message.trim(), ['low','medium','high'].includes(c.priority) ? c.priority : 'medium', now());
            }
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        return send(res, 200, { ok: true });
      }
      return fail(res, 404, 'API route not found');
    } catch (e) {
      console.error(e);
      return fail(res, e instanceof SyntaxError ? 400 : 500, e instanceof SyntaxError ? 'Invalid JSON request.' : 'The request could not be completed.');
    }
  }

  let requested;
  try { requested = url.pathname === '/' ? 'Token system.html' : decodeURIComponent(url.pathname.slice(1)); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (requested !== 'Token system.html') { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(ROOT, requested);
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`GreenToken is running at http://localhost:${port}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Development admin login: admin / admin123 (set ADMIN_PASSWORD before deployment).');
});
