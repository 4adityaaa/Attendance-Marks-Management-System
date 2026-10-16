const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_RESEND_DELAY_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_REQUESTS_PER_IP = 10;
const otpRequestWindows = new Map();

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function normalizeIndianMobile(value) {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s()-]/g, '');
  const digits = compact.startsWith('+91') ? compact.slice(3) : compact;
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function otpRequestLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let window = otpRequestWindows.get(key);
  if (!window || window.expiresAt <= now) {
    window = { count: 0, expiresAt: now + OTP_REQUEST_WINDOW_MS };
    otpRequestWindows.set(key, window);
  }
  if (window.count >= OTP_MAX_REQUESTS_PER_IP)
    return res.status(429).json({ error: 'Too many recovery requests. Please try again later.' });
  window.count += 1;
  next();
}

function otpHash(role, accountId, otp) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(`${role}:${accountId}:${otp}`, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyOtpHash(storedHash, role, accountId, otp) {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!/^[\da-f]{32}$/.test(saltHex) || !/^[\da-f]{64}$/.test(hashHex)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
  const submittedHash = crypto.scryptSync(`${role}:${accountId}:${otp}`, salt, 32);
  return crypto.timingSafeEqual(expectedHash, submittedHash);
}

function otpMessage(code, purpose) {
  const action = purpose === 'phone_verification' ? 'mobile number verification' : 'password reset';
  return `Your Student Portal ${action} code is ${code}. It expires in 5 minutes. Do not share this code.`;
}

async function sendPasswordOtp(phoneNumber, code, purpose) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER)
    return { configured: false };

  const body = new URLSearchParams({
    To: `+91${phoneNumber}`,
    From: TWILIO_PHONE_NUMBER,
    Body: otpMessage(code, purpose),
  });
  const authorization = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  let response;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    return { configured: true, sent: false };
  }
  return { configured: true, sent: response.ok };
}

async function issueOtp(role, accountId, phoneNumber, purpose) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER)
    return { configured: false, sent: false, cooldown: false };

  const now = Date.now();
  const existing = db.prepare(
    'SELECT purpose, expires_at, last_sent_at FROM password_reset_otps WHERE role = ? AND account_id = ?'
  ).get(role, accountId);
  if (existing && existing.purpose === purpose && existing.expires_at > now
    && now - existing.last_sent_at < OTP_RESEND_DELAY_MS)
    return { configured: true, sent: false, cooldown: true };

  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = otpHash(role, accountId, otp);
  db.prepare(`INSERT INTO password_reset_otps (role, account_id, otp_hash, expires_at, attempts, last_sent_at, purpose)
    VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(role, account_id) DO UPDATE SET
      otp_hash = excluded.otp_hash, expires_at = excluded.expires_at, attempts = 0,
      last_sent_at = excluded.last_sent_at, purpose = excluded.purpose`
  ).run(role, accountId, codeHash, now + OTP_EXPIRY_MS, now, purpose);

  const delivery = await sendPasswordOtp(phoneNumber, otp, purpose);
  if (!delivery.configured || !delivery.sent) {
    db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ? AND otp_hash = ?')
      .run(role, accountId, codeHash);
    return { configured: delivery.configured, sent: false, cooldown: false };
  }
  return { configured: true, sent: true, cooldown: false };
}

function consumeOtp(role, accountId, purpose, code) {
  const challenge = db.prepare(`SELECT otp_hash, expires_at, attempts FROM password_reset_otps
    WHERE role = ? AND account_id = ? AND purpose = ?`).get(role, accountId, purpose);
  if (!challenge) return false;
  if (challenge.expires_at <= Date.now() || challenge.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ?')
      .run(role, accountId);
    return false;
  }
  if (!verifyOtpHash(challenge.otp_hash, role, accountId, code)) {
    db.prepare(`UPDATE password_reset_otps SET attempts = attempts + 1
      WHERE role = ? AND account_id = ? AND purpose = ?`).run(role, accountId, purpose);
    return false;
  }
  db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ?')
    .run(role, accountId);
  return true;
}

// ---------- photo upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, `student-${req.params.id}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

