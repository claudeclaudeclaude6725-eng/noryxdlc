document.addEventListener('DOMContentLoaded', function () {
  applyStoredTheme();
  updateHeaderAuth();

  var header = document.getElementById('site-header');
  if (header) {
    window.addEventListener('scroll', function () {
      header.classList.toggle('scrolled', window.scrollY > 20);
    });
  }

  var canvas = document.getElementById('bgCanvas');
  if (canvas) {
    var ctx = canvas.getContext('2d');
    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);
    var stars = [];
    for (var i = 0; i < 200; i++) {
      stars.push({ x: Math.random()*canvas.width, y: Math.random()*canvas.height, r: Math.random()*1.8+0.3, opacity: Math.random(), speed: Math.random()*0.04+0.01 });
    }
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stars.forEach(function (s) {
        s.opacity += s.speed;
        if (s.opacity > 1 || s.opacity < 0.05) s.speed = -s.speed;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (Math.abs(s.opacity) * 0.6) + ')';
        ctx.fill();
      });
      requestAnimationFrame(animate);
    }
    animate();
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.1 });
  document.querySelectorAll('.fade-in').forEach(function (el) { observer.observe(el); });

  var tariffItems = document.querySelectorAll('.tariff-item');
  tariffItems.forEach(function (item) {
    item.style.cursor = 'pointer';
    item.addEventListener('click', function () {
      var name = (item.querySelector('.tariff-item-name') || {}).textContent || '';
      var price = (item.querySelector('.tariff-item-price') || {}).textContent || '';
      var sub = (item.querySelector('.tariff-item-sub') || {}).textContent || '';
      price = price.replace('₽','').trim();
      openGlobalModal(name, sub, price);
    });
  });
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

function updateHeaderAuth() {
  var authDiv = document.getElementById('header-auth');
  if (!authDiv) return;
  var user = getStoredUser();
  if (user && user.username) {
    authDiv.innerHTML = '<a href="/html/profile.html" style="color:var(--success);font-weight:700;font-size:15px;padding:7px 18px;border-radius:9999px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2)">' + esc(user.username) + '</a>';
    return;
  }
  fetch('/api/auth/me', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (data && data.user) {
        setStoredUser(data.user);
        authDiv.innerHTML = '<a href="/html/profile.html" style="color:var(--success);font-weight:700;font-size:15px;padding:7px 18px;border-radius:9999px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2)">' + esc(data.user.username) + '</a>';
      } else {
        authDiv.innerHTML = '<a href="/html/login.html" class="di-login">Войти</a>';
      }
    })
    .catch(function () {
      authDiv.innerHTML = '<a href="/html/login.html" class="di-login">Войти</a>';
    });
}

function openGlobalModal(name, sub, price) {
  var modal = document.getElementById('global-shop-modal');
  if (!modal) return;
  setText('gm-name', name);
  setText('gm-sub', sub);
  setText('gm-price', price + '.00 ₽');
  var btn = document.getElementById('gm-pay-btn');
  if (btn) btn.textContent = 'Оплатить ' + price + '.00 ₽';
  document.getElementById('gm-promo-input').value = '';
  document.getElementById('gm-promo-msg').style.display = 'none';
  document.getElementById('gm-discount').style.display = 'none';
  modal.classList.remove('hidden');
}

function closeGlobalModal() {
  var modal = document.getElementById('global-shop-modal');
  if (modal) modal.classList.add('hidden');
}

async function applyPromoGlobal() {
  var code = document.getElementById('gm-promo-input').value.trim();
  var msgEl = document.getElementById('gm-promo-msg');
  var discEl = document.getElementById('gm-discount');
  if (!code) { showMsg(msgEl, 'Введите промокод', '#EF4444'); return; }
  try {
    var r = await fetch('/api/promos/check', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    var data = await r.json();
    if (!r.ok) { showMsg(msgEl, data.error || 'Не найден', '#EF4444'); return; }
    var p = data.promo;
    showMsg(msgEl, '✓ Промокод "' + p.code + '" применён!', 'var(--success)');
    discEl.textContent = 'Скидка: ' + p.discount + '%';
    discEl.style.display = 'block';
    discEl.style.color = 'var(--success)';
  } catch(e) { showMsg(msgEl, 'Ошибка сети', '#EF4444'); }
}

function showMsg(el, text, color) {
  el.textContent = text; el.style.color = color; el.style.display = 'block';
}

function getStoredUser() {
  try { var u = localStorage.getItem('noryx_user'); return u ? JSON.parse(u) : null; }
  catch(e) { return null; }
}
function setStoredUser(u) { localStorage.setItem('noryx_user', JSON.stringify(u)); }
function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
