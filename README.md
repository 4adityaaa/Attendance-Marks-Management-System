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
- The seeded teacher ID is a demo placeholder, not a real mobile number. Sign in and use **Update phone / ID** to change it to the teacher's real mobile number before using SMS recovery. Students can add their number from the student dashboard.
- For password recovery, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` in the server environment. Teachers verify their mobile number before it becomes their Teacher ID; students add and verify a mobile number from their dashboard. Recovery and phone-verification codes expire after 5 minutes and are limited to 5 attempts.
- Mobile recovery currently expects an Indian 10-digit mobile number. Do not commit Twilio credentials.

PowerShell setup for SMS recovery (set these in the same terminal before `npm start`):
```powershell
$env:TWILIO_ACCOUNT_SID = "your-account-sid"
$env:TWILIO_AUTH_TOKEN = "your-auth-token"
$env:TWILIO_PHONE_NUMBER = "+1your-twilio-number"
$env:JWT_SECRET = "your-long-random-secret"
npm start
```

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