// ---------- auth helpers ----------
function auth(role) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    try {
      const data = jwt.verify(token, SECRET);
      if (data.role !== role) return res.status(403).json({ error: 'Not allowed' });
      const table = role === 'admin' ? 'administrators' : role === 'teacher' ? 'teachers' : 'students';
      const account = db.prepare(`SELECT auth_version FROM ${table} WHERE id = ?`).get(data.uid);
      if (!account || (data.version ?? 0) !== account.auth_version)
        return res.status(401).json({ error: 'Please log in again' });
      req.user = data;
      next();
    } catch {
      res.status(401).json({ error: 'Please log in again' });
    }
  };
}

// ---------- login ----------
app.post('/api/login', async (req, res) => {
  const { role, id, password } = req.body || {};
  if (!['teacher', 'student', 'admin'].includes(role))
    return res.status(400).json({ error: 'Choose student, teacher or administrator sign in' });
  if (typeof id !== 'string' || !password)
    return res.status(400).json({ error: 'Enter your ID and password' });

  const cleanId = id.trim();
  const idIsValid = role === 'admin'
    ? /^[A-Za-z0-9._-]{3,40}$/.test(cleanId)
    : role === 'teacher' ? /^\d{10}$/.test(cleanId) : /^\d{11}$/.test(cleanId);
  if (!idIsValid)
    return res.status(400).json({ error: role === 'admin'
      ? 'Administrator username must be 3–40 letters, numbers, dots, underscores or hyphens'
      : role === 'teacher' ? 'Teacher ID must be exactly 10 digits' : 'SAP ID must be exactly 11 digits' });
  if (typeof password !== 'string' || !password)
    return res.status(400).json({ error: 'Enter your ID and password' });

  const row = role === 'admin'
    ? db.prepare('SELECT * FROM administrators WHERE username = ?').get(cleanId)
    : role === 'teacher'
      ? db.prepare('SELECT * FROM teachers WHERE teacher_uid = ?').get(cleanId)
      : db.prepare('SELECT * FROM students WHERE sap_id = ?').get(cleanId);

  if (!row || !await bcrypt.compare(password, row.password))
    return res.status(401).json({ error: 'ID or password is wrong' });

  const token = jwt.sign({ role, uid: row.id, version: row.auth_version }, SECRET, { expiresIn: '8h' });
  res.json({ token, role, name: row.name });
});

app.post('/api/password/otp/request', otpRequestLimit, async (req, res) => {
  const { role, id } = req.body || {};
  if (!['teacher', 'student'].includes(role))
    return res.status(400).json({ error: 'Choose student or teacher account recovery' });
  if (typeof id !== 'string')
    return res.status(400).json({ error: 'Enter your account ID' });

  const cleanId = id.trim();
  const idIsValid = role === 'teacher' ? /^\d{10}$/.test(cleanId) : /^\d{11}$/.test(cleanId);
  if (!idIsValid)
    return res.status(400).json({ error: role === 'teacher'
      ? 'Teacher ID must be exactly 10 digits'
      : 'SAP ID must be exactly 11 digits' });

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER)
    return res.status(503).json({ error: 'SMS recovery is not configured yet. Please contact your portal administrator.' });

  const account = role === 'teacher'
    ? db.prepare('SELECT id, teacher_uid AS phone_number FROM teachers WHERE teacher_uid = ? AND phone_verified = 1').get(cleanId)
    : db.prepare('SELECT id, phone_number FROM students WHERE sap_id = ? AND phone_verified = 1').get(cleanId);
  const phoneNumber = account && normalizeIndianMobile(account.phone_number);
  if (!account || !phoneNumber)
    return res.json({ message: 'If the account has a registered mobile number, a recovery code will be sent.' });

  const delivery = await issueOtp(role, account.id, phoneNumber, 'password_reset');
  if (!delivery.configured)
    return res.status(503).json({ error: 'SMS recovery is not configured yet. Please contact your portal administrator.' });
  if (!delivery.sent && !delivery.cooldown)
    return res.status(502).json({ error: 'We could not send the recovery code. Please try again later.' });
  res.json({ message: 'If the account has a registered mobile number, a recovery code will be sent.' });
});

