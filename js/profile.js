var currentUser = null;
var selectedColor = null;
var selectedBg = null;

var COLOR_MAP = {
  'pink':  { hex:'#EC4899', label:'Розовый',    folder:'pink',   bgCount:3 },
  'red':   { hex:'#EF4444', label:'Красный',     folder:'red',    bgCount:3 },
  'purple':{ hex:'#7C3AED', label:'Фиолетовый',  folder:'purple', bgCount:3 },
  'green': { hex:'#4ADE80', label:'Зелёный',     folder:'green',  bgCount:3 },
  'blue':  { hex:'#3B82F6', label:'Синий',       folder:'blue',   bgCount:3 },
  'cyan':  { hex:'#06B6D4', label:'Циан',        folder:'cyan',   bgCount:3 },
  'gold':  { hex:'#F59E0B', label:'Золотой',     folder:'gold',   bgCount:3 },
  'gray':  { hex:'#6B7280', label:'Серый',       folder:'gray',   bgCount:3 },
  'white': { hex:'#FFFFFF', label:'Белый',       folder:'white',  bgCount:3 },
  'black': { hex:'#111111', label:'Чёрный',      folder:'black',  bgCount:3 }
};

var ROLE_LABELS = {
  'user':'👤 Юзер','beta':'⭐ Beta','alpha':'💎 Alpha',
  'vip':'👑 VIP','media':'🎥 MEDIA','moderator':'🛡️ Модератор','admin':'🔴 Админ'
};

var SHOP_ITEMS = [
  { cat:'beta',   name:'BETA — 7 дней',    price:45,  dur:'7d',       type:'beta7' },
  { cat:'beta',   name:'BETA — 30 дней',   price:90,  dur:'30 дней',  type:'beta30' },
  { cat:'beta',   name:'BETA — 90 дней',   price:180, dur:'90 дней',  type:'beta90' },
  { cat:'beta',   name:'BETA — 180 дней',  price:230, dur:'180 дней', type:'beta180' },
  { cat:'beta',   name:'BETA — LIFETIME',  price:300, dur:'Навсегда', type:'betalife', lifetime:true },
  { cat:'alpha',  name:'Alpha — 7 дней',   price:80,  dur:'7 дней',   type:'alpha7' },
  { cat:'alpha',  name:'Alpha — 30 дней',  price:140, dur:'30 дней',  type:'alpha30' },
  { cat:'alpha',  name:'Alpha — 90 дней',  price:220, dur:'90 дней',  type:'alpha90' },
  { cat:'alpha',  name:'Alpha — 180 дней', price:300, dur:'180 дней', type:'alpha180' },
  { cat:'alpha',  name:'Alpha — LIFETIME', price:350, dur:'Навсегда', type:'alphalife', lifetime:true },
  { cat:'other',  name:'Сброс HWID',       price:75,  dur:'Разово',   type:'hwid', reqSub:true },
  { cat:'other',  name:'Докупить Alpha',   price:50,  dur:'Разово',   type:'addAlpha', reqSub:'betalife' },
  { cat:'other',  name:'Префикс',          price:50,  dur:'Навсегда', type:'prefix' }
];

document.addEventListener('DOMContentLoaded', function () {
  applyStoredTheme();
  loadProfile();
  var overlay = document.getElementById('shop-modal');
  if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });
});

function applyStoredTheme() {
  var savedColor = localStorage.getItem('noryx_color');
  var savedBg    = localStorage.getItem('noryx_bg');
  if (savedColor && COLOR_MAP[savedColor]) {
    document.documentElement.style.setProperty('--primary', COLOR_MAP[savedColor].hex);
    document.documentElement.style.setProperty('--primary-dark', COLOR_MAP[savedColor].hex);
  }
  if (savedBg) {
    var bgEl = document.getElementById('bgFull');
    if (bgEl) bgEl.style.backgroundImage = 'url("' + savedBg + '")';
  }
}

async function loadProfile() {
  try {
    var r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.ok) {
      var data = await r.json();
      currentUser = data.user;
      localStorage.setItem('noryx_user', JSON.stringify(currentUser));
      renderProfile(currentUser);
      return;
    }
  } catch(e) {}
  var stored = getStoredUser();
  if (stored) { currentUser = stored; renderProfile(currentUser); }
  else window.location.href = '/html/login.html';
}

function getStoredUser() {
  try { var u = localStorage.getItem('noryx_user'); return u ? JSON.parse(u) : null; } catch(e) { return null; }
}

