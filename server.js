require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT   = process.env.PORT || 3001;
const ROOT   = __dirname;
const DB_URL = process.env.DB_URL;

const MIME_MAP = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.webp':'image/webp','.json':'application/json','.txt':'text/plain'
};

const pool = new Pool({ connectionString: DB_URL });
const sessions = {};

function genToken() { return crypto.randomBytes(32).toString('hex'); }

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
  return 'noryx_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (60*60*24*30);
}
function clearCookie() { return 'noryx_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'; }

function getSession(req) {
  var t = parseCookies(req)['noryx_session'];
  if (!t) return null;
  var s = sessions[t];
  if (!s || s.expires < Date.now()) { delete sessions[t]; return null; }
  return { token: t, user: s.user };
}
function createSession(user) {
  var t = genToken();
  sessions[t] = { user, expires: Date.now() + 864e5 * 30 };
  return t;
}
function destroySession(t) { delete sessions[t]; }

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var b = '';
    req.on('data', function(c) { b += c; });
    req.on('end', function() { try { resolve(b ? JSON.parse(b) : {}); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, data, extra) {
  var h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true'
  }, extra || {});
  res.writeHead(status, h);
  res.end(JSON.stringify(data));
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
  var seg = function() {
    var s = '';
    for (var i = 0; i < 4; i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  };
  return prefix + '-' + seg() + '-' + seg() + '-' + seg() + '-' + seg();
}

function buildUser(row) {
  return {
    id: row.id, username: row.username, email: row.email, role: row.role,
    prefix: row.prefix || null, prefixColor: row.prefix_color || null,
    subscriptionType: row.subscription_type, subscriptionExpiresAt: row.subscription_expires_at,
    createdAt: row.created_at, mediaChannel: row.media_channel || null,
    mediaBalance: parseFloat(row.media_balance) || 0,
    mediaPromoCode: row.media_promo_code || null, mediaSince: row.media_since || null
  };
}

function isSubActive(row) {
  if (row.role === 'admin' || (row.username && row.username.toLowerCase() === 'illusiononce')) return true;
  return !!(row.subscription_type && row.subscription_expires_at && new Date(row.subscription_expires_at) > new Date());
}

async function handleApi(req, res, pathname, body) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Credentials':'true'
    });
    return res.end();
  }

  if (pathname === '/api/health') return send(res, 200, { ok: true });

  if (pathname === '/api/register' && req.method === 'POST') {
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
      return send(res, 201, { user: buildUser(r.rows[0]) }, { 'Set-Cookie': setCookie(token) });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    var login = (body.login||body.email||'').trim().toLowerCase();
    var password = body.password||'';
    if (!login||!password) return send(res, 400, { error: 'Заполните все поля' });
    try {
      var r = await db('SELECT * FROM users WHERE email=$1 OR lower(username)=$1 LIMIT 1',[login]);
      if (!r.rows.length) return send(res, 401, { error: 'Неверный логин или пароль' });
      var row = r.rows[0];
      if (password !== row.password) return send(res, 401, { error: 'Неверный логин или пароль' });
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
      return send(res, 200, { user }, { 'Set-Cookie': setCookie(token) });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
      sessions[sess.token].user = user;
      return send(res, 200, { user });
    } catch(e) { return send(res, 200, { user: sess.user }); }
  }

  if (pathname === '/api/client/login' && req.method === 'POST') {
    var login    = (body.login    || '').trim().toLowerCase();
    var password = (body.password || '');
    var hwid     = (body.hwid     || '').trim();
    if (!login || !password || !hwid) return send(res, 400, { error: 'missing_fields' });
    try {
      var r = await db('SELECT * FROM users WHERE email=$1 OR lower(username)=$1 LIMIT 1', [login]);
      if (!r.rows.length) return send(res, 401, { error: 'wrong_credentials' });
      var row = r.rows[0];
      if (password !== row.password) return send(res, 401, { error: 'wrong_credentials' });
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
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  var sess = getSession(req);

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var url = new URL(req.url,'http://localhost');
    var page = parseInt(url.searchParams.get('page')||'1');
    var limit = 10; var offset = (page-1)*limit;
    try {
      var total = await db('SELECT COUNT(*) FROM users',[]);
      var r = await db('SELECT id,username,email,role,prefix,subscription_type,created_at FROM users ORDER BY id DESC LIMIT $1 OFFSET $2',[limit,offset]);
      return send(res, 200, { users: r.rows, total: parseInt(total.rows[0].count), page, limit });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/unban' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId } = body;
    try {
      await db('UPDATE users SET banned_until=NULL,ban_reason=NULL WHERE id=$1',[userId]);
      await db('UPDATE ban_history SET unbanned_at=NOW() WHERE user_id=$1 AND unbanned_at IS NULL',[userId]);
      return send(res, 200, { ok: true });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/banned' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db("SELECT u.id,u.username,b.reason,b.banned_at,b.banned_until FROM users u JOIN ban_history b ON b.user_id=u.id WHERE b.unbanned_at IS NULL ORDER BY b.banned_at DESC",[]);
      return send(res, 200, { banned: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
      var promo = 'NORYX-' + r.rows[0].username.toUpperCase().slice(0,8);
      await db("UPDATE users SET role='media',subscription_type='vip',media_channel=$1,media_since=NOW(),media_promo_code=$2 WHERE id=$3",[channel,promo,r.rows[0].id]);
      return send(res, 200, { ok: true, promo });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/remove-media' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId } = body;
    try {
      await db("UPDATE users SET role='user',media_channel=NULL,media_since=NULL WHERE id=$1",[userId]);
      return send(res, 200, { ok: true });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }
  
  if (pathname === '/api/admin/give-balance' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { userId, amount } = body;
    try {
      await db('UPDATE users SET media_balance=media_balance+$1 WHERE id=$2',[parseFloat(amount),userId]);
      return send(res, 200, { ok: true });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/role-keys' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT * FROM role_keys ORDER BY created_at DESC',[]);
      return send(res, 200, { keys: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/role-keys/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { roleName, roleColor, duration } = body;
    if (!roleName||!roleColor||!duration) return send(res, 400, { error: 'Все поля обязательны' });
    try {
      var key = genKey('ROLE');
      await db('INSERT INTO role_keys (key,role_name,role_color,duration) VALUES ($1,$2,$3,$4)',[key,roleName,roleColor,duration]);
      return send(res, 200, { ok: true, key });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/prefix-keys' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT * FROM prefix_keys ORDER BY created_at DESC',[]);
      return send(res, 200, { keys: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/prefix-keys/create' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { prefixText, prefixColor } = body;
    if (!prefixText||!prefixColor) return send(res, 400, { error: 'Введите текст и цвет' });
    try {
      var key = genKey('PFX');
      await db('INSERT INTO prefix_keys (key,prefix_text,prefix_color) VALUES ($1,$2,$3)',[key,prefixText,prefixColor]);
      return send(res, 200, { ok: true, key });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
      return send(res, 400, { error: 'Неверный формат ключа' });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/promos' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db('SELECT p.*,u.username as owner_name FROM promo_codes p LEFT JOIN users u ON p.owner_id=u.id ORDER BY p.created_at DESC',[]);
      return send(res, 200, { promos: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/promos/check' && req.method === 'POST') {
    var { code } = body;
    if (!code) return send(res, 400, { error: 'Введите промокод' });
    try {
      var r = await db('SELECT p.*,u.username as owner_name FROM promo_codes p LEFT JOIN users u ON p.owner_id=u.id WHERE p.code=$1 LIMIT 1',[code.toUpperCase()]);
      if (!r.rows.length) return send(res, 404, { error: 'Промокод не найден' });
      return send(res, 200, { promo: r.rows[0] });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/withdrawals/history' && req.method === 'GET') {
    if (!sess) return send(res, 401, { error: 'Не авторизован' });
    try {
      var r = await db('SELECT * FROM withdrawal_requests WHERE user_id=$1 ORDER BY requested_at DESC',[sess.user.id]);
      return send(res, 200, { history: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    try {
      var r = await db("SELECT w.*,u.username FROM withdrawal_requests w JOIN users u ON w.user_id=u.id WHERE w.status='pending' ORDER BY w.requested_at DESC",[]);
      return send(res, 200, { withdrawals: r.rows });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/admin/withdrawals/reject' && req.method === 'POST') {
    if (!sess||sess.user.role!=='admin') return send(res, 403, { error: 'Нет доступа' });
    var { id, reason } = body;
    if (!reason) return send(res, 400, { error: 'Укажите причину' });
    try {
      await db("UPDATE withdrawal_requests SET status='rejected',reject_reason=$1,resolved_at=NOW() WHERE id=$2",[reason,id]);
      return send(res, 200, { ok: true });
    } catch(e) { return send(res, 500, { error: e.message }); }
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
    } catch(e) { return send(res, 500, { error: e.message }); }
  }

  send(res, 404, { error: 'Not found' });
}

var server = http.createServer(async function(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var pathname = url.pathname;
  res.setHeader('X-Content-Type-Options','nosniff');
  if (pathname.startsWith('/api/')) {
    var body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try { body = await readBody(req); } catch(e) { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    return handleApi(req, res, pathname, body);
  }
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(ROOT,'index.html'));
  var fp = path.join(ROOT, pathname);
  fs.stat(fp, function(err, st) {
    if (!err && st.isFile()) return serveFile(res, fp);
    res.writeHead(404); res.end('404');
  });
});

server.listen(PORT, function() { console.log('NoryxDLC running on :' + PORT); });
