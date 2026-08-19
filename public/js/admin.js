var adminCurrentPage = { users: 1, media: 1 };
function getCsrfToken() { return localStorage.getItem('noryx_csrf') || ''; }
function csrfHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  var token = getCsrfToken();
  if (token) headers['X-CSRF-Token'] = token;
  return headers;
}

document.addEventListener('DOMContentLoaded', function () {
  applyStoredTheme();
  checkAdminAccess();
});

function applyStoredTheme() {
  var COLOR_MAP = {
    'pink':'#EC4899','red':'#EF4444','purple':'#7C3AED','green':'#4ADE80',
    'blue':'#3B82F6','cyan':'#06B6D4','gold':'#F59E0B','white':'#FFFFFF',
    'gray':'#6B7280','black':'#111111'
  };
  var savedColor = localStorage.getItem('noryx_color');
  var savedBg    = localStorage.getItem('noryx_bg');
  if (savedColor && COLOR_MAP[savedColor]) {
    document.documentElement.style.setProperty('--primary', COLOR_MAP[savedColor]);
    document.documentElement.style.setProperty('--primary-dark', COLOR_MAP[savedColor]);
  }
  if (savedBg) {
    var bgEl = document.getElementById('bgFull');
    if (bgEl) bgEl.style.backgroundImage = 'url("' + savedBg + '")';
  }
}

async function checkAdminAccess() {
  try {
    var r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) { window.location.href = '/html/login.html'; return; }
    var data = await r.json();
    if (data.csrfToken) localStorage.setItem('noryx_csrf', data.csrfToken);
    if ((data.user || data).role !== 'admin') { window.location.href = '/html/profile.html'; return; }
    adminTab('users', document.querySelector('.sidebar-item'));
    loadUsers(1);
  } catch(e) { window.location.href = '/html/profile.html'; }
}

function adminTab(name, btn) {
  document.querySelectorAll('.admin-tab').forEach(function(el) { el.style.display = 'none'; });
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
  var tab = document.getElementById('atab-' + name);
  if (tab) tab.style.display = '';
  if (btn) btn.classList.add('active');
  var titles = {
    users:'Пользователи', promos:'Промокоды', keys:'Создание ключей',
    media:'Управление MEDIA', ban:'Заблокировать юзера',
    'give-media':'Выдать MEDIA', withdrawals:'Выводы MEDIA'
  };
  setText('admin-title', titles[name] || name);
  if (name === 'users') loadUsers(adminCurrentPage.users);
  if (name === 'promos') loadPromos();
  if (name === 'keys') { loadRoleKeys(); loadPrefixKeys(); }
  if (name === 'media') loadMedia(adminCurrentPage.media);
  if (name === 'ban') loadBanned();
  if (name === 'withdrawals') loadWithdrawals();
}

async function loadUsers(page) {
  adminCurrentPage.users = page;
  try {
    var r = await fetch('/api/admin/users?page=' + page, { credentials: 'include' });
    var data = await r.json();
    renderUsers(data.users || [], data.total || 0, page, data.limit || 10);
  } catch(e) { setText('users-tbody', 'Ошибка загрузки'); }
}

function renderUsers(users, total, page, limit) {
  var tbody = document.getElementById('users-table');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = '<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.3)">Нет пользователей</div>';
  } else {
    var ROLE_COLORS = { admin:'#EF4444', media:'#A855F7', moderator:'#3B82F6', vip:'#F59E0B', alpha:'#7C3AED', beta:'#F59E0B', user:'#6B7280' };
    tbody.innerHTML = '';
    users.forEach(function(u) {
      var rColor = ROLE_COLORS[u.role] || '#6B7280';
      var div = document.createElement('div');
      div.className = 'users-row';
      div.innerHTML =
        '<div class="users-row-name">' + esc(u.username) + '</div>' +
        '<div class="users-row-meta">' +
          '<span>📧 ' + esc(u.email) + '</span>' +
          '<span>Роль: <b style="color:' + rColor + '">' + esc(u.role) + '</b></span>' +
          '<span>Префикс: ' + esc(u.prefix || '—') + '</span>' +
          '<span>Дата: ' + new Date(u.created_at).toLocaleDateString('ru-RU') + '</span>' +
        '</div>';
      tbody.appendChild(div);
    });
  }
  renderPagination('users-pagination', total, page, limit, function(p) { loadUsers(p); });
}

