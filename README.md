# Student Attendance and Marks Portal

HTML + CSS + JavaScript frontend, Node.js + Express backend, SQLite database.

## Run it (VS Code)
1. Install Node.js LTS from https://nodejs.org (restart VS Code after).
2. File > Open Folder > choose `student-portal`.
3. Open the terminal: Terminal > New Terminal.
4. `npm install`
5. `npm run seed`   (creates college.db with demo data)
6. `npm start`      (or `npm run dev` to auto-restart on changes)
7. Open http://localhost:3000

## Demo logins
- Class teacher: ID `1000001001`, password `teacher123`
- Student: SAP ID `60004240001`, password `60004240001` (first password = SAP ID)
- Teacher IDs must contain exactly 10 digits; student SAP IDs must contain exactly 11 digits.
- Existing demo teacher IDs `T1001` and `T2001` are migrated to `1000001001` and `1000002001` on startup.

## Folder map
- server.js  - Express API (login, student and teacher routes, photo upload)
- db.js      - SQLite tables
- seed.js    - demo teacher, students, subjects
- public/    - index.html (login), student.html, teacher.html, css/, js/, uploads/
- college.db - local SQLite database with teachers, students and per-subject attendance/marks

Both dashboards show subject-level attendance and marks charts. Attendance below 80% is
highlighted, with student-specific warnings and a class-wide teacher overview.

## Before real use
Set a secret:  `JWT_SECRET=your-long-random-text npm start`
