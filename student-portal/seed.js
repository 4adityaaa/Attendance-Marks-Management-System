// Run once:  npm run seed
const bcrypt = require('bcryptjs');
const db = require('./db');

db.exec("DELETE FROM subject_records; DELETE FROM students; DELETE FROM teachers; DELETE FROM sqlite_sequence;");

const hash = (p) => bcrypt.hashSync(p, 10);

const t = db.prepare(
  'INSERT INTO teachers (teacher_uid, name, password, class_name, section) VALUES (?,?,?,?,?)'
).run('1000001001', 'Prof. Meera Kulkarni', hash('teacher123'), 'SE Computer Engineering', 'A');

const addStudent = db.prepare(`INSERT INTO students
  (sap_id, roll_no, name, password, current_year, class_name, section, teacher_id)
  VALUES (?,?,?,?,?,?,?,?)`);
const addRecord = db.prepare(`INSERT INTO subject_records
  (student_id, subject, total_classes, attended, marks, max_marks) VALUES (?,?,?,?,?,?)`);

const subjects = ['Data Structures', 'DBMS', 'Operating Systems', 'Computer Networks', 'Discrete Maths'];
const people = [
  ['60004240001', '01', 'Aarav Sharma'],
  ['60004240002', '02', 'Isha Patil'],
  ['60004240003', '03', 'Rohan Deshmukh'],
  ['60004240004', '04', 'Sneha Joshi'],
];

for (const [sap, roll, name] of people) {
  // default student password = SAP ID  (they should change it later)
  const s = addStudent.run(sap, roll, name, hash(sap), '2nd Year',
                           'SE Computer Engineering', 'A', t.lastInsertRowid);
  for (const sub of subjects) {
    const total = 30;
    const attended = 18 + Math.floor(Math.random() * 12);
    const marks = 40 + Math.floor(Math.random() * 55);
    addRecord.run(s.lastInsertRowid, sub, total, attended, marks, 100);
  }
}
console.log('Seed done.');
console.log('Teacher login  -> ID: 1000001001  Password: teacher123');
console.log('Student login  -> SAP: 60004240001  Password: 60004240001');