function renderPagination(id, total, page, limit, onPage) {
  var el = document.getElementById(id);
  if (!el) return;
  var totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<button class="pg-btn" onclick="void(0)" id="' + id + '-prev"' + (page <= 1 ? ' disabled' : '') + '>‹</button>' +
    '<span class="pg-label">' + page + ' / ' + totalPages + '</span>' +
    '<button class="pg-btn" id="' + id + '-next"' + (page >= totalPages ? ' disabled' : '') + '>›</button>';
  var prev = document.getElementById(id + '-prev');
  var next = document.getElementById(id + '-next');
  if (prev && page > 1) prev.onclick = function() { onPage(page - 1); };
  if (next && page < totalPages) next.onclick = function() { onPage(page + 1); };
}

async function loadPromos() {
  try {
    var r = await fetch('/api/admin/promos', { credentials: 'include' });
    var data = await r.json();
    renderPromos(data.promos || []);
  } catch(e) {}
}

function renderPromos(promos) {
  var list = document.getElementById('promos-list');
  if (!list) return;
  if (!promos.length) { list.innerHTML = '<p style="color:rgba(255,255,255,0.3)">Промокодов нет</p>'; return; }
  list.innerHTML = '';
  promos.forEach(function(p) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:14px;border:1px solid rgba(255,255,255,0.1);border-radius:14px;margin-bottom:10px;cursor:pointer;transition:border-color 0.2s';
    div.innerHTML =
      '<div style="font-weight:700;font-size:16px;color:#fff">' + esc(p.code) + '</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Использование: ' + (p.use_count||0) + ' | Чей промокод: ' + esc(p.owner_name||'Общий') + ' | Скидка: ' + p.discount + '%</div>';
    list.appendChild(div);
  });
}

async function createPromo() {
  var code = (document.getElementById('promo-code').value || '').trim().toUpperCase();
  var discount = parseInt(document.getElementById('promo-discount').value || '0');
  var ownerLogin = (document.getElementById('promo-owner').value || '').trim();
  var isGlobal = !ownerLogin;
  var errEl = document.getElementById('promo-err');
  if (!code || !discount) { showEl(errEl, 'Введите код и скидку', '#EF4444'); return; }
  try {
    var r = await fetch('/api/admin/promos/create', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ code, discount, ownerLogin: ownerLogin || undefined, isGlobal })
    });
    var data = await r.json();
    if (!r.ok) {
      var msg = data.error;
      if (data.similar && data.similar.length) msg += '. Похожие: ' + data.similar.join(', ');
      showEl(errEl, msg, '#EF4444'); return;
    }
    showEl(errEl, '✓ Промокод создан!', 'var(--success)');
    document.getElementById('promo-code').value = '';
    document.getElementById('promo-discount').value = '';
    document.getElementById('promo-owner').value = '';
    loadPromos();
  } catch(e) { showEl(errEl, 'Ошибка сети', '#EF4444'); }
}

async function createRoleKey() {
  var roleName  = (document.getElementById('role-name').value || '').trim();
  var roleColor = document.getElementById('role-color').value || '';
  var duration  = document.getElementById('role-duration').value || '';
  var errEl = document.getElementById('role-key-err');
  var resEl = document.getElementById('role-key-result');
  if (!roleName || !duration) { showEl(errEl, 'Заполните все поля', '#EF4444'); resEl.style.display='none'; return; }
  try {
    var r = await fetch('/api/admin/role-keys/create', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ roleName, roleColor, duration })
    });
    var data = await r.json();
    if (!r.ok) { showEl(errEl, data.error, '#EF4444'); resEl.style.display='none'; return; }
    errEl.style.display = 'none';
    document.getElementById('role-key-output').textContent = data.key;
    resEl.style.display = 'block';
    loadRoleKeys();
    setTimeout(function() { resEl.style.display = 'none'; }, 5 * 60 * 1000);
  } catch(e) { showEl(errEl, 'Ошибка сети', '#EF4444'); }
}

