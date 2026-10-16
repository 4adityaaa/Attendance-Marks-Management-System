if (!getToken()) location.href = '/';

let teachers = [];
let passwordTarget = null;
const $ = (id) => document.getElementById(id);

async function load() {
  teachers = await api('/api/admin/overview');
  $('admin-summary').innerHTML = `
    <article class="summary-card"><span>Teachers</span><strong>${teachers.length}</strong></article>
    <article class="summary-card"><span>Students</span><strong>${teachers.reduce((sum, teacher) => sum + teacher.students.length, 0)}</strong></article>
    <article class="summary-card"><span>Classes</span><strong>${new Set(teachers.map((teacher) => `${teacher.class_name} · ${teacher.section}`)).size}</strong></article>`;
  render();
}

function studentMatches(student, query) {
  return [
    student.name, student.sap_id, student.roll_no, student.class_name, student.section,
    student.phone_number, ...student.records.map((record) => record.subject),
  ].some((value) => String(value || '').toLowerCase().includes(query));
}

function render() {
  const query = $('admin-search').value.toLowerCase().trim();
  const shown = teachers.map((teacher) => {
    const teacherMatches = [teacher.name, teacher.teacher_uid, teacher.class_name, teacher.section]
      .some((value) => String(value || '').toLowerCase().includes(query));
    const matchingStudents = teacherMatches || !query
      ? teacher.students
      : teacher.students.filter((student) => studentMatches(student, query));
    return { ...teacher, shownStudents: matchingStudents, teacherMatches };
  }).filter((teacher) => teacher.teacherMatches || teacher.shownStudents.length);

  const totalStudents = teachers.reduce((sum, teacher) => sum + teacher.students.length, 0);
  const visibleStudents = shown.reduce((sum, teacher) => sum + teacher.shownStudents.length, 0);
  $('admin-search-count').textContent = query
    ? `${shown.length} teachers · ${visibleStudents} of ${totalStudents} students`
    : `${teachers.length} teachers · ${totalStudents} students`;
  $('teacher-list').innerHTML = shown.length
    ? shown.map(teacherCard).join('')
    : '<p class="note">No teachers or students match your search.</p>';
}

function recordRows(records) {
  if (!records.length) return '<tr><td colspan="5">No subject records yet.</td></tr>';
  return records.map((record) => {
    const attendance = percent(record.attended, record.total_classes);
    return `<tr>
      <td>${esc(record.subject)}</td>
      <td>${record.attended} / ${record.total_classes}</td>
      <td class="${attClass(attendance)}">${attendance}%</td>
      <td>${record.marks === null ? 'Not entered' : `${record.marks} / ${record.max_marks}`}</td>
      <td>${record.marks === null ? '—' : `${Math.round(record.marks / record.max_marks * 100)}%`}</td>
    </tr>`;
  }).join('');
}

function studentCard(student) {
  const phone = student.phone_number
    ? `${esc(student.phone_number)} · verified`
    : 'No verified recovery phone';
  return `<details class="admin-student">
    <summary>
      <span><b>${esc(student.name)}</b><small>SAP ${esc(student.sap_id)} · Roll ${esc(student.roll_no)}</small></span>
      <span>${student.records.length} subjects</span>
    </summary>
    <div class="admin-student-body">
      <dl class="admin-facts">
        <div><dt>Year</dt><dd>${esc(student.current_year)}</dd></div>
        <div><dt>Class / section</dt><dd>${esc(student.class_name)} · ${esc(student.section)}</dd></div>
        <div><dt>Recovery phone</dt><dd>${phone}</dd></div>
      </dl>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Subject</th><th>Attended / total</th><th>Attendance</th><th>Marks</th><th>Score</th></tr></thead>
          <tbody>${recordRows(student.records)}</tbody>
        </table>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" data-action="reset-password" data-role="student" data-id="${student.id}" data-name="${esc(student.name)}">Reset password</button>
        <button class="btn small danger" data-action="delete-student" data-id="${student.id}" data-name="${esc(student.name)}">Delete student</button>
      </div>
    </div>
  </details>`;
}

