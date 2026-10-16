if (!getToken()) location.href = '/';

let students = [];
let teacher = null;
const $ = (id) => document.getElementById(id);

const FIELDS = [
  ['sap_id', 'SAP ID'], ['roll_no', 'Roll number'], ['name', 'Name'],
  ['current_year', 'Current year'], ['class_name', 'Class name'], ['section', 'Section'],
];

function fieldAttributes(key) {
  return key === 'sap_id'
    ? 'type="text" inputmode="numeric" pattern="[0-9]{11}" minlength="11" maxlength="11" title="Enter exactly 11 digits"'
    : '';
}

async function load() {
  teacher = await api('/api/teacher/me');
  $('who').textContent = `${teacher.name} (ID: ${teacher.teacher_uid})`;
  $('class-title').textContent = `${teacher.class_name}, Section ${teacher.section}`;
  students = await api('/api/teacher/students');
  renderAnalytics();
  render();
}

function renderAnalytics() {
  const records = students.flatMap((s) => s.records.map((r) => ({ ...r, studentName: s.name })));
  const totalClasses = records.reduce((sum, r) => sum + r.total_classes, 0);
  const attendedClasses = records.reduce((sum, r) => sum + r.attended, 0);
  const markedRecords = records.filter((r) => r.marks !== null);
  const averageMarks = markedRecords.length
    ? Math.round(markedRecords.reduce((sum, r) => sum + r.marks / r.max_marks * 100, 0) / markedRecords.length)
    : null;
  const overallAttendance = percent(attendedClasses, totalClasses);
  $('class-summary').innerHTML = `
    <article class="summary-card"><span>Students</span><strong>${students.length}</strong></article>
    <article class="summary-card"><span>Class attendance</span><strong class="${attClass(overallAttendance)}">${overallAttendance}%</strong></article>
    <article class="summary-card"><span>Average marks</span><strong>${averageMarks === null ? '—' : `${averageMarks}%`}</strong></article>`;

  const subjects = new Map();
  for (const record of records) {
    if (!subjects.has(record.subject)) subjects.set(record.subject, []);
    subjects.get(record.subject).push(record);
  }
  const subjectStats = [...subjects].map(([subject, subjectRecords]) => {
    const subjectTotal = subjectRecords.reduce((sum, r) => sum + r.total_classes, 0);
    const subjectAttended = subjectRecords.reduce((sum, r) => sum + r.attended, 0);
    const withMarks = subjectRecords.filter((r) => r.marks !== null);
    return {
      subject,
      attendance: percent(subjectAttended, subjectTotal),
      marks: withMarks.length
        ? Math.round(withMarks.reduce((sum, r) => sum + r.marks / r.max_marks * 100, 0) / withMarks.length)
        : null,
    };
  }).sort((a, b) => a.subject.localeCompare(b.subject));
  renderBarChart('class-attendance-chart', subjectStats.map((s) => ({
    label: s.subject, value: s.attendance, color: barColor(s.attendance),
  })));
  renderBarChart('class-marks-chart', subjectStats.map((s) => ({
    label: s.subject, value: s.marks,
  })));

  const lowAttendance = records.filter((r) => percent(r.attended, r.total_classes) < 80);
  renderDonut('class-attendance-pie', 'class-attendance-legend', [
    { label: 'At or above 80%', value: records.length - lowAttendance.length, color: 'var(--good)' },
    { label: 'Below 80%', value: lowAttendance.length, color: 'var(--bad)' },
  ], `${lowAttendance.length} of ${records.length} student-subject records are below 80% attendance`);
  const alert = $('class-alert');
  alert.hidden = !lowAttendance.length;
  alert.innerHTML = lowAttendance.length
    ? `<strong>${lowAttendance.length} student-subject record${lowAttendance.length === 1 ? '' : 's'} below 80%</strong>
      <ul>${lowAttendance.slice(0, 6).map((r) => `<li>${esc(r.studentName)} — ${esc(r.subject)}: ${percent(r.attended, r.total_classes)}%</li>`).join('')}
      ${lowAttendance.length > 6 ? `<li>And ${lowAttendance.length - 6} more. Search for a student below to review their records.</li>` : ''}</ul>`
    : '';
}