app.post('/api/password/otp/reset', (req, res) => {
  const { role, id, code, newPassword } = req.body || {};
  if (!['teacher', 'student'].includes(role))
    return res.status(400).json({ error: 'Choose student or teacher account recovery' });
  if (typeof id !== 'string' || typeof code !== 'string')
    return res.status(400).json({ error: 'Enter your account ID and recovery code' });
  if (typeof newPassword !== 'string' || newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const cleanId = id.trim();
  const idIsValid = role === 'teacher' ? /^\d{10}$/.test(cleanId) : /^\d{11}$/.test(cleanId);
  if (!idIsValid)
    return res.status(400).json({ error: role === 'teacher'
      ? 'Teacher ID must be exactly 10 digits'
      : 'SAP ID must be exactly 11 digits' });
  if (!/^\d{6}$/.test(code))
    return res.status(400).json({ error: 'Recovery code must be exactly 6 digits' });

  const account = role === 'teacher'
    ? db.prepare('SELECT id FROM teachers WHERE teacher_uid = ? AND phone_verified = 1').get(cleanId)
    : db.prepare('SELECT id FROM students WHERE sap_id = ? AND phone_verified = 1').get(cleanId);
  if (!account)
    return res.status(400).json({ error: 'Recovery code is invalid or expired. Request a new code.' });
  if (!consumeOtp(role, account.id, 'password_reset', code))
    return res.status(400).json({ error: 'Recovery code is invalid or expired. Request a new code.' });

  const table = role === 'teacher' ? 'teachers' : 'students';
  db.prepare(`UPDATE ${table} SET password = ?, auth_version = auth_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(newPassword, 10), account.id);
  res.json({ ok: true, message: 'Password reset successfully. You can now sign in.' });
});

// ---------- student routes ----------
function studentWithRecords(studentId) {
  const s = db.prepare(`
    SELECT s.id, s.sap_id, s.roll_no, s.name, s.photo, s.current_year,
           s.phone_number, s.pending_phone_number, s.phone_verified,
           s.class_name, s.section, t.name AS teacher_name, t.teacher_uid
    FROM students s LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE s.id = ?`).get(studentId);
  if (!s) return null;
  s.records = db.prepare(
    'SELECT id, subject, total_classes, attended, marks, max_marks FROM subject_records WHERE student_id = ? ORDER BY subject'
  ).all(studentId);
  return s;
}

const adminOnly = auth('admin');

app.get('/api/admin/overview', adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT
      t.id AS teacher_id, t.teacher_uid, t.name AS teacher_name, t.class_name AS teacher_class,
      t.section AS teacher_section, t.phone_verified AS teacher_phone_verified,
      s.id AS student_id, s.sap_id, s.roll_no, s.name AS student_name, s.photo,
      s.current_year, s.class_name AS student_class, s.section AS student_section,
      s.phone_number, s.phone_verified AS student_phone_verified,
      r.id AS record_id, r.subject, r.total_classes, r.attended, r.marks, r.max_marks
    FROM teachers t
    LEFT JOIN students s ON s.teacher_id = t.id
    LEFT JOIN subject_records r ON r.student_id = s.id
    ORDER BY t.name, s.roll_no, s.id, r.subject`).all();

  const teachers = new Map();
  for (const row of rows) {
    let teacher = teachers.get(row.teacher_id);
    if (!teacher) {
      teacher = {
        id: row.teacher_id,
        teacher_uid: row.teacher_uid,
        name: row.teacher_name,
        class_name: row.teacher_class,
        section: row.teacher_section,
        phone_verified: row.teacher_phone_verified,
        students: [],
      };
      teachers.set(row.teacher_id, teacher);
    }

    if (row.student_id == null) continue;
    let student = teacher.students[teacher.students.length - 1];
    if (!student || student.id !== row.student_id) {
      student = {
        id: row.student_id,
        sap_id: row.sap_id,
        roll_no: row.roll_no,
        name: row.student_name,
        photo: row.photo,
        current_year: row.current_year,
        class_name: row.student_class,
        section: row.student_section,
        phone_number: row.student_phone_verified ? row.phone_number : '',
        phone_verified: row.student_phone_verified,
        records: [],
      };
      teacher.students.push(student);
    }
    if (row.record_id != null) {
      student.records.push({
        id: row.record_id,
        subject: row.subject,
        total_classes: row.total_classes,
        attended: row.attended,
        marks: row.marks,
        max_marks: row.max_marks,
      });
    }
  }
  res.json([...teachers.values()]);
});

app.post('/api/admin/teachers', adminOnly, (req, res) => {
  const { teacher_uid, name, password, class_name, section } = req.body || {};
  const teacherId = normalizeIndianMobile(teacher_uid);
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanClass = typeof class_name === 'string' ? class_name.trim() : '';
  const cleanSection = typeof section === 'string' ? section.trim() : '';
  if (!teacherId || !cleanName || !cleanClass || !cleanSection || typeof password !== 'string')
    return res.status(400).json({ error: 'Enter a valid mobile number and complete all teacher details' });
  if (password.length < 8 || password.length > 128)
    return res.status(400).json({ error: 'Teacher password must be 8–128 characters' });
  try {
    const result = db.prepare(`INSERT INTO teachers (teacher_uid, name, password, class_name, section)
      VALUES (?, ?, ?, ?, ?)`)
      .run(teacherId, cleanName, bcrypt.hashSync(password, 10), cleanClass, cleanSection);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (String(error.message).includes('UNIQUE'))
      return res.status(400).json({ error: 'That mobile number is already registered as a Teacher ID' });
    throw error;
  }
});

app.delete('/api/admin/teachers/:id', adminOnly, (req, res) => {
  const teacherId = Number(req.params.id);
  if (!Number.isSafeInteger(teacherId) || teacherId < 1)
    return res.status(400).json({ error: 'Invalid teacher account' });
  const teacher = db.prepare('SELECT id FROM teachers WHERE id = ?').get(teacherId);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
  const studentCount = db.prepare('SELECT COUNT(*) AS count FROM students WHERE teacher_id = ?')
    .get(teacherId).count;
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ?')
      .run('teacher', teacherId);
    db.prepare(`DELETE FROM password_reset_otps WHERE role = 'student'
      AND account_id IN (SELECT id FROM students WHERE teacher_id = ?)`).run(teacherId);
    db.prepare('DELETE FROM students WHERE teacher_id = ?').run(teacherId);
    db.prepare('DELETE FROM teachers WHERE id = ?').run(teacherId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.json({ ok: true, studentsDeleted: studentCount });
});

app.delete('/api/admin/students/:id', adminOnly, (req, res) => {
  const studentId = Number(req.params.id);
  if (!Number.isSafeInteger(studentId) || studentId < 1)
    return res.status(400).json({ error: 'Invalid student account' });
  const student = db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ?')
    .run('student', studentId);
  db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
  res.json({ ok: true });
});

app.put('/api/admin/accounts/:role/:id/password', adminOnly, (req, res) => {
  const { role } = req.params;
  const accountId = Number(req.params.id);
  const table = role === 'teacher' ? 'teachers' : role === 'student' ? 'students' : null;
  if (!table || !Number.isSafeInteger(accountId) || accountId < 1)
    return res.status(400).json({ error: 'Invalid account' });
  const { newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128)
    return res.status(400).json({ error: 'New password must be 8–128 characters' });
  const account = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(accountId);
  if (!account) return res.status(404).json({ error: `${role === 'teacher' ? 'Teacher' : 'Student'} not found` });
  db.prepare(`UPDATE ${table} SET password = ?, auth_version = auth_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(newPassword, 10), accountId);
  db.prepare('DELETE FROM password_reset_otps WHERE role = ? AND account_id = ?')
    .run(role, accountId);
  res.json({ ok: true });
});

app.put('/api/admin/password', adminOnly, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword)
    return res.status(400).json({ error: 'Enter your current password' });
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128)
    return res.status(400).json({ error: 'New administrator password must be 12–128 characters' });
  const admin = db.prepare('SELECT id, password FROM administrators WHERE id = ?').get(req.user.uid);
  if (!admin || !bcrypt.compareSync(currentPassword, admin.password))
    return res.status(401).json({ error: 'Current password is wrong' });
  db.prepare(`UPDATE administrators SET password = ?, auth_version = auth_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(newPassword, 12), admin.id);
  res.json({ ok: true });
});

app.get('/api/student/me', auth('student'), (req, res) => {
  res.json(studentWithRecords(req.user.uid));
});

app.put('/api/student/phone', auth('student'), otpRequestLimit, async (req, res) => {
  const phoneNumber = normalizeIndianMobile(req.body && req.body.phone_number);
  if (!phoneNumber)
    return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
  const account = db.prepare('SELECT id, pending_phone_number FROM students WHERE id = ?').get(req.user.uid);
  if (!account) return res.status(404).json({ error: 'Student account not found' });
  const previousPendingNumber = account.pending_phone_number;
  db.prepare('UPDATE students SET pending_phone_number = ? WHERE id = ?').run(phoneNumber, account.id);
  const delivery = await issueOtp('student', account.id, phoneNumber, 'phone_verification');
  if (!delivery.configured || (!delivery.sent && !delivery.cooldown)) {
    db.prepare('UPDATE students SET pending_phone_number = ? WHERE id = ?')
      .run(previousPendingNumber, account.id);
    return res.status(delivery.configured ? 502 : 503).json({
      error: delivery.configured
        ? 'We could not send the verification code. Please try again later.'
        : 'SMS verification is not configured yet. Please contact your portal administrator.',
    });
  }
  if (delivery.cooldown && previousPendingNumber !== phoneNumber) {
    db.prepare('UPDATE students SET pending_phone_number = ? WHERE id = ?')
      .run(previousPendingNumber, account.id);
    return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
  }
  res.json({ pending_phone_number: phoneNumber, message: 'A verification code was sent to your new number.' });
});

app.post('/api/student/phone/verify', auth('student'), (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code))
    return res.status(400).json({ error: 'Verification code must be exactly 6 digits' });
  const account = db.prepare('SELECT id, pending_phone_number FROM students WHERE id = ?').get(req.user.uid);
  if (!account || !account.pending_phone_number)
    return res.status(400).json({ error: 'Request a verification code for your mobile number first' });
  if (!consumeOtp('student', account.id, 'phone_verification', code))
    return res.status(400).json({ error: 'Verification code is invalid or expired. Request a new code.' });
  db.prepare('UPDATE students SET phone_number = pending_phone_number, pending_phone_number = ?, phone_verified = 1 WHERE id = ?')
    .run('', account.id);
  const student = db.prepare('SELECT phone_number FROM students WHERE id = ?').get(account.id);
  res.json({ phone_number: student.phone_number });
});

