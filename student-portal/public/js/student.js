if (!getToken()) location.href = '/';

async function load() {
  const s = await api('/api/student/me');
  document.getElementById('who').textContent = s.name;
  document.getElementById('student-phone').value = s.pending_phone_number || s.phone_number || '';
  document.getElementById('phone-verify-form').hidden = !s.pending_phone_number;
  document.getElementById('phone-msg').textContent = s.pending_phone_number
    ? 'A mobile number is waiting for verification.'
    : s.phone_verified ? 'Your recovery number is verified.' : 'No verified recovery number is saved yet.';

  const img = s.photo
    ? `<img class="avatar" src="${photoUrl(s.photo)}" alt="Photo of ${esc(s.name)}">`
    : `<div class="avatar"></div>`;
  document.getElementById('profile').innerHTML = `
    ${img}
    <div class="facts">
      <h1 class="name-line">${esc(s.name)}</h1>
      <div><span>SAP ID</span><b>${esc(s.sap_id)}</b></div>
      <div><span>Roll number</span><b>${esc(s.roll_no)}</b></div>
      <div><span>Year</span><b>${esc(s.current_year)}</b></div>
      <div><span>Class</span><b>${esc(s.class_name)}</b></div>
      <div><span>Section</span><b>${esc(s.section)}</b></div>
      <div><span>Class teacher</span><b>${esc(s.teacher_name || '-')} (${esc(s.teacher_uid || '-')})</b></div>
    </div>`;

  const rows = document.getElementById('rows');
  const totalClasses = s.records.reduce((sum, r) => sum + r.total_classes, 0);
  const attendedClasses = s.records.reduce((sum, r) => sum + r.attended, 0);
  const markedRecords = s.records.filter((r) => r.marks !== null);
  const averageMarks = markedRecords.length
    ? Math.round(markedRecords.reduce((sum, r) => sum + r.marks / r.max_marks * 100, 0) / markedRecords.length)
    : null;
  const overallAttendance = percent(attendedClasses, totalClasses);
  document.getElementById('student-summary').innerHTML = `
    <article class="summary-card"><span>Overall attendance</span><strong class="${attClass(overallAttendance)}">${overallAttendance}%</strong></article>
    <article class="summary-card"><span>Average marks</span><strong>${averageMarks === null ? '—' : `${averageMarks}%`}</strong></article>
    <article class="summary-card"><span>Subjects</span><strong>${s.records.length}</strong></article>`;

  const lowAttendance = s.records.filter((r) => percent(r.attended, r.total_classes) < 80);
  const alert = document.getElementById('attendance-alert');
  alert.hidden = !lowAttendance.length;
  alert.innerHTML = lowAttendance.length
    ? `<strong>Attendance attention needed</strong>
      <span>Your attendance is below 80% in ${lowAttendance.length} subject${lowAttendance.length === 1 ? '' : 's'}:</span>
      <ul>${lowAttendance.map((r) => `<li>${esc(r.subject)}: ${percent(r.attended, r.total_classes)}% (${r.attended}/${r.total_classes} classes attended)</li>`).join('')}</ul>`
    : '';

  renderBarChart('attendance-chart', s.records.map((r) => ({
    label: r.subject,
    value: percent(r.attended, r.total_classes),
    color: barColor(percent(r.attended, r.total_classes)),
  })));
  renderBarChart('marks-chart', s.records.filter((r) => r.marks !== null).map((r) => ({
    label: r.subject,
    value: r.marks / r.max_marks * 100,
  })));
  renderDonut('attendance-pie', 'attendance-legend', [
    { label: 'Attended classes', value: attendedClasses, color: 'var(--brand)' },
    { label: 'Missed classes', value: Math.max(0, totalClasses - attendedClasses), color: '#f1e6e6' },
  ], `Overall attendance: ${attendedClasses} of ${totalClasses} classes attended`);

  if (!s.records.length) {
    rows.innerHTML = '<tr><td colspan="5">No subjects added yet. Ask your class teacher.</td></tr>';
    return;
  }
  rows.innerHTML = s.records.map((r) => {
    const p = percent(r.attended, r.total_classes);
    return `<tr>
      <td>${esc(r.subject)}</td>
      <td>${r.attended} / ${r.total_classes}</td>
      <td class="pill ${attClass(p)}">${p}%</td>
      <td><div class="bar"><i style="width:${p}%;background:${barColor(p)}"></i></div></td>
      <td>${r.marks === null ? 'Not entered' : r.marks + ' / ' + r.max_marks}</td>
    </tr>`;
  }).join('');
}

// change password dialog
const dlg = document.getElementById('pwd-dialog');
document.getElementById('pwd-btn').onclick = () => dlg.showModal();
document.getElementById('pwd-close').onclick = () => dlg.close();
document.getElementById('pwd-save').onclick = async () => {
  const msg = document.getElementById('pwd-msg');
  try {
    await api('/api/student/password', { method: 'POST', body: {
      oldPassword: document.getElementById('old-pwd').value,
      newPassword: document.getElementById('new-pwd').value } });
    msg.className = 'msg ok'; msg.textContent = 'Password changed';
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
};

load().catch((e) => alert(e.message));

document.getElementById('phone-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('student-phone');
  const button = document.getElementById('phone-save');
  const message = document.getElementById('phone-msg');
  message.textContent = '';
  button.disabled = true;
  try {
    const result = await api('/api/student/phone', {
      method: 'PUT',
      body: { phone_number: input.value.trim() },
    });
    input.value = result.pending_phone_number;
    document.getElementById('phone-verify-form').hidden = false;
    message.className = 'msg ok';
    message.textContent = result.message;
  } catch (error) {
    message.className = 'msg err';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.getElementById('phone-verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('phone-verify');
  const message = document.getElementById('phone-msg');
  button.disabled = true;
  message.textContent = '';
  try {
    const result = await api('/api/student/phone/verify', {
      method: 'POST',
      body: { code: document.getElementById('student-phone-code').value.trim() },
    });
    document.getElementById('student-phone').value = result.phone_number;
    document.getElementById('student-phone-code').value = '';
    document.getElementById('phone-verify-form').hidden = true;
    message.className = 'msg ok';
    message.textContent = 'Mobile number verified. You can now use it for password recovery.';
  } catch (error) {
    message.className = 'msg err';
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
