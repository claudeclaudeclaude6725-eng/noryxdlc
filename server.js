const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT   = Number(process.env.PORT || 3001);
const ROOT   = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_URL = process.env.DB_URL;
const ALLOWED_ORIGIN = process.env.PUBLIC_ORIGIN || null;
const JSON_BODY_LIMIT = 35 * 1024 * 1024;
const SESSION_TTL_MS = 864e5 * 30;
const COOKIE_NAME = 'noryx_session';
const COOKIE_SECURE = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_PUBLIC_DOMAIN || !!process.env.RAILWAY_STATIC_URL;

const MIME_MAP = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.webp':'image/webp','.json':'application/json','.txt':'text/plain'
};

if (!DB_URL) {
  throw new Error('DB_URL is required');
}

const pool = new Pool({ connectionString: DB_URL });
const sessions = new Map();
const rateBuckets = new Map();
const MUTATING_METHODS = { POST: true, PUT: true, PATCH: true, DELETE: true };

function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genSecretToken() { return crypto.randomBytes(24).toString('hex'); }

function parseCookies(req) {
  var r = {};
  (req.headers.cookie || '').split(';').forEach(function(p) {
    var i = p.indexOf('=');
    if (i < 0) return;
    r[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim());
  });
  return r;
}

function setCookie(token) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' + (COOKIE_SECURE ? '; Secure' : '') + '; Max-Age=' + (SESSION_TTL_MS / 1000);
}
function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict' + (COOKIE_SECURE ? '; Secure' : '') + '; Max-Age=0';
}

function getSession(req) {
  var t = parseCookies(req)[COOKIE_NAME];
  if (!t) return null;
  var s = sessions.get(t);
  if (!s || s.expires < Date.now()) { sessions.delete(t); return null; }
  return { token: t, user: s.user, csrfToken: s.csrfToken };
}
function createSession(user) {
  var t = genToken();
  sessions.set(t, { user, csrfToken: genSecretToken(), expires: Date.now() + SESSION_TTL_MS });
  return t;
}
function destroySession(t) { sessions.delete(t); }

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var size = 0;
    var chunks = [];
    req.on('data', function(c) {
      size += c.length;
      if (size > JSON_BODY_LIMIT) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function() {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"
  };
}

function send(res, status, data, extra) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
  Object.assign(headers, securityHeaders());
  if (ALLOWED_ORIGIN && ALLOWED_ORIGIN !== '*') {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  if (extra) headers = Object.assign(headers, extra);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  return send(res, status, { error: message });
}

function isSafeRelativePath(requestPath) {
  if (requestPath.includes('\0')) return false;
  const normalized = path.posix.normalize('/' + requestPath);
  return !normalized.includes('..');
}

function getRequestOrigin(req) {
  return req.headers.origin || req.headers.referer || '';
}

function isAllowedOrigin(req) {
  const origin = getRequestOrigin(req);
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers.host ? proto + '://' + req.headers.host : null;
    if (ALLOWED_ORIGIN && originUrl.origin === ALLOWED_ORIGIN) return true;
    if (host && originUrl.origin === host) return true;
    if (req.headers.host && originUrl.host === req.headers.host) return true;
  } catch (e) {}
  return false;
}

function requireSameOrigin(req, res) {
  if (!isAllowedOrigin(req)) {
    sendError(res, 403, 'Forbidden');
    return false;
  }
  return true;
}

function rateLimit(req, key, limit, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
  const bucketKey = ip + ':' + key;
  const now = Date.now();
  const bucket = rateBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(bucketKey, bucket);
  return bucket.count <= limit;
}

function requireCsrf(req, res, sess) {
  return true;
}

function serveFile(res, fp) {
  fs.stat(fp, function(err, st) {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
    var ext = path.extname(fp).toLowerCase();
    var mime = MIME_MAP[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size });
    fs.createReadStream(fp).pipe(res);
  });
}

async function db(sql, p) {
  var c = await pool.connect();
  try { return await c.query(sql, p); } finally { c.release(); }
}

function genKey(prefix) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var seg = function() { return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 4).replace(/[^A-Z0-9]/g, 'A'); };
  return prefix + '-' + seg() + '-' + seg() + '-' + seg() + '-' + seg();
}

function buildUser(row) {
  return {
    id: row.id, username: row.username, email: row.email, role: row.role,
    prefix: row.prefix || null, prefixColor: row.prefix_color || null,
    subscriptionType: row.subscription_type, subscriptionExpiresAt: row.subscription_expires_at,
    createdAt: row.created_at, mediaChannel: row.media_channel || null,
    mediaBalance: parseFloat(row.media_balance) || 0,
    mediaPromoCode: row.media_promo_code || null, mediaSince: row.media_since || null,
    balance: parseFloat(row.balance) || 0
  };
}