async function createPrefixKey() {
  var prefixText  = (document.getElementById('prefix-text').value || '').trim();
  var prefixColor = document.getElementById('prefix-color').value || '#ffffff';
  var errEl = document.getElementById('prefix-key-err');
  var resEl = document.getElementById('prefix-key-result');
  if (!prefixText) { showEl(errEl, 'Введите текст префикса', '#EF4444'); resEl.style.display='none'; return; }
  try {
    var r = await fetch('/api/admin/prefix-keys/create', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ prefixText, prefixColor })
    });
    var data = await r.json();
    if (!r.ok) { showEl(errEl, data.error, '#EF4444'); resEl.style.display='none'; return; }
    errEl.style.display = 'none';
    document.getElementById('prefix-key-output').textContent = data.key;
    resEl.style.display = 'block';
    loadPrefixKeys();
    setTimeout(function() { resEl.style.display = 'none'; }, 5 * 60 * 1000);
  } catch(e) { showEl(errEl, 'Ошибка сети', '#EF4444'); }
}

async function loadRoleKeys() {
  try {
    var r = await fetch('/api/admin/role-keys', { credentials: 'include' });
    var data = await r.json();
    renderKeyList('role-keys-list', data.keys || []);
  } catch(e) {}
}

async function loadPrefixKeys() {
  try {
    var r = await fetch('/api/admin/prefix-keys', { credentials: 'include' });
    var data = await r.json();
    renderKeyList('prefix-keys-list', data.keys || []);
  } catch(e) {}
}

function renderKeyList(id, keys) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!keys.length) { el.innerHTML = '<p style="color:rgba(255,255,255,0.3);font-size:13px">Ключей нет</p>'; return; }
  el.innerHTML = '';
  keys.forEach(function(k) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:10px 14px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:8px';
    var usedColor = k.used ? '#EF4444' : 'var(--success)';
    div.innerHTML =
      '<code style="font-size:12px;letter-spacing:1px;color:#fff;word-break:break-all">' + esc(k.key) + '</code>' +
      '<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">' +
        (k.role_name ? 'Роль: <b style="color:#fff">' + esc(k.role_name) + '</b> | Срок: ' + esc(k.duration) : 'Префикс: <b style="color:#fff">' + esc(k.prefix_text || '') + '</b>') +
        ' | <span style="color:' + usedColor + '">' + (k.used ? 'Использован' : 'Активен') + '</span>' +
      '</div>';
    el.appendChild(div);
  });
}

async function giveMedia() {
  var login = (document.getElementById('give-media-login').value || '').trim();
  var channel = (document.getElementById('give-media-channel').value || '').trim();
  var errEl = document.getElementById('give-media-err');
  if (!login || !channel) { showEl(errEl, 'Заполните все поля', '#EF4444'); return; }
  try {
    var r = await fetch('/api/admin/give-media', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ login, channel })
    });
    var data = await r.json();
    if (!r.ok) {
      var msg = data.error;
      if (data.similar && data.similar.length) msg += '. Похожие: ' + data.similar.join(', ');
      showEl(errEl, msg, '#EF4444'); return;
    }
    showEl(errEl, '✓ MEDIA выдан! Промокод: ' + data.promo, 'var(--success)');
    document.getElementById('give-media-login').value = '';
    document.getElementById('give-media-channel').value = '';
  } catch(e) { showEl(errEl, 'Ошибка сети', '#EF4444'); }
}

async function loadMedia(page) {
  adminCurrentPage.media = page;
  try {
    var r = await fetch('/api/admin/media-list?page=' + page, { credentials: 'include' });
    var data = await r.json();
    renderMedia(data.media || [], data.total || 0, page, data.limit || 10);
  } catch(e) {}
}

