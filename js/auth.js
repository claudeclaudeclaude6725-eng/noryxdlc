function getStoredUser() {
  try { var u = localStorage.getItem('noryx_user'); return u ? JSON.parse(u) : null; } catch(e) { return null; }
}
function setStoredUser(u) { localStorage.setItem('noryx_user', JSON.stringify(u)); }
function clearStoredUser() { localStorage.removeItem('noryx_user'); }

function showError(id, msg) { var el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
function hideError(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; }

async function doLogin() {
  hideError('login-error');
  var loginVal = document.getElementById('login-identifier').value.trim();
  var password = document.getElementById('login-password').value;
  if (!loginVal || !password) { showError('login-error', 'Заполните все поля'); return; }
  try {
    var r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ login: loginVal, password })
    });
    var data = await r.json();
    if (!r.ok) { showError('login-error', data.error || 'Ошибка входа'); return; }
    if (data.user) setStoredUser(data.user);
    window.location.href = '/html/profile.html';
  } catch(e) { showError('login-error', 'Ошибка сети'); }
}

async function doRegister() {
  hideError('reg-error');
  var username = document.getElementById('reg-username').value.trim();
  var email = document.getElementById('reg-email').value.trim();
  var password = document.getElementById('reg-password').value;
  if (!username || !email || !password) { showError('reg-error', 'Заполните все поля'); return; }
  try {
    var r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username, email, password })
    });
    var data = await r.json();
    if (!r.ok) { showError('reg-error', data.error || 'Ошибка регистрации'); return; }
    if (data.user) setStoredUser(data.user);
    window.location.href = '/html/profile.html';
  } catch(e) { showError('reg-error', 'Ошибка сети'); }
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch(e) {}
  clearStoredUser();
  window.location.href = '/';
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  if (document.getElementById('login-identifier')) doLogin();
  if (document.getElementById('reg-username')) doRegister();
});
