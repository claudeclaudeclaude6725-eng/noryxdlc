var currentUser = null;

var ROLE_LABELS = {
  'user':'Юзер','beta':'Beta','alpha':'Alpha',
  'vip':'VIP','media':'MEDIA','moderator':'Модератор','admin':'Админ'
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
  { cat:'other',  name:'Префикс',          price:50,  dur:'Навсегда', type:'prefix' },
  { cat:'other',  name:'Валюта',           price:1,   dur:'1$ за 1₽', type:'currency', currency:true }
];

var isFreeScript = false;
var pendingScriptPayload = null;
var currentScriptsSubtab = 'market';

document.addEventListener('DOMContentLoaded', function () {
  applyStoredTheme();
  loadProfile();
  var overlay = document.getElementById('shop-modal');
  if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { closeModal(); closeUploadScriptModal(); closeConfirmModal(); closeScriptDetail(); }});
  var upModal = document.getElementById('upload-script-modal');
  if (upModal) upModal.addEventListener('click', function(e){ if(e.target===this) closeUploadScriptModal(); });
  var confModal = document.getElementById('confirm-script-modal');
  if(confModal) confModal.addEventListener('click', function(e){ if(e.target===this) closeConfirmModal(); });
  var detModal = document.getElementById('script-detail-modal');
  if(detModal) detModal.addEventListener('click', function(e){ if(e.target===this) closeScriptDetail(); });
  var previewInput = document.getElementById('script-preview');
  if(previewInput) previewInput.addEventListener('change', handlePreviewChange);
  var fileInput = document.getElementById('script-file');
  if(fileInput) fileInput.addEventListener('change', handleFileChange);
});

function applyStoredTheme() {
  document.documentElement.style.setProperty('--primary', '#7C3AED');
  document.documentElement.style.setProperty('--primary-dark', '#6D28D9');
  var bgEl = document.getElementById('bgFull');
  if (bgEl) bgEl.style.backgroundImage = 'url("/assets/bg.jpg")';
}