function renderMedia(media, total, page, limit) {
  var list = document.getElementById('media-list');
  if (!list) return;
  list.innerHTML = '';
  if (!media.length) { list.innerHTML = '<p style="color:rgba(255,255,255,0.3)">Нет MEDIA</p>'; }
  media.forEach(function(m) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:16px;border:1px solid rgba(255,255,255,0.1);border-radius:14px;margin-bottom:12px;cursor:pointer;transition:border-color 0.2s';
    div.innerHTML =
      '<div style="font-weight:700;color:#fff;font-size:15px">' + esc(m.username) + '</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Баланс: ' + parseFloat(m.media_balance||0).toFixed(2) + '₽ | MEDIA с: ' + (m.media_since ? new Date(m.media_since).toLocaleDateString('ru-RU') : '—') + ' | Канал: ' + esc(m.media_channel||'—') + '</div>';
    div.onclick = function() { openMediaCard(m); };
    list.appendChild(div);
  });
  renderPagination('media-pagination', total, page, limit, function(p) { loadMedia(p); });
}

function openMediaCard(m) {
  var overlay = document.getElementById('media-card-modal');
  if (!overlay) return;
  document.getElementById('mc-username').textContent = m.username;
  document.getElementById('mc-balance').textContent = parseFloat(m.media_balance||0).toFixed(2) + ' ₽';
  document.getElementById('mc-uid').value = m.id;
  document.getElementById('mc-give-amount').value = '';
  document.getElementById('mc-err').style.display = 'none';
  overlay.classList.remove('hidden');
}

function closeMediaCard() {
  var overlay = document.getElementById('media-card-modal');
  if (overlay) overlay.classList.add('hidden');
}

async function removeMedia() {
  var uid = document.getElementById('mc-uid').value;
  if (!confirm('Снять MEDIA?')) return;
  try {
    await fetch('/api/admin/remove-media', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ userId: uid })
    });
    closeMediaCard();
    loadMedia(adminCurrentPage.media);
  } catch(e) { alert('Ошибка'); }
}

async function giveBalance() {
  var uid = document.getElementById('mc-uid').value;
  var amount = parseFloat(document.getElementById('mc-give-amount').value);
  var errEl = document.getElementById('mc-err');
  if (!amount || amount <= 0) { showEl(errEl, 'Введите сумму', '#EF4444'); return; }
  try {
    var r = await fetch('/api/admin/give-balance', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ userId: uid, amount })
    });
    if (!r.ok) { showEl(errEl, 'Ошибка', '#EF4444'); return; }
    showEl(errEl, '✓ Баланс выдан', 'var(--success)');
    loadMedia(adminCurrentPage.media);
  } catch(e) { showEl(errEl, 'Ошибка', '#EF4444'); }
}

async function banUser() {
  var login = (document.getElementById('ban-login').value || '').trim();
  var duration = document.getElementById('ban-duration').value;
  var reason = (document.getElementById('ban-reason').value || '').trim();
  var errEl = document.getElementById('ban-err');
  if (!login || !duration || !reason) { showEl(errEl, 'Заполните все поля', '#EF4444'); return; }
  try {
    var r = await fetch('/api/admin/ban', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ login, duration, reason })
    });
    var data = await r.json();
    if (!r.ok) {
      var msg = data.error;
      if (data.similar && data.similar.length) msg += '. Найден похожий юзер: ' + data.similar.join(', ');
      showEl(errEl, msg, '#EF4444'); return;
    }
    showEl(errEl, '✓ Пользователь заблокирован', 'var(--success)');
    document.getElementById('ban-login').value = '';
    document.getElementById('ban-reason').value = '';
    loadBanned();
  } catch(e) { showEl(errEl, 'Ошибка сети', '#EF4444'); }
}

async function loadBanned() {
  try {
    var r = await fetch('/api/admin/banned', { credentials: 'include' });
    var data = await r.json();
    renderBanned(data.banned || []);
  } catch(e) {}
}