function render() {
  const openIds = [...document.querySelectorAll('details[open]')].map((d) => d.dataset.id);
  const q = $('search').value.toLowerCase().trim();
  const shown = students.filter((s) =>
    !q || [s.name, s.roll_no, s.sap_id, ...s.records.map((r) => r.subject)]
      .some((v) => String(v).toLowerCase().includes(q)));
  $('search-count').textContent = q ? `${shown.length} of ${students.length} students` : `${students.length} students`;

  if (!shown.length) {
    $('list').innerHTML = '<p class="note">No students found. Use "Add student" to create one.</p>';
    return;
  }
  $('list').innerHTML = shown.map((s) => cardHtml(s, openIds.includes(String(s.id)))).join('');
}

function cardHtml(s, open) {
  const thumb = s.photo ? `<img class="thumb" src="${photoUrl(s.photo)}" alt="">` : '<div class="thumb"></div>';
  const inputs = FIELDS.map(([key, label]) => {
    const inputId = `student-${s.id}-${key}`;
    return `<div><label for="${inputId}">${label}</label><input id="${inputId}" data-field="${key}" ${fieldAttributes(key)} required value="${esc(s[key])}"></div>`;
  }).join('');

  const rows = s.records.map((r) => `
    <tr data-rid="${r.id}">
      <td>${esc(r.subject)}</td>
      <td><input type="number" min="0" data-k="attended" value="${r.attended}"></td>
      <td><input type="number" min="0" data-k="total_classes" value="${r.total_classes}"></td>
      <td><input type="number" min="0" data-k="marks" value="${r.marks ?? ''}"></td>
      <td><input type="number" min="1" data-k="max_marks" value="${r.max_marks}"></td>
      <td>
        <button class="btn small" onclick="saveRecord(${r.id}, this)">Save</button>
        <button class="btn small danger" onclick="deleteRecord(${r.id})">Remove</button>
      </td>
    </tr>`).join('');

  return `
  <details class="student-card" data-id="${s.id}" ${open ? 'open' : ''}>
    <summary>
      ${thumb}
      <div class="meta"><b>${esc(s.name)}</b><br><small>Roll ${esc(s.roll_no)} · SAP ${esc(s.sap_id)}</small></div>
      <span>${s.records.length} subjects</span>
    </summary>
    <div class="student-body" data-sid="${s.id}">
      <h3 style="margin-top:1rem">Student details</h3>
      <div class="grid2">${inputs}</div>
      <div class="row-actions">
        <button class="btn small" onclick="saveStudent(${s.id}, this)">Save details</button>
        <label class="btn ghost small" style="margin:0">Change photo
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="uploadPhoto(${s.id}, this)">
        </label>
        <button class="btn ghost small" onclick="resetPassword(${s.id})">Reset password</button>
        <button class="btn small danger" onclick="deleteStudent(${s.id})">Delete student</button>
      </div>

      <h3 style="margin-top:1.4rem">Attendance and marks</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Subject</th><th>Attended</th><th>Total classes</th><th>Marks</th><th>Out of</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No subjects yet</td></tr>'}</tbody>
        </table>
      </div>
      <div class="row-actions">
        <input id="new-sub-${s.id}" placeholder="New subject name" style="max-width:240px">
        <button class="btn small" onclick="addSubject(${s.id})">Add subject</button>
      </div>
    </div>
  </details>`;
}

async function run(action, okText) {
  try { await action(); await load(); if (okText) toast(okText); }
  catch (e) { alert(e.message); }
}
function toast(t) { /* tiny confirmation */
  const el = document.createElement('div');
  el.textContent = t;
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1d2433;color:#fff;padding:.6rem 1.1rem;border-radius:6px;z-index:99';
  document.body.appendChild(el); setTimeout(() => el.remove(), 1800);
}