async function loadProfile() {
  try {
    var r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.ok) {
      var data = await r.json();
      currentUser = data.user;
      if (data.csrfToken) localStorage.setItem('noryx_csrf', data.csrfToken);
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
function getCsrfToken() { return localStorage.getItem('noryx_csrf') || ''; }
function csrfHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  var token = getCsrfToken();
  if (token) headers['X-CSRF-Token'] = token;
  return headers;
}

function isAlpha(u){
  if(!u) return false;
  if(u.role==='admin') return true;
  var t=(u.subscriptionType||'').toLowerCase();
  return t==='alpha'||t==='alphalife'||t==='alpha7'||t==='alpha30'||t==='alpha90'||t==='alpha180'||t==='vip'||u.role==='alpha'||u.role==='vip';
}

function renderProfile(u) {
  setText('prof-username',  u.username || '');
  setText('prof-username2', u.username || '');
  setText('prof-id',        '#' + (u.id || ''));
  setText('prof-email',     u.email || '');
  setText('prof-created',   u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—');
  setText('prof-role',      ROLE_LABELS[u.role] || 'Юзер');
  setText('prof-balance',   (parseFloat(u.balance||0).toFixed(2) + ' $'));

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

  var scriptsBtn = document.getElementById('sidebar-scripts');
  if (scriptsBtn) scriptsBtn.style.display = isAlpha(u) ? 'flex' : 'none';

  renderShop(u);

  if (u.role === 'media' || u.role === 'admin') renderMediaPanel(u);
  if (typeof renderDownloadButtons === 'function') renderDownloadButtons(u);
  // auto load market if scripts tab visible and alpha
  if (isAlpha(u)) loadScriptsMarket();
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
      headers: csrfHeaders(),
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
    var endpoint = key.startsWith('BAL-') ? '/api/balance/activate' : '/api/keys/activate';
    var r = await fetch(endpoint, {
      method: 'POST', credentials: 'include',
      headers: csrfHeaders(),
      body: JSON.stringify({ key })
    });
    var data = await r.json();
    if (!r.ok) { showKeyMsg(data.error || 'Ошибка', '#EF4444'); return; }
    if (data.type === 'role') showKeyMsg('✓ Роль "' + data.roleName + '" активирована!', 'var(--success)');
    else if (data.type === 'prefix') showKeyMsg('✓ Префикс "' + data.prefix + '" активирован!', 'var(--success)');
    else if (data.type === 'balance') showKeyMsg('✓ Баланс пополнен на ' + data.amount + ' $! Текущий: ' + data.balance + ' $', 'var(--success)');
    else showKeyMsg('✓ Ключ активирован', 'var(--success)');
    input.value = '';
    setTimeout(loadProfile, 1200);
  } catch(e) {
    showKeyMsg('Ошибка сети', '#EF4444');
  }
}

function showKeyMsg(text, color) {
  var el = document.getElementById('key-activate-msg');
  if (!el) return;
  el.textContent = text; el.style.color = color; el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 4000);
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
      headers: csrfHeaders(),
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

// ===== Scripts logic =====
function openUploadScriptModal(){
  if(!isAlpha(currentUser)){ alert('Доступ только для Alpha'); return; }
  document.getElementById('upload-script-modal').classList.remove('hidden');
  setFree(false);
}
function closeUploadScriptModal(){
  var m=document.getElementById('upload-script-modal');
  if(m) m.classList.add('hidden');
  pendingScriptPayload=null;
}
function closeConfirmModal(){
  var m=document.getElementById('confirm-script-modal');
  if(m) m.classList.add('hidden');
}
function setFree(v){
  isFreeScript=v;
  document.getElementById('free-yes').className = v ? 'btn-primary' : 'btn-secondary';
  document.getElementById('free-no').className = v ? 'btn-secondary' : 'btn-primary';
  document.getElementById('script-price-wrap').style.display = v ? 'none' : '';
  if(v) document.getElementById('script-price').value='';
}
function handlePreviewChange(e){
  var f=e.target.files[0];
  if(!f) return;
  if(f.size>5*1024*1024){ alert('Превью до 5МБ'); e.target.value=''; return; }
  var reader=new FileReader();
  reader.onload=function(ev){
    document.getElementById('script-preview-img').src=ev.target.result;
    document.getElementById('script-preview-preview').style.display='block';
  };
  reader.readAsDataURL(f);
}
function handleFileChange(e){
  var f=e.target.files[0];
  var info=document.getElementById('script-file-info');
  if(!f){ info.textContent=''; return; }
  if(f.size>30*1024*1024){ alert('Файл до 30МБ'); e.target.value=''; info.textContent=''; return; }
  info.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(2) + ' MB)';
}
function readFileAsDataURL(file){
  return new Promise(function(res,rej){
    var r=new FileReader();
    r.onload=function(){res(r.result)};
    r.onerror=rej;
    r.readAsDataURL(file);
  });
}
async function submitScript(){
  var title=document.getElementById('script-title').value.trim();
  var desc=document.getElementById('script-desc').value.trim();
  var previewFile=document.getElementById('script-preview').files[0];
  var scriptFile=document.getElementById('script-file').files[0];
  var priceStr=document.getElementById('script-price').value.trim();
  var err=document.getElementById('upload-err');
  err.style.display='none';
  if(!title||title.length<3){ err.textContent='Название минимум 3 символа'; err.style.color='#EF4444'; err.style.display='block'; return; }
  if(!desc||desc.length<10){ err.textContent='Описание минимум 10 символов'; err.style.color='#EF4444'; err.style.display='block'; return; }
  if(!previewFile){ err.textContent='Загрузите превью'; err.style.color='#EF4444'; err.style.display='block'; return; }
  if(!scriptFile){ err.textContent='Прикрепите файл скрипта'; err.style.color='#EF4444'; err.style.display='block'; return; }
  var ext=scriptFile.name.split('.').pop().toLowerCase();
  if(['lua','png','img','jpg','jpeg','zip'].indexOf(ext)===-1){ err.textContent='Недопустимый формат'; err.style.color='#EF4444'; err.style.display='block'; return; }
  if(scriptFile.size>30*1024*1024){ err.textContent='Файл до 30 МБ'; err.style.color='#EF4444'; err.style.display='block'; return; }
  if(!isFreeScript){
    if(!priceStr||!/^\d+$/.test(priceStr)){ err.textContent='Введите цену цифрами'; err.style.color='#EF4444'; err.style.display='block'; return; }
  }
  var previewData = await readFileAsDataURL(previewFile);
  var fileData = await readFileAsDataURL(scriptFile);
  pendingScriptPayload = {
    title: title,
    description: desc,
    previewImage: previewData,
    fileName: scriptFile.name,
    fileData: fileData,
    fileSize: scriptFile.size,
    price: isFreeScript ? 0 : parseInt(priceStr,10),
    isFree: isFreeScript
  };
  document.getElementById('confirm-script-modal').classList.remove('hidden');
}
async function confirmSendScript(){
  closeConfirmModal();
  var err=document.getElementById('upload-err');
  if(!pendingScriptPayload) return;
  try{
    var r=await fetch('/api/scripts/create', {method:'POST', credentials:'include', headers: csrfHeaders(), body: JSON.stringify(pendingScriptPayload)});
    var data=await r.json();
    if(!r.ok){ err.textContent=data.error||'Ошибка'; err.style.color='#EF4444'; err.style.display='block'; return; }
    closeUploadScriptModal();
    alert('Скрипт отправлен на проверку!');
    document.getElementById('script-title').value='';
    document.getElementById('script-desc').value='';
    document.getElementById('script-preview').value='';
    document.getElementById('script-file').value='';
    document.getElementById('script-preview-preview').style.display='none';
    document.getElementById('script-file-info').textContent='';
    loadScriptsMarket();
    switchScriptsSubtab('my');
    loadMyScripts();
  }catch(e){ err.textContent='Ошибка сети'; err.style.color='#EF4444'; err.style.display='block'; }
}

function switchScriptsSubtab(name){
  currentScriptsSubtab=name;
  document.getElementById('scripts-market-grid').style.display = name==='market' ? 'grid' : 'none';
  document.getElementById('scripts-my-grid').style.display = name==='my' ? 'grid' : 'none';
  document.getElementById('scripts-purchased-grid').style.display = name==='purchased' ? 'grid' : 'none';
  var btns=['market','my','purchased'];
  btns.forEach(function(b){
    var el=document.getElementById('btn-scripts-'+b);
    if(!el) return;
    if(b===name){ el.style.background='rgba(124,58,237,0.15)'; el.style.borderColor='rgba(124,58,237,0.3)'; }
    else { el.style.background=''; el.style.borderColor=''; }
  });
  if(name==='market') loadScriptsMarket();
  if(name==='my') loadMyScripts();
  if(name==='purchased') loadPurchased();
}

async function loadScriptsMarket(){
  var grid=document.getElementById('scripts-market-grid');
  var empty=document.getElementById('scripts-empty');
  try{
    var r=await fetch('/api/scripts', {credentials:'include'});
    var data=await r.json();
    var list=data.scripts||[];
    grid.innerHTML='';
    if(!list.length){ empty.style.display='block'; empty.textContent='Скриптов пока нет'; return; }
    empty.style.display='none';
    list.forEach(function(s){ grid.appendChild(renderScriptCard(s,'market')); });
  }catch(e){ grid.innerHTML='<p style="color:#EF4444">Ошибка загрузки</p>'; }
}
async function loadMyScripts(){
  var grid=document.getElementById('scripts-my-grid');
  try{
    var r=await fetch('/api/scripts/my', {credentials:'include'});
    var data=await r.json();
    var list=data.scripts||[];
    grid.innerHTML='';
    if(!list.length){ grid.innerHTML='<p style="color:rgba(255,255,255,0.3);text-align:center;padding:24px">У вас нет загруженных скриптов</p>'; return; }
    list.forEach(function(s){
      var card=document.createElement('div');
      card.className='script-card glass-card';
      var statusColor = s.status==='approved' ? 'var(--success)' : s.status==='rejected' ? '#EF4444' : '#F59E0B';
      var statusText = s.status==='approved' ? 'Одобрен' : s.status==='rejected' ? 'Отклонён' : 'На проверке';
      card.innerHTML = '<div style="height:160px;overflow:hidden;border-radius:14px;margin:-8px -8px 14px"><img src="'+esc(s.preview_image)+'" style="width:100%;height:100%;object-fit:cover"/></div>' +
        '<div style="font-weight:700;font-size:16px">'+esc(s.title)+'</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,0.4);margin-top:6px">'+esc((s.description||'').slice(0,80))+'</div>' +
        '<div style="margin-top:10px;font-size:13px;color:'+statusColor+'">'+statusText+' • '+(s.is_free ? 'Бесплатно' : s.price+' $')+'</div>';
      card.style.cursor='pointer';
      card.onclick=function(){ openScriptDetail(s.id); };
      grid.appendChild(card);
    });
  }catch(e){ grid.innerHTML='<p style="color:#EF4444">Ошибка</p>'; }
}
async function loadPurchased(){
  var grid=document.getElementById('scripts-purchased-grid');
  try{
    var r=await fetch('/api/scripts/purchased', {credentials:'include'});
    var data=await r.json();
    var list=data.scripts||[];
    grid.innerHTML='';
    if(!list.length){ grid.innerHTML='<p style="color:rgba(255,255,255,0.3);text-align:center;padding:24px">Нет скачанных скриптов</p>'; return; }
    list.forEach(function(s){
      var card=document.createElement('div');
      card.className='script-card glass-card';
      card.style.padding='20px';
      card.innerHTML = '<div style="height:160px;overflow:hidden;border-radius:14px;margin:-8px -8px 14px"><img src="'+esc(s.preview_image)+'" style="width:100%;height:100%;object-fit:cover"/></div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.4)">'+esc(s.author_username)+'</div>' +
        '<div style="font-weight:700;font-size:16px;margin-top:4px">'+esc(s.title)+'</div>' +
        '<button class="btn-secondary" style="margin-top:12px;width:100%" onclick="event.stopPropagation(); toggleScript('+s.id+',this)">'+(s.enabled ? 'Отключить' : 'Включить')+'</button>';
      card.style.cursor='pointer';
      card.onclick=function(){ openScriptDetail(s.id); };
      grid.appendChild(card);
    });
  }catch(e){ grid.innerHTML='<p style="color:#EF4444">Ошибка</p>'; }
}

function renderScriptCard(s, mode){
  var div=document.createElement('div');
  div.className='script-card glass-card';
  div.style.padding='20px';
  div.style.cursor='pointer';
  var priceText = s.is_free ? 'Бесплатно' : s.price + ' $';
  div.innerHTML = '<div style="height:160px;overflow:hidden;border-radius:14px;margin:-8px -8px 14px"><img src="'+esc(s.preview_image)+'" style="width:100%;height:100%;object-fit:cover"/></div>' +
    '<div style="font-weight:700;font-size:16px">'+esc(s.title)+'</div>' +
    '<div style="font-size:14px;color:var(--success);margin-top:6px;font-weight:600">'+priceText+'</div>';
  // check if owned?
  div.onclick=function(){ openScriptDetail(s.id); };
  return div;
}

async function openScriptDetail(id){
  try{
    var r=await fetch('/api/scripts/'+id, {credentials:'include'});
    var data=await r.json();
    if(!r.ok){ alert(data.error||'Ошибка'); return; }
    var s=data.script;
    var priceText = s.is_free ? 'Бесплатно' : s.price + ' $';
    var isOwn = currentUser && s.author_id===currentUser.id;
    var purchCheck = await fetch('/api/scripts/purchased', {credentials:'include'}).then(function(x){return x.json()}).catch(function(){return {scripts:[]}});
    var owned = (purchCheck.scripts||[]).some(function(x){return x.id===s.id}) || isOwn;
    var btnHtml='';
    if(s.status!=='approved'){ btnHtml='<p style="color:#F59E0B;margin-top:16px">На проверке у администратора</p>'; }
    else if(isOwn){ btnHtml='<p style="color:rgba(255,255,255,0.5);margin-top:16px">Ваш скрипт</p>'; }
    else if(s.is_free){
      btnHtml='<button class="btn-primary" style="margin-top:16px;width:100%" onclick="downloadFree('+s.id+')">Скачать</button>';
      if(owned) btnHtml+='<p style="color:var(--success);font-size:13px;margin-top:8px">Уже скачан • доступен в "Скачанные"</p>';
    } else {
      if(owned) btnHtml='<p style="color:var(--success);margin-top:16px">Куплено ✓</p><button class="btn-secondary" style="margin-top:12px;width:100%" onclick="downloadFile('+s.id+')">Скачать файл</button>';
      else btnHtml='<button class="btn-primary" style="margin-top:16px;width:100%" onclick="buyScript('+s.id+')">Купить за '+priceText+'</button>';
    }
    var html = '<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:8px">Автор: '+esc(s.author_username)+'</div>' +
      '<img src="'+esc(s.preview_image)+'" style="width:100%;max-height:300px;object-fit:cover;border-radius:14px;margin-bottom:16px"/>' +
      '<h3 style="font-size:22px;font-weight:800">'+esc(s.title)+'</h3>' +
      '<p style="color:rgba(255,255,255,0.6);margin-top:12px;line-height:1.6">'+esc(s.description)+'</p>' +
      '<div style="margin-top:16px;font-size:18px;font-weight:700;color:var(--success)">'+priceText+'</div>' + btnHtml;
    document.getElementById('script-detail-content').innerHTML=html;
    document.getElementById('script-detail-modal').classList.remove('hidden');
  }catch(e){ alert('Ошибка'); }
}
function closeScriptDetail(){ var m=document.getElementById('script-detail-modal'); if(m) m.classList.add('hidden'); }

async function buyScript(id){
  if(!confirm('Купить скрипт? С баланса спишется сумма.')) return;
  try{
    var r=await fetch('/api/scripts/'+id+'/buy', {method:'POST', credentials:'include', headers: csrfHeaders()});
    var data=await r.json();
    if(!r.ok){ alert(data.error||'Ошибка'); return; }
    alert('Куплено! Новый баланс: '+data.balance+' $');
    closeScriptDetail();
    loadProfile();
    loadPurchased();
  }catch(e){ alert('Ошибка сети'); }
}
async function downloadFree(id){
  try{
    var r=await fetch('/api/scripts/'+id+'/download', {method:'POST', credentials:'include', headers: csrfHeaders()});
    var data=await r.json();
    if(!r.ok){ alert(data.error||'Ошибка'); return; }
    triggerDownload(data.fileName, data.fileData);
    alert('Скачано! Смотрите в "Скачанные скрипты"');
    closeScriptDetail();
    loadPurchased();
  }catch(e){ alert('Ошибка'); }
}
async function downloadFile(id){
  try{
    var r=await fetch('/api/scripts/'+id+'/file', {credentials:'include'});
    var data=await r.json();
    if(!r.ok){ alert(data.error||'Ошибка'); return; }
    triggerDownload(data.fileName, data.fileData);
  }catch(e){ alert('Ошибка'); }
}
function triggerDownload(name, dataUrl){
  var a=document.createElement('a');
  a.href=dataUrl;
  a.download=name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function toggleScript(id, btn){
  btn.disabled=true;
  try{
    var r=await fetch('/api/scripts/'+id+'/toggle', {method:'POST', credentials:'include', headers: csrfHeaders()});
    var data=await r.json();
    if(!r.ok){ alert(data.error||'Ошибка'); btn.disabled=false; return; }
    btn.textContent = data.enabled ? 'Отключить' : 'Включить';
    btn.disabled=false;
  }catch(e){ btn.disabled=false; alert('Ошибка'); }
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(function(el) { el.style.display = 'none'; });
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
  var tab = document.getElementById('tab-' + name);
  if (tab) tab.style.display = '';
  if (btn) btn.classList.add('active');
  if(name==='scripts'){ loadScriptsMarket(); }
}

function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function doLogout() {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: csrfHeaders() }).catch(function(){});
  localStorage.removeItem('noryx_user');
  localStorage.removeItem('noryx_csrf');
  window.location.href = '/';
}