function renderBanned(list) {
  var el = document.getElementById('banned-list');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p style="color:rgba(255,255,255,0.3)">Забаненных нет</p>'; return; }
  el.innerHTML = '';
  list.forEach(function(b) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:14px;border:1px solid rgba(239,68,68,0.2);border-radius:14px;margin-bottom:10px';
    var until = b.banned_until ? (new Date(b.banned_until) > new Date('2090-01-01') ? 'Навсегда' : new Date(b.banned_until).toLocaleDateString('ru-RU')) : '—';
    div.innerHTML =
      '<div style="font-weight:700;color:#fff">' + esc(b.username) + '</div>' +
      '<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:4px">Забанен с: ' + new Date(b.banned_at).toLocaleDateString('ru-RU') + ' | Причина: ' + esc(b.reason) + ' | Разбан: ' + until + '</div>' +
      '<button class="btn-danger" style="margin-top:10px;font-size:13px" onclick="unbanUser(' + b.id + ',\'' + esc(b.username) + '\')">Разбанить ' + esc(b.username) + '</button>';
    el.appendChild(div);
  });
}

async function unbanUser(id, username) {
  if (!confirm('Разбанить ' + username + '?')) return;
  try {
    await fetch('/api/admin/unban', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ userId: id })
    });
    loadBanned();
  } catch(e) { alert('Ошибка'); }
}

async function loadWithdrawals() {
  try {
    var r = await fetch('/api/admin/withdrawals', { credentials: 'include' });
    var data = await r.json();
    renderWithdrawals(data.withdrawals || []);
  } catch(e) {}
}

function renderWithdrawals(list) {
  var el = document.getElementById('withdrawals-list');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p style="color:rgba(255,255,255,0.3)">Заявок нет</p>'; return; }
  el.innerHTML = '';
  list.forEach(function(w) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:16px;border:1px solid rgba(255,255,255,0.1);border-radius:14px;margin-bottom:12px';
    div.innerHTML =
      '<div style="font-weight:700;color:#fff">' + esc(w.username) + '</div>' +
      '<div style="color:rgba(255,255,255,0.4);font-size:13px;margin:6px 0">Запрос на вывод: <b style="color:var(--success)">' + parseFloat(w.amount).toFixed(2) + ' ₽</b></div>' +
      '<div style="display:flex;gap:10px;margin-top:10px">' +
        '<button class="btn-primary" style="font-size:13px;padding:8px 16px" onclick="acceptWithdrawal(' + w.id + ',this)">Принять</button>' +
        '<button class="btn-danger" style="font-size:13px" onclick="rejectWithdrawal(' + w.id + ')">Отклонить</button>' +
      '</div>' +
      '<div id="reject-form-' + w.id + '" style="display:none;margin-top:10px">' +
        '<input class="input-field" placeholder="Причина отказа" id="reject-reason-' + w.id + '" style="margin-bottom:8px">' +
        '<button class="btn-primary" style="font-size:13px;padding:8px 16px" onclick="sendReject(' + w.id + ')">Отправить</button>' +
      '</div>';
    el.appendChild(div);
  });
}

async function acceptWithdrawal(id, btn) {
  btn.disabled = true;
  try {
    var r = await fetch('/api/admin/withdrawals/accept', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ id })
    });
    if (r.ok) loadWithdrawals();
    else { btn.disabled = false; alert('Ошибка'); }
  } catch(e) { btn.disabled = false; }
}

function rejectWithdrawal(id) {
  var form = document.getElementById('reject-form-' + id);
  if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
}

async function sendReject(id) {
  var reason = (document.getElementById('reject-reason-' + id).value || '').trim();
  if (!reason) { alert('Введите причину'); return; }
  try {
    var r = await fetch('/api/admin/withdrawals/reject', {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ id, reason })
    });
    if (r.ok) loadWithdrawals();
  } catch(e) { alert('Ошибка'); }
}

function copyKey(id) {
  var el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(function() {
    var msg = document.getElementById(id + '-copy-msg');
    if (msg) { msg.style.display = 'block'; setTimeout(function() { msg.style.display = 'none'; }, 2000); }
  });
}

function showEl(el, text, color) {
  if (!el) return;
  el.textContent = text; el.style.color = color; el.style.display = 'block';
}
function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