function saveStudent(id) {
  const box = document.querySelector(`.student-body[data-sid="${id}"]`);
  if (![...box.querySelectorAll('[data-field]')].every((input) => input.reportValidity())) return;
  const body = {};
  box.querySelectorAll('[data-field]').forEach((i) => (body[i.dataset.field] = i.value.trim()));
  run(() => api(`/api/teacher/students/${id}`, { method: 'PUT', body }), 'Details saved');
}
function saveRecord(rid) {
  const row = document.querySelector(`tr[data-rid="${rid}"]`);
  if (![...row.querySelectorAll('[data-k]')].every((input) => input.reportValidity())) return;
  const body = {};
  row.querySelectorAll('[data-k]').forEach((i) => (body[i.dataset.k] = i.value));
  run(() => api(`/api/teacher/records/${rid}`, { method: 'PUT', body }), 'Saved');
}
function deleteRecord(rid) {
  if (confirm('Remove this subject from the student?'))
    run(() => api(`/api/teacher/records/${rid}`, { method: 'DELETE' }));
}
function addSubject(id) {
  const subject = $(`new-sub-${id}`).value;
  run(() => api(`/api/teacher/students/${id}/subjects`, { method: 'POST', body: { subject } }), 'Subject added');
}
function deleteStudent(id) {
  if (confirm('Delete this student and all their records?'))
    run(() => api(`/api/teacher/students/${id}`, { method: 'DELETE' }));
}
function resetPassword(id) {
  if (confirm('Reset password to the student\'s SAP ID?'))
    run(() => api(`/api/teacher/students/${id}/reset-password`, { method: 'POST' }), 'Password reset');
}
function uploadPhoto(id, input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('photo', input.files[0]);
  run(() => api(`/api/teacher/students/${id}/photo`, { method: 'POST', body: fd }), 'Photo updated');
}

// add-student dialog
const dlg = $('add-dialog');
$('add-btn').onclick = () => {
  $('add-fields').innerHTML = FIELDS.map(([k, label]) => {
    const preset = k === 'class_name' ? teacher.class_name : k === 'section' ? teacher.section : '';
    const id = `new-${k}`;
    const hint = k === 'sap_id' ? '<small class="field-hint">Use exactly 11 digits.</small>' : '';
    return `<label for="${id}">${label}</label><input id="${id}" data-new="${k}" ${fieldAttributes(k)} required value="${esc(preset)}">${hint}`;
  }).join('');
  $('add-msg').textContent = '';
  dlg.showModal();
};
$('add-close').onclick = () => dlg.close();
$('add-save').onclick = async () => {
  if (![...document.querySelectorAll('[data-new]')].every((input) => input.reportValidity())) return;
  const body = {};
  document.querySelectorAll('[data-new]').forEach((i) => (body[i.dataset.new] = i.value.trim()));
  try {
    await api('/api/teacher/students', { method: 'POST', body });
    dlg.close(); await load(); toast('Student added');
  } catch (e) { $('add-msg').textContent = e.message; }
};

$('search').addEventListener('input', render);
load().catch((e) => alert(e.message));

const phoneDialog = $('phone-dialog');
$('phone-btn').addEventListener('click', () => {
  $('teacher-phone').value = teacher.pending_phone_number || teacher.teacher_uid;
  $('teacher-phone-password').value = '';
  $('phone-msg').textContent = '';
  $('phone-verify-form').hidden = !teacher.pending_phone_number;
  $('phone-verify-msg').textContent = '';
  phoneDialog.showModal();
});
$('phone-close').addEventListener('click', () => phoneDialog.close());
$('phone-cancel').addEventListener('click', () => phoneDialog.close());
$('phone-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = $('phone-form');
  if (!form.reportValidity()) return;
  const button = $('phone-save');
  button.disabled = true;
  $('phone-msg').textContent = '';
  try {
    const result = await api('/api/teacher/phone', {
      method: 'PUT',
      body: {
        phone_number: $('teacher-phone').value.trim(),
        currentPassword: $('teacher-phone-password').value,
      },
    });
    teacher.pending_phone_number = result.pending_phone_number;
    $('phone-verify-form').hidden = false;
    $('phone-verify-msg').textContent = '';
    $('phone-msg').className = 'msg ok';
    $('phone-msg').textContent = result.message;
  } catch (error) {
    $('phone-msg').className = 'msg err';
    $('phone-msg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('phone-verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('phone-verify-form').reportValidity()) return;
  $('phone-verify').disabled = true;
  $('phone-verify-msg').textContent = '';
  try {
    const result = await api('/api/teacher/phone/verify', {
      method: 'POST',
      body: { code: $('teacher-phone-code').value.trim() },
    });
    teacher.teacher_uid = result.teacher_uid;
    teacher.pending_phone_number = '';
    teacher.phone_verified = 1;
    $('who').textContent = `${teacher.name} (ID: ${teacher.teacher_uid})`;
    $('phone-dialog').close();
    toast('Phone verified. Your Teacher ID is now your mobile number.');
  } catch (error) {
    $('phone-verify-msg').className = 'msg err';
    $('phone-verify-msg').textContent = error.message;
  } finally {
    $('phone-verify').disabled = false;
  }
});