function teacherCard(teacher) {
  const status = teacher.phone_verified
    ? '<span class="status-badge good">Phone verified</span>'
    : '<span class="status-badge warn">Phone not verified</span>';
  const phone = esc(teacher.teacher_uid);
  return `<article class="admin-teacher">
    <div class="admin-teacher-heading">
      <div>
        <h2>${esc(teacher.name)}</h2>
        <p class="note">${esc(teacher.class_name)} · Section ${esc(teacher.section)}</p>
        <p class="admin-teacher-meta">Teacher ID / phone: <b>${phone}</b> ${status}</p>
      </div>
      <div class="row-actions admin-actions">
        <button class="btn ghost small" data-action="reset-password" data-role="teacher" data-id="${teacher.id}" data-name="${esc(teacher.name)}">Reset password</button>
        <button class="btn small danger" data-action="delete-teacher" data-id="${teacher.id}" data-name="${esc(teacher.name)}" data-students="${teacher.students.length}">Delete teacher &amp; students</button>
      </div>
    </div>
    <h3>Students (${teacher.shownStudents.length}${teacher.shownStudents.length !== teacher.students.length ? ` of ${teacher.students.length}` : ''})</h3>
    ${teacher.shownStudents.length
      ? teacher.shownStudents.map(studentCard).join('')
      : '<p class="note">No students are assigned to this teacher.</p>'}
  </article>`;
}

function openPasswordDialog(role, id, name) {
  passwordTarget = { role, id };
  $('password-account-label').textContent = `${role === 'teacher' ? 'Teacher' : 'Student'}: ${name}`;
  $('password-form').reset();
  $('password-form-msg').textContent = '';
  $('password-form-msg').className = 'msg';
  $('password-dialog').showModal();
}

document.addEventListener('click', async (event) => {
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) {
    $(closeButton.dataset.closeDialog).close();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = Number(button.dataset.id);
  const name = button.dataset.name;
  if (button.dataset.action === 'reset-password') {
    openPasswordDialog(button.dataset.role, id, name);
    return;
  }
  if (button.dataset.action === 'delete-student') {
    if (!confirm(`Delete ${name} and all their attendance and marks records? This cannot be undone.`)) return;
    try {
      await api(`/api/admin/students/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) { alert(error.message); }
    return;
  }
  if (button.dataset.action === 'delete-teacher') {
    const studentCount = Number(button.dataset.students);
    const message = `Delete teacher ${name} and ${studentCount} assigned student${studentCount === 1 ? '' : 's'} with all their records? This cannot be undone.`;
    if (!confirm(message)) return;
    try {
      await api(`/api/admin/teachers/${id}`, { method: 'DELETE' });
      await load();
    } catch (error) { alert(error.message); }
  }
});

$('admin-search').addEventListener('input', render);
$('add-teacher').addEventListener('click', () => {
  $('teacher-form').reset();
  $('teacher-form-msg').textContent = '';
  $('teacher-form-msg').className = 'msg';
  $('teacher-dialog').showModal();
});
$('teacher-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('teacher-form').reportValidity()) return;
  const button = $('create-teacher-submit');
  button.disabled = true;
  $('teacher-form-msg').textContent = '';
  const body = Object.fromEntries(new FormData($('teacher-form')).entries());
  try {
    await api('/api/admin/teachers', { method: 'POST', body });
    $('teacher-dialog').close();
    await load();
  } catch (error) {
    $('teacher-form-msg').className = 'msg err';
    $('teacher-form-msg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!passwordTarget || !$('password-form').reportValidity()) return;
  const button = $('password-submit');
  button.disabled = true;
  $('password-form-msg').textContent = '';
  try {
    await api(`/api/admin/accounts/${passwordTarget.role}/${passwordTarget.id}/password`, {
      method: 'PUT',
      body: { newPassword: $('admin-new-password').value },
    });
    $('password-form-msg').className = 'msg ok';
    $('password-form-msg').textContent = 'Password reset. Share the new password securely with the account holder.';
    $('password-form').reset();
    passwordTarget = null;
  } catch (error) {
    $('password-form-msg').className = 'msg err';
    $('password-form-msg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('change-admin-password').addEventListener('click', () => {
  $('admin-password-form').reset();
  $('admin-password-msg').textContent = '';
  $('admin-password-msg').className = 'msg';
  $('admin-password-dialog').showModal();
});
$('admin-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('admin-password-form').reportValidity()) return;
  const button = $('admin-password-submit');
  button.disabled = true;
  $('admin-password-msg').textContent = '';
  try {
    await api('/api/admin/password', {
      method: 'PUT',
      body: {
        currentPassword: $('admin-current-password').value,
        newPassword: $('admin-account-new-password').value,
      },
    });
    $('admin-password-msg').className = 'msg ok';
    $('admin-password-msg').textContent = 'Password changed. Please sign in again with your new password.';
    localStorage.removeItem('portal_token');
    setTimeout(() => { location.href = '/'; }, 1500);
  } catch (error) {
    $('admin-password-msg').className = 'msg err';
    $('admin-password-msg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

load().catch((error) => {
  $('teacher-list').innerHTML = `<p class="msg err">${esc(error.message)}</p>`;
});