app.post('/api/student/password', auth('student'), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(req.user.uid);
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'New password needs at least 6 characters' });
  if (!bcrypt.compareSync(oldPassword || '', s.password))
    return res.status(401).json({ error: 'Old password is wrong' });
  db.prepare('UPDATE students SET password = ?, auth_version = auth_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), s.id);
  res.json({ ok: true });
});

// ---------- teacher routes ----------
const teacherOnly = auth('teacher');

// make sure the student belongs to this teacher
function ownStudent(req, res, next) {
  const s = db.prepare('SELECT id FROM students WHERE id = ? AND teacher_id = ?')
    .get(req.params.id, req.user.uid);
  if (!s) return res.status(404).json({ error: 'Student not found in your class' });
  next();
}

app.get('/api/teacher/me', teacherOnly, (req, res) => {
  res.json(db.prepare(
    'SELECT teacher_uid, name, class_name, section, pending_phone_number, phone_verified FROM teachers WHERE id = ?'
  ).get(req.user.uid));
});

app.put('/api/teacher/phone', teacherOnly, otpRequestLimit, async (req, res) => {
  const { currentPassword } = req.body || {};
  const phoneNumber = normalizeIndianMobile(req.body && req.body.phone_number);
  if (!phoneNumber)
    return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number' });
  if (typeof currentPassword !== 'string' || !currentPassword)
    return res.status(400).json({ error: 'Enter your current password to change your Teacher ID' });

  const teacher = db.prepare('SELECT id, password FROM teachers WHERE id = ?').get(req.user.uid);
  if (!bcrypt.compareSync(currentPassword, teacher.password))
    return res.status(401).json({ error: 'Current password is wrong' });
  const previousPendingNumber = db.prepare('SELECT pending_phone_number FROM teachers WHERE id = ?')
    .get(teacher.id).pending_phone_number;
  db.prepare('UPDATE teachers SET pending_phone_number = ? WHERE id = ?').run(phoneNumber, teacher.id);
  const delivery = await issueOtp('teacher', teacher.id, phoneNumber, 'phone_verification');
  if (!delivery.configured || (!delivery.sent && !delivery.cooldown)) {
    db.prepare('UPDATE teachers SET pending_phone_number = ? WHERE id = ?')
      .run(previousPendingNumber, teacher.id);
    return res.status(delivery.configured ? 502 : 503).json({
      error: delivery.configured
        ? 'We could not send the verification code. Please try again later.'
        : 'SMS verification is not configured yet. Please contact your portal administrator.',
    });
  }
  if (delivery.cooldown && previousPendingNumber !== phoneNumber) {
    db.prepare('UPDATE teachers SET pending_phone_number = ? WHERE id = ?')
      .run(previousPendingNumber, teacher.id);
    return res.status(429).json({ error: 'Please wait before requesting another verification code.' });
  }
  res.json({ pending_phone_number: phoneNumber, message: 'A verification code was sent to your new number.' });
});

