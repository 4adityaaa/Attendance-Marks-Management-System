let role = 'student';
let recoveryRole = 'student';
let resendTimer = null;
const $ = (id) => document.getElementById(id);

function setRole(r) {
  role = r;
  for (const currentRole of ['student', 'teacher', 'admin']) {
    const selected = currentRole === r;
    $(`tab-${currentRole}`).classList.toggle('active', selected);
    $(`tab-${currentRole}`).setAttribute('aria-selected', String(selected));
    $(`tab-${currentRole}`).tabIndex = selected ? 0 : -1;
  }
  const idInput = $('uid');
  const idLength = r === 'student' ? 11 : r === 'teacher' ? 10 : null;
  const idLabel = r === 'student' ? 'SAP ID' : r === 'teacher' ? 'Teacher ID' : 'Admin username';
  const idPattern = idLength ? `[0-9]{${idLength}}` : '[A-Za-z0-9._\\-]{3,40}';
  if (idInput.value && !new RegExp(`^${idPattern}$`).test(idInput.value))
    idInput.value = '';
  idInput.minLength = 0;
  idInput.maxLength = idLength || 40;
  idInput.minLength = idLength || 3;
  idInput.pattern = idPattern;
  idInput.inputMode = r === 'admin' ? 'text' : 'numeric';
  idInput.title = r === 'admin'
    ? 'Enter your 3–40 character admin username'
    : `Enter exactly ${idLength} digits`;
  $('uid-label').textContent = idLabel;
  $('login-form').setAttribute('aria-labelledby', `tab-${r}`);
  $('uid-hint').textContent = r === 'student'
    ? `Enter your ${idLength}-digit SAP ID.`
    : r === 'teacher'
      ? `Enter your ${idLength}-digit mobile number / Teacher ID.`
      : 'Admin accounts are provisioned by the portal administrator.';
  $('recovery-row').hidden = r === 'admin';
  idInput.setAttribute('aria-describedby', 'uid-hint');
  idInput.setCustomValidity('');
  $('msg').textContent = '';
  if ($('recovery-dialog').open) $('recovery-dialog').close();
}

function openRecovery() {
  clearInterval(resendTimer);
  $('recovery-request-form').reset();
  $('recovery-reset-form').reset();
  $('recovery-reset-form').hidden = true;
  $('recovery-request-form').hidden = false;
  $('recovery-resend').hidden = true;
  $('recovery-msg').textContent = '';
  $('recovery-msg').className = 'msg';
  recoveryRole = role;
  $('recovery-id-label').textContent = recoveryRole === 'student' ? 'SAP ID' : 'Teacher ID (mobile number)';
  const idLength = recoveryRole === 'student' ? 11 : 10;
  const recoveryId = $('recovery-id');
  recoveryId.maxLength = idLength;
  recoveryId.minLength = idLength;
  recoveryId.pattern = `[0-9]{${idLength}}`;
  recoveryId.value = idInput.value;
  $('recovery-dialog').showModal();
}

for (const currentRole of ['student', 'teacher', 'admin']) {
  $(`tab-${currentRole}`).onclick = () => setRole(currentRole);
}
$('uid').addEventListener('input', () => $('uid').setCustomValidity(''));
$('tab-student').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { e.preventDefault(); $('tab-teacher').focus(); setRole('teacher'); }
});
$('tab-teacher').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { e.preventDefault(); $('tab-admin').focus(); setRole('admin'); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('tab-student').focus(); setRole('student'); }
});
$('tab-admin').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('tab-teacher').focus(); setRole('teacher'); }
});
$('show-recovery').onclick = openRecovery;
$('close-recovery').onclick = () => $('recovery-dialog').close();
$('recovery-dialog').addEventListener('close', () => clearInterval(resendTimer));

function startResendCountdown() {
  clearInterval(resendTimer);
  const button = $('recovery-resend');
  let seconds = 60;
  button.hidden = false;
  button.disabled = true;
  button.textContent = `Resend code in ${seconds}s`;
  resendTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(resendTimer);
      button.disabled = false;
      button.textContent = 'Resend code';
    } else {
      button.textContent = `Resend code in ${seconds}s`;
    }
  }, 1000);
}

async function requestRecoveryCode() {
  const res = await fetch('/api/password/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: recoveryRole, id: $('recovery-id').value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not send a verification code');
  $('recovery-request-form').hidden = true;
  $('recovery-reset-form').hidden = false;
  $('recovery-msg').className = 'msg ok';
  $('recovery-msg').textContent = data.message;
  $('recovery-code').focus();
  startResendCountdown();
}

$('uid').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('pwd').focus();
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '';
  const submitButton = $('login-submit');
  submitButton.disabled = true;
  submitButton.textContent = 'Signing in...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, id: $('uid').value, password: $('pwd').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    localStorage.setItem('portal_token', data.token);
    location.href = data.role === 'admin'
      ? '/admin.html'
      : data.role === 'teacher' ? '/teacher.html' : '/student.html';
  } catch (err) {
    $('msg').textContent = err.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Sign in';
  }
});

$('recovery-request-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('recovery-msg').textContent = '';
  $('recovery-send').disabled = true;
  try {
    await requestRecoveryCode();
  } catch (err) {
    $('recovery-msg').className = 'msg err';
    $('recovery-msg').textContent = err.message;
  } finally {
    $('recovery-send').disabled = false;
  }
});

$('recovery-resend').addEventListener('click', async () => {
  $('recovery-resend').disabled = true;
  $('recovery-msg').className = 'msg';
  $('recovery-msg').textContent = '';
  try {
    await requestRecoveryCode();
  } catch (err) {
    $('recovery-resend').disabled = false;
    $('recovery-msg').className = 'msg err';
    $('recovery-msg').textContent = err.message;
  }
});

$('recovery-reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('recovery-msg').textContent = '';
  $('recovery-reset').disabled = true;
  try {
    const res = await fetch('/api/password/otp/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: recoveryRole,
        id: $('recovery-id').value.trim(),
        code: $('recovery-code').value.trim(),
        newPassword: $('recovery-new-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not reset your password');
    $('recovery-msg').className = 'msg ok';
    $('recovery-msg').textContent = data.message;
    clearInterval(resendTimer);
    $('recovery-resend').hidden = true;
    $('recovery-reset-form').hidden = true;
    $('recovery-request-form').hidden = false;
    $('recovery-request-form').reset();
    $('recovery-new-password').value = '';
    $('uid').value = '';
    $('pwd').value = '';
  } catch (err) {
    $('recovery-msg').className = 'msg err';
    $('recovery-msg').textContent = err.message;
  } finally {
    $('recovery-reset').disabled = false;
  }
});

document.querySelectorAll('[data-toggle-password]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.togglePassword);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} password`);
    button.setAttribute('aria-pressed', String(visible));
    input.focus();
  });
});
