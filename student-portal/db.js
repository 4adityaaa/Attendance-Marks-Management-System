const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'college.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_uid  TEXT UNIQUE NOT NULL,       -- unique teacher ID (login)
  name         TEXT NOT NULL,
  password     TEXT NOT NULL,              -- bcrypt hash
  class_name   TEXT NOT NULL,              -- class they teach, e.g. SE Computer
  section      TEXT NOT NULL,              -- e.g. A
  auth_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS administrators (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT UNIQUE NOT NULL,
  name     TEXT NOT NULL,
  password TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sap_id       TEXT UNIQUE NOT NULL,       -- student login
  roll_no      TEXT NOT NULL,
  name         TEXT NOT NULL,
  password     TEXT NOT NULL,              -- bcrypt hash
  photo        TEXT DEFAULT '',            -- file name inside /uploads
  current_year TEXT NOT NULL,              -- e.g. 2nd Year
  class_name   TEXT NOT NULL,
  section      TEXT NOT NULL,
  phone_number TEXT NOT NULL DEFAULT '',
  pending_phone_number TEXT NOT NULL DEFAULT '',
  phone_verified INTEGER NOT NULL DEFAULT 0,
  auth_version INTEGER NOT NULL DEFAULT 0,
  teacher_id   INTEGER REFERENCES teachers(id)
);

CREATE TABLE IF NOT EXISTS subject_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  total_classes  INTEGER NOT NULL DEFAULT 0,
  attended       INTEGER NOT NULL DEFAULT 0,
  marks          REAL,                     -- NULL until teacher enters marks
  max_marks      REAL NOT NULL DEFAULT 100,
  UNIQUE (student_id, subject)
);

CREATE TABLE IF NOT EXISTS password_reset_otps (
  role         TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  account_id   INTEGER NOT NULL,
  otp_hash     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  purpose      TEXT NOT NULL DEFAULT 'password_reset',
  PRIMARY KEY (role, account_id)
);
`);

const studentColumns = db.prepare('PRAGMA table_info(students)').all();
if (!studentColumns.some((column) => column.name === 'phone_number'))
  db.exec("ALTER TABLE students ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''");
if (!studentColumns.some((column) => column.name === 'pending_phone_number'))
  db.exec("ALTER TABLE students ADD COLUMN pending_phone_number TEXT NOT NULL DEFAULT ''");
if (!studentColumns.some((column) => column.name === 'phone_verified'))
  db.exec('ALTER TABLE students ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
if (!studentColumns.some((column) => column.name === 'auth_version'))
  db.exec('ALTER TABLE students ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');

const teacherColumns = db.prepare('PRAGMA table_info(teachers)').all();
if (!teacherColumns.some((column) => column.name === 'pending_phone_number'))
  db.exec("ALTER TABLE teachers ADD COLUMN pending_phone_number TEXT NOT NULL DEFAULT ''");
if (!teacherColumns.some((column) => column.name === 'phone_verified'))
  db.exec('ALTER TABLE teachers ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
if (!teacherColumns.some((column) => column.name === 'auth_version'))
  db.exec('ALTER TABLE teachers ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');

const administratorColumns = db.prepare('PRAGMA table_info(administrators)').all();
if (!administratorColumns.some((column) => column.name === 'auth_version'))
  db.exec('ALTER TABLE administrators ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');

const otpColumns = db.prepare('PRAGMA table_info(password_reset_otps)').all();
if (!otpColumns.some((column) => column.name === 'purpose'))
  db.exec("ALTER TABLE password_reset_otps ADD COLUMN purpose TEXT NOT NULL DEFAULT 'password_reset'");

for (const [legacyId, numericId] of [['T1001', '1000001001'], ['T2001', '1000002001']]) {
  const legacyTeacher = db.prepare('SELECT id FROM teachers WHERE teacher_uid = ?').get(legacyId);
  if (!legacyTeacher) continue;
  const existingTeacher = db.prepare('SELECT id FROM teachers WHERE teacher_uid = ?').get(numericId);
  if (existingTeacher)
    throw new Error(`Cannot migrate teacher ID ${legacyId}: ${numericId} is already in use`);
  db.prepare('UPDATE teachers SET teacher_uid = ? WHERE id = ?').run(numericId, legacyTeacher.id);
}

module.exports = db;