app.post('/api/teacher/phone/verify', teacherOnly, (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !/^\d{6}$/.test(code))
    return res.status(400).json({ error: 'Verification code must be exactly 6 digits' });
  const teacher = db.prepare('SELECT id, pending_phone_number FROM teachers WHERE id = ?')
    .get(req.user.uid);
  if (!teacher || !teacher.pending_phone_number)
    return res.status(400).json({ error: 'Request a verification code for your mobile number first' });
  const existingTeacher = db.prepare('SELECT id FROM teachers WHERE teacher_uid = ? AND id != ?')
    .get(teacher.pending_phone_number, teacher.id);
  if (existingTeacher)
    return res.status(400).json({ error: 'That phone number is already registered as a Teacher ID' });
  if (!consumeOtp('teacher', teacher.id, 'phone_verification', code))
    return res.status(400).json({ error: 'Verification code is invalid or expired. Request a new code.' });
  db.prepare(`UPDATE teachers SET teacher_uid = pending_phone_number,
    pending_phone_number = '', phone_verified = 1 WHERE id = ?`).run(teacher.id);
  const updatedTeacher = db.prepare('SELECT teacher_uid FROM teachers WHERE id = ?').get(teacher.id);
  res.json({ teacher_uid: updatedTeacher.teacher_uid });
});