function renderProfile(u) {
  setText('prof-username',  u.username || '');
  setText('prof-username2', u.username || '');
  setText('prof-id',        '#' + (u.id || ''));
  setText('prof-email',     u.email || '');
  setText('prof-created',   u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—');
  setText('prof-role',      ROLE_LABELS[u.role] || '👤 Юзер');

  var prefixEl = document.getElementById('prof-prefix');
  if (prefixEl) {
    if (u.prefix) {
      prefixEl.innerHTML = '<span style="color:' + esc(u.prefixColor || '#fff') + ';font-weight:700">' + esc(u.prefix) + '</span>';
    } else {
      prefixEl.innerHTML = '<span style="color:rgba(255,255,255,0.3)">Нет</span>';
    }
  }
  var prefixRow = document.getElementById('prof-prefix-row');
  if (prefixRow) prefixRow.style.display = '';

  var hasSub = u.subscriptionType && u.subscriptionType !== 'user' &&
    (!u.subscriptionExpiresAt || new Date(u.subscriptionExpiresAt) > new Date());
  var subEl = document.getElementById('prof-sub');
  if (subEl) {
    if (hasSub) {
      var label = u.subscriptionType === 'vip' ? 'VIP' : u.subscriptionType === 'alphalife' || u.subscriptionType === 'alpha' ? 'Alpha' : 'Beta';
      var expText = u.subscriptionExpiresAt ? ' до ' + new Date(u.subscriptionExpiresAt).toLocaleDateString('ru-RU') : ' — Навсегда';
      subEl.innerHTML = '<span style="color:var(--success);font-weight:600">✅ ' + label + expText + '</span>';
    } else {
      subEl.innerHTML = '<span style="color:rgba(255,255,255,0.3)">Нет подписки</span>';
    }
  }

  var dlBtn = document.getElementById('sidebar-download');
  if (dlBtn) dlBtn.style.display = hasSub || u.role === 'admin' || u.role === 'vip' ? 'flex' : 'none';

  var mediaBtn = document.getElementById('sidebar-media');
  if (mediaBtn) mediaBtn.style.display = u.role === 'media' || u.role === 'admin' ? 'flex' : 'none';

  var adminBtn = document.getElementById('sidebar-admin');
  if (adminBtn) adminBtn.style.display = u.role === 'admin' ? 'flex' : 'none';

  renderShop(u);
  renderColorCircles();

  if (u.role === 'media' || u.role === 'admin') renderMediaPanel(u);
  if (typeof renderDownloadButtons === 'function') renderDownloadButtons(u);
}

function renderShop(u) {
  var grid = document.getElementById('shop-grid');
  if (!grid) return;
  grid.innerHTML = '';

  var cats = ['beta', 'alpha', 'other'];
  var catLabels = { beta:'BETA', alpha:'Alpha', other:'Другое' };
  var catColors = { beta:'#F59E0B', alpha:'#7C3AED', other:'#6B7280' };

  cats.forEach(function(cat) {
    var items = SHOP_ITEMS.filter(function(i) { return i.cat === cat; });
    var catWrap = document.createElement('div');
    catWrap.className = 'shop-category';

    var catTitle = document.createElement('h3');
    catTitle.className = 'shop-category-title';
    catTitle.textContent = catLabels[cat];
    catTitle.style.color = catColors[cat];
    catWrap.appendChild(catTitle);

    var itemsWrap = document.createElement('div');
    itemsWrap.className = 'shop-items-list';

    items.forEach(function(item) {
      var hasSub = u.subscriptionType && u.subscriptionType !== 'user' &&
        (!u.subscriptionExpiresAt || new Date(u.subscriptionExpiresAt) > new Date());
      var disabled = item.reqSub && !hasSub;

      var div = document.createElement('div');
      div.className = 'tariff-item' + (item.lifetime ? ' lifetime' : '');
      div.style.cursor = disabled ? 'not-allowed' : 'pointer';

      div.innerHTML =
        '<div><div class="tariff-item-name">' + esc(item.name) + '</div>' +
        (item.dur ? '<div class="tariff-item-sub">' + esc(item.dur) + '</div>' : '') + '</div>' +
        '<span class="tariff-item-price" style="color:' + catColors[cat] + '">' + item.price + '₽</span>';

      if (!disabled) {
        div.addEventListener('click', function() {
          openModal(item.name, item.dur || '', item.price);
        });
      }

      itemsWrap.appendChild(div);
    });

    catWrap.appendChild(itemsWrap);
    grid.appendChild(catWrap);
  });
}

function openModal(name, sub, price) {
  setText('modal-name', name);
  setText('modal-sub', sub);
  setText('modal-price', price + '.00 ₽');
  var btn = document.getElementById('modal-pay-btn');
  if (btn) btn.textContent = 'Оплатить ' + price + '.00 ₽';
  document.getElementById('modal-promo-input').value = '';
  document.getElementById('modal-promo-msg').style.display = 'none';
  document.getElementById('modal-discount').style.display = 'none';
  var modal = document.getElementById('shop-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeModal() {
  var modal = document.getElementById('shop-modal');
  if (modal) modal.classList.add('hidden');
}

async function applyPromo() {
  var code = document.getElementById('modal-promo-input').value.trim();
  var msgEl = document.getElementById('modal-promo-msg');
  var discEl = document.getElementById('modal-discount');
  if (!code) { setMsg(msgEl, 'Введите промокод', '#EF4444'); return; }
  try {
    var r = await fetch('/api/promos/check', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    var data = await r.json();
    if (!r.ok) { setMsg(msgEl, data.error || 'Не найден', '#EF4444'); return; }
    var p = data.promo;
    setMsg(msgEl, '✓ Промокод "' + p.code + '" применён!', 'var(--success)');
    discEl.textContent = 'Скидка: ' + p.discount + '%';
    discEl.style.display = 'block';
    discEl.style.color = 'var(--success)';
  } catch(e) { setMsg(msgEl, 'Ошибка сети', '#EF4444'); }
}

function setMsg(el, text, color) {
  el.textContent = text; el.style.color = color; el.style.display = 'block';
}

async function activateKey() {
  var input = document.getElementById('key-input');
  if (!input) return;
  var key = input.value.trim().toUpperCase();
  if (!key) { showKeyMsg('Введите ключ', '#EF4444'); return; }
  try {
    var r = await fetch('/api/keys/activate', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    var data = await r.json();
    if (!r.ok) { showKeyMsg(data.error || 'Ошибка', '#EF4444'); return; }
    if (data.type === 'role') showKeyMsg('✓ Роль "' + data.roleName + '" активирована!', 'var(--success)');
    else if (data.type === 'prefix') showKeyMsg('✓ Префикс "' + data.prefix + '" активирован!', 'var(--success)');
    input.value = '';
    setTimeout(loadProfile, 1500);
  } catch(e) { showKeyMsg('Ошибка сети', '#EF4444'); }
}

function showKeyMsg(text, color) {
  var el = document.getElementById('key-activate-msg');
  if (!el) return;
  el.textContent = text; el.style.color = color; el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 4000);
}

function renderColorCircles() {
  var container = document.getElementById('color-circles');
  if (!container) return;
  container.innerHTML = '';
  var savedColor = localStorage.getItem('noryx_color') || 'pink';

  Object.keys(COLOR_MAP).forEach(function(key) {
    var c = COLOR_MAP[key];
    var div = document.createElement('div');
    div.className = 'color-circle' + (key === savedColor ? ' selected' : '');
    div.style.background = c.hex;
    div.setAttribute('title', c.label);
    div.onclick = function() { selectColor(key); };
    container.appendChild(div);
  });

  var label = document.getElementById('selected-color-label');
  if (label && COLOR_MAP[savedColor]) {
    label.textContent = COLOR_MAP[savedColor].label;
    label.style.color = COLOR_MAP[savedColor].hex;
  }
  renderBgPicker(savedColor);
}

function selectColor(key) {
  selectedColor = key;
  document.querySelectorAll('.color-circle').forEach(function(c) { c.classList.remove('selected'); });
  var circles = document.querySelectorAll('.color-circle');
  var keys = Object.keys(COLOR_MAP);
  var idx = keys.indexOf(key);
  if (circles[idx]) circles[idx].classList.add('selected');

  var colorData = COLOR_MAP[key];
  var label = document.getElementById('selected-color-label');
  if (label && colorData) { label.textContent = colorData.label; label.style.color = colorData.hex; }

  document.documentElement.style.setProperty('--primary', colorData.hex);
  document.documentElement.style.setProperty('--primary-dark', colorData.hex);

  selectedBg = null;
  renderBgPicker(key);
  document.getElementById('color-save-msg').style.display = 'none';
}

function renderBgPicker(colorKey) {
  var container = document.getElementById('bg-picker');
  if (!container) return;
  var colorData = COLOR_MAP[colorKey];
  if (!colorData) { container.innerHTML = ''; return; }
  container.innerHTML = '';

  var title = document.createElement('p');
  title.style.cssText = 'color:rgba(255,255,255,0.5);font-size:13px;margin-bottom:12px;margin-top:16px';
  title.textContent = 'Фон для ' + colorData.label + ':';
  container.appendChild(title);

  var grid = document.createElement('div');
  grid.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap';
  var savedBg = localStorage.getItem('noryx_bg');

  for (var i = 1; i <= colorData.bgCount; i++) {
    (function(index) {
      var imgPath = '/public/assets/colors/' + colorData.folder + '/' + index + '.png';
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;cursor:pointer;border-radius:12px;overflow:hidden;border:2px solid transparent;transition:border-color 0.2s';
      wrapper.setAttribute('data-bg', imgPath);
      if (savedBg === imgPath) { wrapper.style.borderColor = colorData.hex; selectedBg = imgPath; }

      var img = document.createElement('img');
      img.src = imgPath;
      img.style.cssText = 'width:110px;height:65px;object-fit:cover;display:block';
      img.onerror = function() { wrapper.style.display = 'none'; };

      wrapper.appendChild(img);
      wrapper.onclick = function() {
        document.querySelectorAll('#bg-picker [data-bg]').forEach(function(w) { w.style.borderColor = 'transparent'; });
        wrapper.style.borderColor = colorData.hex;
        selectedBg = imgPath;
        var bgEl = document.getElementById('bgFull');
        if (bgEl) bgEl.style.backgroundImage = 'url("' + imgPath + '")';
      };
      grid.appendChild(wrapper);
    })(i);
  }
  container.appendChild(grid);
}

function saveColor() {
  if (!selectedColor) return;
  localStorage.setItem('noryx_color', selectedColor);
  if (selectedBg) localStorage.setItem('noryx_bg', selectedBg);
  var msg = document.getElementById('color-save-msg');
  if (msg) { msg.style.display = 'block'; setTimeout(function() { msg.style.display = 'none'; }, 3000); }
}

function renderMediaPanel(u) {
  setText('media-username', u.username);
  setText('media-promo-used', '—');
  setText('media-balance-val', parseFloat(u.mediaBalance || 0).toFixed(2) + ' ₽');
  if (u.mediaPromoCode) setText('media-promo-code', u.mediaPromoCode);
  loadWithdrawalHistory();
}

async function requestWithdrawal() {
  var amount = parseFloat(document.getElementById('withdrawal-amount').value);
  if (!amount || amount <= 0) { alert('Введите сумму'); return; }
  try {
    var r = await fetch('/api/withdrawals/request', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    var data = await r.json();
    if (!r.ok) { alert(data.error); return; }
    document.getElementById('withdrawal-modal').classList.add('hidden');
    alert('Заявка подана!');
    loadWithdrawalHistory();
  } catch(e) { alert('Ошибка сети'); }
}

async function loadWithdrawalHistory() {
  try {
    var r = await fetch('/api/withdrawals/history', { credentials: 'include' });
    var data = await r.json();
    renderWithdrawalHistory(data.history || []);
  } catch(e) {}
}

function renderWithdrawalHistory(list) {
  var el = document.getElementById('withdrawal-history-list');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p style="color:rgba(255,255,255,0.3);font-size:14px">История пуста</p>'; return; }
  el.innerHTML = '';
  list.forEach(function(w) {
    var div = document.createElement('div');
    div.style.cssText = 'padding:16px;border:1px solid rgba(255,255,255,0.1);border-radius:14px;margin-bottom:12px';
    var date = new Date(w.requested_at);
    var dateStr = date.getHours().toString().padStart(2,'0') + ':' + date.getMinutes().toString().padStart(2,'0') + ':' + date.getSeconds().toString().padStart(2,'0') +
      ' ' + date.getDate().toString().padStart(2,'0') + '.' + (date.getMonth()+1).toString().padStart(2,'0') + '.' + date.getFullYear();
    var statusHtml;
    if (w.status === 'accepted') {
      statusHtml = '<div style="color:var(--success);font-size:13px;margin-top:8px">Принято ✓<br><small style="color:rgba(255,255,255,0.4)">Поздравляем! Вас приняли на вывод средств, желаем вам удачи!</small></div>';
    } else if (w.status === 'rejected') {
      statusHtml = '<div style="color:#EF4444;font-size:13px;margin-top:8px">Отказано ✕<br><small style="color:rgba(255,255,255,0.4)">Причина: ' + esc(w.reject_reason || '—') + '</small></div>';
    } else {
      statusHtml = '<div style="color:#F59E0B;font-size:13px;margin-top:8px">⏳ На рассмотрении</div>';
    }
    div.innerHTML = '<div style="font-weight:600">Подача на вывод: ' + parseFloat(w.amount).toFixed(2) + ' ₽</div>' +
      '<div style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:4px">Подано: ' + dateStr + '</div>' + statusHtml;
    el.appendChild(div);
  });
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(function(el) { el.style.display = 'none'; });
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
  var tab = document.getElementById('tab-' + name);
  if (tab) tab.style.display = '';
  if (btn) btn.classList.add('active');
}

function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function doLogout() {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(function(){});
  localStorage.removeItem('noryx_user');
  window.location.href = '/';
}