function isSubActive(row) {
  if (row.role === 'admin' || (row.username && row.username.toLowerCase() === 'illusiononce')) return true;
  return !!(row.subscription_type && row.subscription_expires_at && new Date(row.subscription_expires_at) > new Date());
}
function isAlphaUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  var t = (user.subscriptionType || '').toLowerCase();
  return t === 'alpha' || t === 'alphalife' || t === 'alpha7' || t === 'alpha30' || t === 'alpha90' || t === 'alpha180' || t === 'vip' || user.role === 'alpha' || user.role === 'vip';
}

async function handleApi(req, res, pathname, body) {
  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(req)) return res.writeHead(403), res.end();
    const headers = {
      'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization,X-CSRF-Token',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    };
    if (ALLOWED_ORIGIN) {
      headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
    res.writeHead(204, headers);
    return res.end();
  }

  if (pathname === '/api/health') return send(res, 200, { ok: true });
  if (MUTATING_METHODS[req.method] && !requireSameOrigin(req, res)) return;

  if (pathname === '/api/register' && req.method === 'POST') {
    if (!rateLimit(req, 'register', 8, 60 * 1000)) return send(res, 429, { error: 'Too many requests' });
    var { username, email, password } = body;
    username = (username||'').trim(); email = (email||'').trim().toLowerCase(); password = password||'';
    if (!username||!email||!password) return send(res, 400, { error: 'Заполните все поля' });
    if (password.length < 6) return send(res, 400, { error: 'Пароль минимум 6 символов' });
    try {
      var ex = await db('SELECT id FROM users WHERE email=$1 OR lower(username)=$2 LIMIT 1',[email,username.toLowerCase()]);
      if (ex.rows.length) return send(res, 409, { error: 'Email или логин уже занят' });
      var role = username.toLowerCase() === 'illusiononce' ? 'admin' : 'user';
      var r = await db('INSERT INTO users (username,email,password,role,created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING id,username,email,role,created_at,prefix,prefix_color,subscription_type,subscription_expires_at,media_channel,media_balance,media_promo_code,media_since',[username,email,password,role]);
      var token = createSession(buildUser(r.rows[0]));
      return send(res, 201, { user: buildUser(r.rows[0]), csrfToken: sessions.get(token).csrfToken }, { 'Set-Cookie': setCookie(token) });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(req, 'auth-login', 10, 60 * 1000)) return send(res, 429, { error: 'Too many requests' });
    var login = (body.login||body.email||'').trim().toLowerCase();
    var password = body.password||'';
    if (!login||!password) return send(res, 400, { error: 'Заполните все поля' });
    try {
      var r = await db('SELECT * FROM users WHERE email=$1 OR lower(username)=$1 LIMIT 1',[login]);
      if (!r.rows.length) return send(res, 401, { error: 'Неверный логин или пароль' });
      var row = r.rows[0];
      var ok = row.password === password;
      if (!ok) return send(res, 401, { error: 'Неверный логин или пароль' });
      if (row.banned_until && new Date(row.banned_until) > new Date()) {
        var until = new Date(row.banned_until).toLocaleDateString('ru-RU');
        return send(res, 403, { error: 'Ошибка! Вы забанены. Причина: ' + row.ban_reason + '. До: ' + until });
      }
      if (row.username.toLowerCase() === 'illusiononce' && row.role !== 'admin') {
        await db('UPDATE users SET role=$1 WHERE id=$2',['admin',row.id]);
        row.role = 'admin';
      }
      var user = buildUser(row);
      var token = createSession(user);
      return send(res, 200, { user, csrfToken: sessions.get(token).csrfToken }, { 'Set-Cookie': setCookie(token) });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    var sess = getSession(req);
    if (sess) destroySession(sess.token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    var sess = getSession(req);
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT * FROM users WHERE id=$1',[sess.user.id]);
      if (!r.rows.length) return send(res, 401, { error: 'Не авторизован' });
      var user = buildUser(r.rows[0]);
      var state = sessions.get(sess.token);
      if (state) state.user = user;
      return send(res, 200, { user, csrfToken: sess.csrfToken });
    } catch(e) { return send(res, 200, { user: sess.user }); }
  }
  
  if (pathname === '/api/client/login' && req.method === 'POST') {
    if (!rateLimit(req, 'client-login', 10, 60 * 1000)) return send(res, 429, { error: 'Too many requests' });
    var login    = (body.login    || '').trim().toLowerCase();
    var password = (body.password || '');
    var hwid     = (body.hwid     || '').trim();
    if (!login || !password || !hwid) return send(res, 400, { error: 'missing_fields' });
    try {
      var r = await db('SELECT * FROM users WHERE email=$1 OR lower(username)=$1 LIMIT 1', [login]);
      if (!r.rows.length) return send(res, 401, { error: 'wrong_credentials' });
      var row = r.rows[0];
      var ok = row.password === password;
      if (!ok) return send(res, 401, { error: 'wrong_credentials' });
      if (row.banned_until && new Date(row.banned_until) > new Date()) {
        return send(res, 403, { error: 'banned', banned_until: row.banned_until, ban_reason: row.ban_reason || '' });
      }
      if (!isSubActive(row)) return send(res, 402, { error: 'no_subscription' });
      if (row.hwid && row.hwid !== hwid) return send(res, 403, { error: 'device_mismatch' });
      var token   = genToken();
      var expires = new Date(Date.now() + 864e5 * 30).toISOString();
      if (!row.hwid) {
        await db('UPDATE users SET session_token=$1,session_expires_at=$2,hwid=$3 WHERE id=$4',[token,expires,hwid,row.id]);
      } else {
        await db('UPDATE users SET session_token=$1,session_expires_at=$2 WHERE id=$3',[token,expires,row.id]);
      }
      return send(res, 200, {
        id: row.id, login: row.username, role: row.role,
        role_name: row.role_name || row.role, role_color: row.role_color || '#ffffff',
        prefix: row.prefix || '', prefix_color: row.prefix_color || '',
        hwid: row.hwid || hwid, subscription_active: true,
        banned_until: '', ban_reason: '', session_token: token
      });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/client/validate' && req.method === 'POST') {
    var hwid  = (body.hwid || '').trim();
    var token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!token || !hwid) return send(res, 401, { error: 'missing_token' });
    try {
      var r = await db('SELECT * FROM users WHERE session_token=$1 LIMIT 1', [token]);
      if (!r.rows.length) return send(res, 401, { error: 'session_expired' });
      var row = r.rows[0];
      if (!row.session_expires_at || new Date(row.session_expires_at) < new Date()) return send(res, 401, { error: 'session_expired' });
      if (row.hwid && row.hwid !== hwid) return send(res, 403, { error: 'device_mismatch' });
      if (row.banned_until && new Date(row.banned_until) > new Date()) return send(res, 403, { error: 'banned', banned_until: row.banned_until });
      if (!isSubActive(row)) return send(res, 402, { error: 'no_subscription' });
      return send(res, 200, {
        id: row.id, login: row.username, role: row.role,
        role_name: row.role_name || row.role, role_color: row.role_color || '#ffffff',
        prefix: row.prefix || '', prefix_color: row.prefix_color || '',
        hwid: row.hwid, subscription_active: true,
        banned_until: '', ban_reason: '', session_token: token
      });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  var sess = getSession(req);
  if (MUTATING_METHODS[req.method] && pathname !== '/api/auth/logout' && pathname !== '/api/register' && pathname !== '/api/auth/login' && pathname !== '/api/client/login' && pathname !== '/api/client/validate') {
    if (!requireCsrf(req, res, sess)) return;
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var url = new URL(req.url,'http://localhost');
    var page = parseInt(url.searchParams.get('page')||'1');
    var limit = 10; var offset = (page-1)*limit;
    try {
      var total = await db('SELECT COUNT(*) FROM users',[]);
      var r = await db('SELECT id,username,email,role,prefix,subscription_type,created_at FROM users ORDER BY id DESC LIMIT $1 OFFSET $2',[limit,offset]);
      return send(res, 200, { users: r.rows, total: parseInt(total.rows[0].count), page, limit });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/ban' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { login, duration, reason } = body;
    if (!login||!duration||!reason) return send(res, 400, { error: 'Все поля обязательны' });
    try {
      var r = await db('SELECT id,username FROM users WHERE lower(username)=$1 LIMIT 1',[login.toLowerCase()]);
      if (!r.rows.length) {
        var like = await db("SELECT username FROM users WHERE lower(username) LIKE $1 LIMIT 3",['%'+login.toLowerCase()+'%']);
        return send(res, 404, { error: 'Пользователь не найден', similar: like.rows.map(function(u){ return u.username; }) });
      }
      var target = r.rows[0];
      var dmap = { '1D':1,'7D':7,'14D':14,'30D':30,'90D':90,'180D':180,'360D':360 };
      var until = duration === 'LIFETIME' ? new Date('2099-01-01') : new Date(Date.now()+(dmap[duration]||1)*864e5);
      await db('UPDATE users SET banned_until=$1,ban_reason=$2 WHERE id=$3',[until,reason,target.id]);
      await db('INSERT INTO ban_history (user_id,banned_by,duration,reason,banned_at,banned_until) VALUES ($1,$2,$3,$4,NOW(),$5)',[target.id,sess.user.id,duration,reason,until]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/unban' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId } = body;
    try {
      await db('UPDATE users SET banned_until=NULL,ban_reason=NULL WHERE id=$1',[userId]);
      await db('UPDATE ban_history SET unbanned_at=NOW() WHERE user_id=$1 AND unbanned_at IS NULL',[userId]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/banned' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db("SELECT u.id,u.username,b.reason,b.banned_at,b.banned_until FROM users u JOIN ban_history b ON b.user_id=u.id WHERE b.unbanned_at IS NULL ORDER BY b.banned_at DESC",[]);
      return send(res, 200, { banned: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/give-media' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { login, channel } = body;
    if (!login||!channel) return send(res, 400, { error: 'Введите логин и канал' });
    try {
      var r = await db('SELECT id,username FROM users WHERE lower(username)=$1 LIMIT 1',[login.toLowerCase()]);
      if (!r.rows.length) {
        var like = await db("SELECT username FROM users WHERE lower(username) LIKE $1 LIMIT 3",['%'+login.toLowerCase()+'%']);
        return send(res, 404, { error: 'Не найден', similar: like.rows.map(function(u){ return u.username; }) });
      }
      var promo = 'NORYX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      await db("UPDATE users SET role='media',subscription_type='vip',media_channel=$1,media_since=NOW(),media_promo_code=$2 WHERE id=$3",[channel,promo,r.rows[0].id]);
      return send(res, 200, { ok: true, promo });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/remove-media' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId } = body;
    try {
      await db("UPDATE users SET role='user',media_channel=NULL,media_since=NULL WHERE id=$1",[userId]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  
  if (pathname === '/api/admin/give-balance' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId, amount } = body;
    try {
      await db('UPDATE users SET media_balance=media_balance+$1 WHERE id=$2',[parseFloat(amount),userId]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/media-list' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var url = new URL(req.url,'http://localhost');
    var page = parseInt(url.searchParams.get('page')||'1');
    var limit = 10; var offset = (page-1)*limit;
    try {
      var total = await db("SELECT COUNT(*) FROM users WHERE role='media'",[]);
      var r = await db("SELECT id,username,media_balance,media_channel,media_since FROM users WHERE role='media' ORDER BY id DESC LIMIT $1 OFFSET $2",[limit,offset]);
      return send(res, 200, { media: r.rows, total: parseInt(total.rows[0].count), page, limit });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/role-keys' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT * FROM role_keys ORDER BY created_at DESC',[]);
      return send(res, 200, { keys: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname === '/api/admin/role-keys/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { roleName, roleColor, duration } = body;
    if (!roleName||!roleColor||!duration) return send(res, 400, { error: 'Все поля обязательны' });
    try {
      var key = genKey('ROLE');
      await db('INSERT INTO role_keys (key,role_name,role_color,duration) VALUES ($1,$2,$3,$4)',[key,roleName,roleColor,duration]);
      return send(res, 200, { ok: true, key });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/prefix-keys' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT * FROM prefix_keys ORDER BY created_at DESC',[]);
      return send(res, 200, { keys: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/prefix-keys/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { prefixText, prefixColor } = body;
    if (!prefixText||!prefixColor) return send(res, 400, { error: 'Введите текст и цвет' });
    try {
      var key = genKey('PFX');
      await db('INSERT INTO prefix_keys (key,prefix_text,prefix_color) VALUES ($1,$2,$3)',[key,prefixText,prefixColor]);
      return send(res, 200, { ok: true, key });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/keys/activate' && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var keyUp = (body.key||'').trim().toUpperCase();
    if (!keyUp) return send(res, 400, { error: 'Введите ключ' });
    try {
      if (keyUp.startsWith('ROLE-')) {
        var r = await db('SELECT * FROM role_keys WHERE key=$1 AND used=FALSE LIMIT 1',[keyUp]);
        if (!r.rows.length) return send(res, 404, { error: 'Ключ не найден или использован' });
        var k = r.rows[0];
        var exAt = null;
        var dm = { '7D':7,'30D':30,'90D':90,'180D':180 };
        if (k.duration !== 'LIFETIME') exAt = new Date(Date.now()+(dm[k.duration]||30)*864e5);
        await db('UPDATE role_keys SET used=TRUE,used_by=$1,used_at=NOW() WHERE id=$2',[sess.user.id,k.id]);
        await db('UPDATE users SET role=$1,subscription_type=$1,subscription_expires_at=$2 WHERE id=$3',[k.role_name.toLowerCase(),exAt,sess.user.id]);
        return send(res, 200, { ok: true, type: 'role', roleName: k.role_name });
      }
      if (keyUp.startsWith('PFX-')) {
        var r = await db('SELECT * FROM prefix_keys WHERE key=$1 AND used=FALSE LIMIT 1',[keyUp]);
        if (!r.rows.length) return send(res, 404, { error: 'Ключ не найден или использован' });
        var k = r.rows[0];
        await db('UPDATE prefix_keys SET used=TRUE,used_by=$1,used_at=NOW() WHERE id=$2',[sess.user.id,k.id]);
        await db('UPDATE users SET prefix=$1,prefix_color=$2 WHERE id=$3',[k.prefix_text,k.prefix_color,sess.user.id]);
        return send(res, 200, { ok: true, type: 'prefix', prefix: k.prefix_text, prefixColor: k.prefix_color });
      }
      if (keyUp.startsWith('BAL-')) {
        var r = await db('SELECT * FROM balance_keys WHERE key=$1 AND used=FALSE LIMIT 1',[keyUp]);
        if (!r.rows.length) return send(res, 404, { error: 'Ключ не найден или использован' });
        var k = r.rows[0];
        await db('UPDATE balance_keys SET used=TRUE,used_by=$1,used_at=NOW() WHERE id=$2',[sess.user.id,k.id]);
        await db('UPDATE users SET balance=COALESCE(balance,0)+$1 WHERE id=$2',[k.amount,sess.user.id]);
        var nr = await db('SELECT balance FROM users WHERE id=$1',[sess.user.id]);
        return send(res, 200, { ok: true, type: 'balance', amount: parseFloat(k.amount), balance: parseFloat(nr.rows[0].balance||0) });
      }
      return send(res, 400, { error: 'Неверный формат ключа' });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/promos' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT p.*,u.username as owner_name FROM promo_codes p LEFT JOIN users u ON p.owner_id=u.id ORDER BY p.created_at DESC',[]);
      return send(res, 200, { promos: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/promos/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { code, discount, ownerLogin, isGlobal } = body;
    if (!code||!discount) return send(res, 400, { error: 'Укажите код и скидку' });
    try {
      var ownerId = null;
      if (ownerLogin) {
        var or = await db('SELECT id FROM users WHERE lower(username)=$1 LIMIT 1',[ownerLogin.toLowerCase()]);
        if (!or.rows.length) {
          var like = await db("SELECT username FROM users WHERE lower(username) LIKE $1 LIMIT 3",['%'+ownerLogin.toLowerCase()+'%']);
          return send(res, 404, { error: 'Не найден', similar: like.rows.map(function(u){ return u.username; }) });
        }
        ownerId = or.rows[0].id;
      }
      await db('INSERT INTO promo_codes (code,discount,owner_id,is_global) VALUES ($1,$2,$3,$4)',[code.toUpperCase(),parseInt(discount),ownerId,!!isGlobal]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/promos/check' && req.method === 'POST') {
    var { code } = body;
    if (!code) return send(res, 400, { error: 'Введите промокод' });
    try {
      var r = await db('SELECT p.*,u.username as owner_name FROM promo_codes p LEFT JOIN users u ON p.owner_id=u.id WHERE p.code=$1 LIMIT 1',[code.toUpperCase()]);
      if (!r.rows.length) return send(res, 404, { error: 'Промокод не найден' });
      return send(res, 200, { promo: r.rows[0] });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/withdrawals/request' && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var { amount } = body;
    if (!amount||amount <= 0) return send(res, 400, { error: 'Укажите сумму' });
    try {
      var r = await db('SELECT media_balance FROM users WHERE id=$1',[sess.user.id]);
      if (!r.rows.length||parseFloat(r.rows[0].media_balance) < amount) return send(res, 400, { error: 'Недостаточно средств' });
      await db('INSERT INTO withdrawal_requests (user_id,amount) VALUES ($1,$2)',[sess.user.id,amount]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/withdrawals/history' && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT * FROM withdrawal_requests WHERE user_id=$1 ORDER BY requested_at DESC',[sess.user.id]);
      return send(res, 200, { history: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db("SELECT w.*,u.username FROM withdrawal_requests w JOIN users u ON w.user_id=u.id WHERE w.status='pending' ORDER BY w.requested_at DESC",[]);
      return send(res, 200, { withdrawals: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/withdrawals/accept' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { id } = body;
    try {
      var r = await db('SELECT * FROM withdrawal_requests WHERE id=$1',[id]);
      if (!r.rows.length) return send(res, 404, { error: 'Не найдено' });
      var w = r.rows[0];
      await db("UPDATE withdrawal_requests SET status='accepted',resolved_at=NOW() WHERE id=$1",[id]);
      await db('UPDATE users SET media_balance=GREATEST(0,media_balance-$1) WHERE id=$2',[w.amount,w.user_id]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/withdrawals/reject' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { id, reason } = body;
    if (!reason) return send(res, 400, { error: 'Укажите причину' });
    try {
      await db("UPDATE withdrawal_requests SET status='rejected',reject_reason=$1,resolved_at=NOW() WHERE id=$2",[reason,id]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/admin/user-lookup' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var url = new URL(req.url,'http://localhost');
    var q = (url.searchParams.get('q')||'').toLowerCase();
    if (!q) return send(res, 400, { error: 'Введите логин' });
    try {
      var exact = await db('SELECT id,username,email,role,prefix FROM users WHERE lower(username)=$1 LIMIT 1',[q]);
      if (exact.rows.length) return send(res, 200, { user: exact.rows[0] });
      var like = await db("SELECT id,username FROM users WHERE lower(username) LIKE $1 LIMIT 3",['%'+q+'%']);
      return send(res, 404, { error: 'Не найден', similar: like.rows.map(function(u){ return u.username; }) });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  // ===== Balance keys ($) =====
  if (pathname === '/api/admin/balance-keys' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT * FROM balance_keys ORDER BY created_at DESC',[]);
      return send(res, 200, { keys: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname === '/api/admin/balance-keys/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var amount = parseFloat(body.amount);
    if (!amount || isNaN(amount) || amount <= 0) return send(res, 400, { error: 'Введите корректную сумму' });
    if (amount > 1000000) return send(res, 400, { error: 'Слишком большая сумма' });
    try {
      var key = genKey('BAL');
      await db('INSERT INTO balance_keys (key,amount,created_by) VALUES ($1,$2,$3)',[key,amount,sess.user.id]);
      return send(res, 200, { ok: true, key, amount });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname === '/api/balance/activate' && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var keyUp = (body.key||'').trim().toUpperCase();
    if (!keyUp) return send(res, 400, { error: 'Введите ключ' });
    try {
      // also check BAL prefix
      if (keyUp.startsWith('BAL-')) {
        var r = await db('SELECT * FROM balance_keys WHERE key=$1 AND used=FALSE LIMIT 1',[keyUp]);
        if (!r.rows.length) return send(res, 404, { error: 'Ключ не найден или использован' });
        var k = r.rows[0];
        await db('UPDATE balance_keys SET used=TRUE,used_by=$1,used_at=NOW() WHERE id=$2',[sess.user.id,k.id]);
        await db('UPDATE users SET balance=COALESCE(balance,0)+$1 WHERE id=$2',[k.amount,sess.user.id]);
        var nr = await db('SELECT balance FROM users WHERE id=$1',[sess.user.id]);
        return send(res, 200, { ok: true, type: 'balance', amount: parseFloat(k.amount), balance: parseFloat(nr.rows[0].balance||0) });
      }
      return send(res, 400, { error: 'Неверный формат ключа' });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname === '/api/balance/me' && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT balance FROM users WHERE id=$1',[sess.user.id]);
      return send(res, 200, { balance: parseFloat((r.rows[0]||{}).balance||0) });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  // ===== Scripts =====
  if (pathname === '/api/scripts/create' && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var urow = await db('SELECT * FROM users WHERE id=$1',[sess.user.id]);
      if (!urow.rows.length) return send(res, 401, { error: 'Не авторизован' });
      var u = buildUser(urow.rows[0]);
      if (!isAlphaUser(u)) return send(res, 403, { error: 'Доступ только для Alpha пользователей' });
      var title = (body.title||'').trim();
      var description = (body.description||'').trim();
      var previewImage = (body.previewImage||'').trim();
      var fileName = (body.fileName||'').trim();
      var fileData = body.fileData||'';
      var fileSize = parseInt(body.fileSize||0);
      var price = body.isFree ? 0 : parseFloat(body.price||0);
      var isFree = !!body.isFree;
      if (!title || title.length < 3) return send(res, 400, { error: 'Название минимум 3 символа' });
      if (title.length > 80) return send(res, 400, { error: 'Название слишком длинное' });
      if (!description || description.length < 10) return send(res, 400, { error: 'Описание минимум 10 символов' });
      if (!previewImage) return send(res, 400, { error: 'Загрузите превью' });
      if (!fileName || !fileData) return send(res, 400, { error: 'Прикрепите файл скрипта' });
      var ext = fileName.split('.').pop().toLowerCase();
      var allowed = ['lua','png','img','jpg','jpeg','zip'];
      if (allowed.indexOf(ext)===-1) return send(res, 400, { error: 'Недопустимый формат файла' });
      if (fileSize > 30*1024*1024) return send(res, 400, { error: 'Файл до 30 МБ' });
      if (!isFree) {
        if (!price || isNaN(price) || price <= 0) return send(res, 400, { error: 'Укажите цену цифрами' });
        if (price > 100000) return send(res, 400, { error: 'Цена слишком большая' });
        if (!/^\d+(\.\d+)?$/.test(String(body.price))) return send(res, 400, { error: 'Цена только цифры' });
      }
      var r = await db('INSERT INTO scripts (author_id,author_username,title,description,preview_image,file_name,file_data,file_size,file_ext,price,is_free,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',[sess.user.id,sess.user.username,title,description,previewImage,fileName,fileData,fileSize,ext,price,isFree,'pending']);
      return send(res, 201, { ok: true, id: r.rows[0].id });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/scripts' && req.method === 'GET') {
    // approved scripts market
    try {
      var url = new URL(req.url,'http://localhost');
      var page = parseInt(url.searchParams.get('page')||'1');
      var limit = parseInt(url.searchParams.get('limit')||'20');
      var offset = (page-1)*limit;
      var total = await db("SELECT COUNT(*) FROM scripts WHERE status='approved'",[]);
      var r = await db("SELECT id,author_id,author_username,title,description,preview_image,price,is_free,created_at FROM scripts WHERE status='approved' ORDER BY created_at DESC LIMIT $1 OFFSET $2",[limit,offset]);
      return send(res, 200, { scripts: r.rows, total: parseInt(total.rows[0].count), page, limit });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/scripts/my' && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT id,title,description,preview_image,price,is_free,status,created_at FROM scripts WHERE author_id=$1 ORDER BY created_at DESC',[sess.user.id]);
      return send(res, 200, { scripts: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname === '/api/scripts/purchased' && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT s.id,s.title,s.description,s.preview_image,s.price,s.is_free,s.author_username,sp.purchased_at, COALESCE(st.enabled,true) as enabled FROM script_purchases sp JOIN scripts s ON sp.script_id=s.id LEFT JOIN script_states st ON st.user_id=sp.user_id AND st.script_id=s.id WHERE sp.user_id=$1 ORDER BY sp.purchased_at DESC',[sess.user.id]);
      return send(res, 200, { scripts: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname.startsWith('/api/scripts/') && pathname.endsWith('/toggle') && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var sid = parseInt(pathname.split('/')[3]);
    if (!sid) return send(res, 400, { error: 'Bad id' });
    try {
      var purch = await db('SELECT id FROM script_purchases WHERE user_id=$1 AND script_id=$2',[sess.user.id,sid]);
      var own = await db('SELECT id FROM scripts WHERE id=$1 AND author_id=$2',[sid,sess.user.id]);
      if (!purch.rows.length && !own.rows.length) return send(res, 403, { error: 'Нет доступа к скрипту' });
      var cur = await db('SELECT enabled FROM script_states WHERE user_id=$1 AND script_id=$2',[sess.user.id,sid]);
      var nextVal = true;
      if (cur.rows.length) nextVal = !cur.rows[0].enabled;
      else nextVal = false; // if not exists, default true -> toggle to false
      // Actually if no row, treat as enabled true, so next is false
      // Insert or update
      await db('INSERT INTO script_states (user_id,script_id,enabled,updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (user_id,script_id) DO UPDATE SET enabled=$3,updated_at=NOW()',[sess.user.id,sid,nextVal]);
      // For first toggle when no row exists, we inserted false, but should be true->false correct.
      // If we want to handle case where no row means enabled true, above is correct.
      // Edge: second toggle will fetch false and set true.
      return send(res, 200, { ok: true, enabled: nextVal });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname.startsWith('/api/scripts/') && pathname.endsWith('/buy') && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var sid = parseInt(pathname.split('/')[3]);
    try {
      var s = await db("SELECT * FROM scripts WHERE id=$1 AND status='approved'",[sid]);
      if (!s.rows.length) return send(res, 404, { error: 'Скрипт не найден' });
      var script = s.rows[0];
      if (script.is_free) return send(res, 400, { error: 'Скрипт бесплатный' });
      var exists = await db('SELECT id FROM script_purchases WHERE user_id=$1 AND script_id=$2',[sess.user.id,sid]);
      if (exists.rows.length) return send(res, 400, { error: 'Уже куплено' });
      if (script.author_id === sess.user.id) return send(res, 400, { error: 'Свой скрипт' });
      var u = await db('SELECT balance FROM users WHERE id=$1',[sess.user.id]);
      var bal = parseFloat(u.rows[0].balance||0);
      if (bal < parseFloat(script.price)) return send(res, 400, { error: 'Недостаточно средств. Нужно ' + script.price + '$' });
      await db('UPDATE users SET balance=balance-$1 WHERE id=$2',[script.price,sess.user.id]);
      await db('INSERT INTO script_purchases (user_id,script_id,price_paid) VALUES ($1,$2,$3)',[sess.user.id,sid,script.price]);
      await db('INSERT INTO script_states (user_id,script_id,enabled) VALUES ($1,$2,true) ON CONFLICT (user_id,script_id) DO UPDATE SET enabled=true',[sess.user.id,sid]);
      // Also for author's DB sync as per prompt: after purchase still available via client
      var nb = await db('SELECT balance FROM users WHERE id=$1',[sess.user.id]);
      return send(res, 200, { ok: true, balance: parseFloat(nb.rows[0].balance||0) });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname.startsWith('/api/scripts/') && pathname.endsWith('/download') && req.method === 'POST') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var sid = parseInt(pathname.split('/')[3]);
    try {
      var s = await db("SELECT * FROM scripts WHERE id=$1 AND status='approved'",[sid]);
      if (!s.rows.length) return send(res, 404, { error: 'Скрипт не найден' });
      var script = s.rows[0];
      if (!script.is_free) return send(res, 400, { error: 'Скрипт платный, используйте покупку' });
      var ex = await db('SELECT id FROM script_purchases WHERE user_id=$1 AND script_id=$2',[sess.user.id,sid]);
      if (!ex.rows.length) {
        await db('INSERT INTO script_purchases (user_id,script_id,price_paid) VALUES ($1,$2,0)',[sess.user.id,sid]);
        await db('INSERT INTO script_states (user_id,script_id,enabled) VALUES ($1,$2,true) ON CONFLICT (user_id,script_id) DO UPDATE SET enabled=true',[sess.user.id,sid]);
      }
      return send(res, 200, { ok: true, fileName: script.file_name, fileData: script.file_data });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname.match(/^\/api\/scripts\/\d+$/) && req.method === 'GET') {
    var sid = parseInt(pathname.split('/')[3]);
    try {
      var r = await db('SELECT id,author_id,author_username,title,description,preview_image,price,is_free,status,created_at FROM scripts WHERE id=$1',[sid]);
      if (!r.rows.length) return send(res, 404, { error: 'Не найден' });
      // if not approved and not admin/author -> hide
      var sc = r.rows[0];
      if (sc.status !== 'approved') {
        if (!sess || (sess.user.id !== sc.author_id && sess.user.role !== 'admin')) return send(res, 403, { error: 'Скрыт' });
      }
      return send(res, 200, { script: sc });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  if (pathname.startsWith('/api/scripts/') && pathname.endsWith('/file') && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    var sid = parseInt(pathname.split('/')[3]);
    try {
      var s = await db('SELECT * FROM scripts WHERE id=$1',[sid]);
      if (!s.rows.length) return send(res, 404, { error: 'Не найден' });
      var script = s.rows[0];
      var hasPurchase = await db('SELECT id FROM script_purchases WHERE user_id=$1 AND script_id=$2',[sess.user.id,sid]);
      var isAuthor = script.author_id === sess.user.id;
      var isAdmin = sess.user.role === 'admin';
      if (!hasPurchase.rows.length && !isAuthor && !isAdmin && !script.is_free) return send(res, 403, { error: 'Купите скрипт' });
      if (script.status !== 'approved' && !isAuthor && !isAdmin) return send(res, 403, { error: 'Скрыт' });
      return send(res, 200, { fileName: script.file_name, fileData: script.file_data, fileSize: script.file_size });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  // Admin scripts moderation
  if (pathname === '/api/admin/scripts/pending' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db("SELECT id,author_id,author_username,title,description,preview_image,price,is_free,file_name,file_size,status,created_at FROM scripts WHERE status='pending' ORDER BY created_at DESC",[]);
      return send(res, 200, { scripts: r.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname.startsWith('/api/admin/scripts/') && pathname.endsWith('/approve') && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var sid = parseInt(pathname.split('/')[4]);
    try {
      var r = await db('SELECT * FROM scripts WHERE id=$1',[sid]);
      if (!r.rows.length) return send(res, 404, { error: 'Не найден' });
      await db("UPDATE scripts SET status='approved',approved_at=NOW(),approved_by=$1 WHERE id=$2",[sess.user.id,sid]);
      // grant to author's DB as per prompt: "Добавляет, она скачает на бд к моему юзеру" - ensure author has purchase/state
      var authorId = r.rows[0].author_id;
      await db('INSERT INTO script_purchases (user_id,script_id,price_paid) VALUES ($1,$2,0) ON CONFLICT (user_id,script_id) DO NOTHING',[authorId,sid]);
      await db('INSERT INTO script_states (user_id,script_id,enabled) VALUES ($1,$2,true) ON CONFLICT (user_id,script_id) DO UPDATE SET enabled=true',[authorId,sid]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }
  if (pathname.startsWith('/api/admin/scripts/') && pathname.endsWith('/reject') && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var sid = parseInt(pathname.split('/')[4]);
    var reason = (body.reason||'').trim();
    try {
      await db("UPDATE scripts SET status='rejected',reject_reason=$1 WHERE id=$2",[reason||'Отклонено',sid]);
      return send(res, 200, { ok: true });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  // Client integration: list enabled scripts for client
  if (pathname === '/api/client/scripts' && req.method === 'GET') {
    var url = new URL(req.url,'http://localhost');
    var token = (url.searchParams.get('token')||req.headers['authorization']||'').replace('Bearer ','').trim();
    var hwid = (url.searchParams.get('hwid')||'').trim();
    if (!token) return send(res, 401, { error: 'missing_token' });
    try {
      var ur = await db('SELECT * FROM users WHERE session_token=$1 LIMIT 1',[token]);
      if (!ur.rows.length) return send(res, 401, { error: 'session_expired' });
      var row = ur.rows[0];
      if (hwid && row.hwid && row.hwid !== hwid) return send(res, 403, { error: 'device_mismatch' });
      // get enabled purchased scripts
      var scripts = await db('SELECT s.id,s.title,s.file_name,s.file_data, s.preview_image, st.enabled FROM script_purchases sp JOIN scripts s ON sp.script_id=s.id LEFT JOIN script_states st ON st.user_id=sp.user_id AND st.script_id=s.id WHERE sp.user_id=$1 AND COALESCE(st.enabled,true)=true AND s.status=$2',[row.id,'approved']);
      return send(res, 200, { scripts: scripts.rows });
    } catch(e) { console.error(e); return sendError(res, 500, 'Internal server error'); }
  }

  send(res, 404, { error: 'Not found' });
}

var server = http.createServer(async function(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var pathname = url.pathname;
  if (pathname.startsWith('/api/')) {
    var body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readBody(req); } catch(e) { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    return handleApi(req, res, pathname, body);
  }
  if (!isSafeRelativePath(pathname)) return res.writeHead(403), res.end('403');
  if (pathname === '/.env' || pathname.startsWith('/.git') || pathname === '/server.js' || pathname === '/package.json' || pathname === '/package-lock.json') {
    return res.writeHead(404), res.end('404');
  }
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(PUBLIC_DIR,'index.html'));
  var fp = path.join(PUBLIC_DIR, pathname);
  if (!fp.startsWith(PUBLIC_DIR)) return res.writeHead(403), res.end('403');
  if (path.basename(fp).startsWith('.')) return res.writeHead(404), res.end('404');
  fs.stat(fp, function(err, st) {
    if (!err && st.isFile()) return serveFile(res, fp);
    res.writeHead(404); res.end('404');
  });
});

server.listen(PORT, function() { console.log('NoryxDLC running on :' + PORT); });