app.get('/api/teacher/students', teacherOnly, (req, res) => {
  const ids = db.prepare('SELECT id FROM students WHERE teacher_id = ? ORDER BY roll_no')
    .all(req.user.uid);
  res.json(ids.map((r) => studentWithRecords(r.id)));
});

app.post('/api/teacher/students', teacherOnly, (req, res) => {
  const { sap_id, roll_no, name, current_year, class_name, section } = req.body || {};
  const cleanSapId = typeof sap_id === 'string' ? sap_id.trim() : '';
  if (![cleanSapId, roll_no, name, current_year, class_name, section].every(Boolean))
    return res.status(400).json({ error: 'Fill all the fields' });
  if (!/^\d{11}$/.test(cleanSapId))
    return res.status(400).json({ error: 'SAP ID must be exactly 11 digits' });
  try {
    const r = db.prepare(`INSERT INTO students
      (sap_id, roll_no, name, password, current_year, class_name, section, teacher_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(cleanSapId, roll_no, name, bcrypt.hashSync(cleanSapId, 10), current_year, class_name, section, req.user.uid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'This SAP ID already exists' });
  }
});

app.put('/api/teacher/students/:id', teacherOnly, ownStudent, (req, res) => {
  const { sap_id, roll_no, name, current_year, class_name, section } = req.body || {};
  const cleanSapId = typeof sap_id === 'string' ? sap_id.trim() : '';
  if (![cleanSapId, roll_no, name, current_year, class_name, section].every(Boolean))
    return res.status(400).json({ error: 'Fill all the fields' });
  if (!/^\d{11}$/.test(cleanSapId))
    return res.status(400).json({ error: 'SAP ID must be exactly 11 digits' });
  try {
    db.prepare(`UPDATE students SET sap_id=?, roll_no=?, name=?, current_year=?, class_name=?, section=?
                WHERE id=?`).run(cleanSapId, roll_no, name, current_year, class_name, section, req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'This SAP ID already exists' });
  }
});

app.delete('/api/teacher/students/:id', teacherOnly, ownStudent, (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/teacher/students/:id/photo', teacherOnly, ownStudent, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG or WEBP under 2 MB' });
  db.prepare('UPDATE students SET photo = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ photo: req.file.filename });
});

app.post('/api/teacher/students/:id/reset-password', teacherOnly, ownStudent, (req, res) => {
  const s = db.prepare('SELECT sap_id FROM students WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE students SET password = ?, auth_version = auth_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(s.sap_id, 10), req.params.id);
  res.json({ ok: true });
});

// add a subject row for a student
app.post('/api/teacher/students/:id/subjects', teacherOnly, ownStudent, (req, res) => {
  const subject = (req.body.subject || '').trim();
  if (!subject) return res.status(400).json({ error: 'Enter a subject name' });
  try {
    db.prepare('INSERT INTO subject_records (student_id, subject) VALUES (?,?)').run(req.params.id, subject);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Subject already added for this student' });
  }
});

// update attendance + marks of one subject
app.put('/api/teacher/records/:rid', teacherOnly, (req, res) => {
  const rec = db.prepare(`SELECT r.id FROM subject_records r
    JOIN students s ON s.id = r.student_id
    WHERE r.id = ? AND s.teacher_id = ?`).get(req.params.rid, req.user.uid);
  if (!rec) return res.status(404).json({ error: 'Record not found' });

  const total = Number(req.body.total_classes);
  const attended = Number(req.body.attended);
  const max = Number(req.body.max_marks);
  const marks = req.body.marks === '' || req.body.marks == null ? null : Number(req.body.marks);

  if ([total, attended, max].some((n) => !Number.isFinite(n) || n < 0))
    return res.status(400).json({ error: 'Numbers must be zero or more' });
  if (attended > total) return res.status(400).json({ error: 'Attended cannot be more than total classes' });
  if (marks !== null && (!Number.isFinite(marks) || marks < 0 || marks > max))
    return res.status(400).json({ error: 'Marks must be between 0 and the maximum' });

  db.prepare('UPDATE subject_records SET total_classes=?, attended=?, marks=?, max_marks=? WHERE id=?')
    .run(total, attended, marks, max, req.params.rid);
  res.json({ ok: true });
});

app.delete('/api/teacher/records/:rid', teacherOnly, (req, res) => {
  db.prepare(`DELETE FROM subject_records WHERE id = ? AND student_id IN
    (SELECT id FROM students WHERE teacher_id = ?)`).run(req.params.rid, req.user.uid);
  res.json({ ok: true });
});

function provisionInitialAdmin() {
  const username = process.env.PORTAL_ADMIN_USERNAME;
  const password = process.env.PORTAL_ADMIN_PASSWORD;
  if (!username && !password) return;
  if (!username || !password)
    throw new Error('Set both PORTAL_ADMIN_USERNAME and PORTAL_ADMIN_PASSWORD to provision the initial admin');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username))
    throw new Error('PORTAL_ADMIN_USERNAME must be 3–40 letters, numbers, dots, underscores or hyphens');
  if (password.length < 12)
    throw new Error('PORTAL_ADMIN_PASSWORD must be at least 12 characters');
  if (db.prepare('SELECT id FROM administrators WHERE id = 1').get()) return;
  db.prepare('INSERT INTO administrators (id, username, name, password) VALUES (1, ?, ?, ?)')
    .run(username, 'Portal Administrator', bcrypt.hashSync(password, 12));
  console.log(`Initial administrator provisioned: ${username}`);
}

provisionInitialAdmin();
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
