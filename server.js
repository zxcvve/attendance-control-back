const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const app = express();
const port = 3000;

// PostgreSQL client setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// Middleware to parse JSON requests
app.use(express.json());

// Route to get the schedule of a teacher by ID and date
app.get('/schedule', async (req, res) => {
  const { teacherId, dayOfWeek } = req.query;

  if (!teacherId || !dayOfWeek) {
    return res.status(400).json({ error: 'Please provide both teacherId and day of week' });
  }

  try {
    const result = await pool.query(
        `SELECT p.id AS para_id, l.title AS lesson_title, p.groupArr, p.time, p.dayOfWeekArr
       FROM para p
       JOIN leasson l ON p.leassonId = l.id
       WHERE p.teacherId = $1
         AND $2 = ANY(p.dayOfWeekArr)`,
        [teacherId, dayOfWeek]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No schedule found for the given teacher on this date' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to get attendance details for a specific lesson
app.get('/attendance', async (req, res) => {
  const { date, paraId } = req.query;

  if (!date || !paraId) {
    return res.status(400).json({ error: 'Please provide teacherId, date, and paraId' });
  }

  try {
    const result = await pool.query(
        `SELECT s.usergroup AS group, v.isVisited, v.studentId, s.firstname AS studentName, s.lastname AS studentLastname
       FROM Visit v
       JOIN Student s ON v.studentId = s.id
       WHERE v.paraId = $1 AND v.date = $2`,
        [paraId, date]
    );

    const groupedResults = result.rows.reduce((acc, row) => {
      const group = acc.find(g => g.group === row.group);
      const visit = { isVisited: row.isvisited, studentId: row.studentid, studentName: row.studentname, studentLastname: row.studentlastname };

      if (group) {
        group.visits.push(visit);
      } else {
        acc.push({ group: row.group, visits: [visit] });
      }

      return acc;
    }, []);

    if (groupedResults.length === 0) {
      return res.status(404).json({ error: 'No attendance records found for the given criteria' });
    }

    res.json(groupedResults);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/attendance', async (req, res) => {
  const attendanceRecords = req.body;

  if (!Array.isArray(attendanceRecords.visits) || attendanceRecords.visits.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of attendance records' });
  }

  try {
    await pool.query('BEGIN');

    for (const record of attendanceRecords.visits) {
      const { studentId, isVisited, paraId, date } = record;

      await pool.query(
          `UPDATE Visit
         SET isVisited = $1
         WHERE studentId = $2 AND paraId = $3 AND date = $4`,
          [isVisited, studentId, paraId, date]
      );
    }

    await pool.query('COMMIT');
    res.json({ status: 'success' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to get all subjects taught by a specific teacher
app.get('/subjects', async (req, res) => {
  const { teacherId } = req.query;

  if (!teacherId) {
    return res.status(400).json({ error: 'Please provide teacherId' });
  }

  try {
    const result = await pool.query(
        `SELECT l.id AS subject_id, l.title AS subject_title, p.groupArr, p.time
       FROM Para p
       JOIN Leasson l ON p.leassonId = l.id
       WHERE p.teacherId = $1`,
        [teacherId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No subjects found for the given teacher' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route to get attendance by subject, group, and date range
app.get('/attendanceBySubject', async (req, res) => {
  const { teacherId, subjectId, groupId, startDate, endDate } = req.query;

  if (!teacherId || !subjectId || !groupId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Please provide teacherId, subjectId, groupId, startDate, and endDate' });
  }

  try {
    const result = await pool.query(
        `SELECT s.firstname AS studentName, s.lastname AS studentLastname, v.studentId, v.date, v.isVisited
       FROM Visit v
       JOIN Student s ON v.studentId = s.id
       JOIN Para p ON v.paraId = p.id
       WHERE p.teacherId = $1
         AND p.leassonId = $2
         AND $3 = ANY(p.groupArr)
         AND v.date >= $4
         AND v.date <= $5`,
        [teacherId, subjectId, groupId, startDate, endDate]
    );

    const attendanceByStudents = {};

    result.rows.forEach(row => {
      const { studentname, studentlastname, studentid, date, isVisited } = row;
      if (!attendanceByStudents[studentid]) {
        attendanceByStudents[studentid] = {
          studentName: studentname,
          studentLastname: studentlastname,
          studentId: studentid,
          visits: []
        };
      }
      attendanceByStudents[studentid].visits.push({ date: date, isvisited: isVisited });
    });

    const studentsList = Object.values(attendanceByStudents);

    res.json({ studentsList: studentsList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Please provide both email and password' });
  }

  try {
    // Check if user with provided email exists in the database
    const userQuery = await pool.query('SELECT * FROM Users WHERE email = $1', [email]);
    const user = userQuery.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if the provided password matches the hashed password in the database
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user.id, email: user.email }, 'your_secret_key', { expiresIn: '1h' });

    // Additional data for teacher
    let teacherData = {};
    if (user.role === 'teacher') {
      const teacherQuery = await pool.query('SELECT * FROM Teacher WHERE userId = $1', [user.id]);
      teacherData = teacherQuery.rows[0];
    }

    // Return user data and token
    res.json({ user: { id: user.id, email: user.email, role: user.role, ...teacherData }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Please provide both email and password' });
  }

  try {
    // Check if user with provided email already exists
    const userExists = await pool.query('SELECT * FROM Users WHERE email = $1', [email]);

    if (userExists.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user in the database
    const newUser = await pool.query('INSERT INTO Users (email, password) VALUES ($1, $2) RETURNING *', [email, hashedPassword]);

    // Return user data
    const user = newUser.rows[0];
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/attendance/mark', async (req, res) => {
  const { studentId, pairCode } = req.body;

  if (!studentId || !pairCode) {
    return res.status(400).json({ error: 'Please provide both studentId and pairCode' });
  }

  try {
    // Check if the pair code exists
    const pairQuery = await pool.query('SELECT * FROM Para WHERE pairId = $1', [pairCode]);
    const pair = pairQuery.rows[0];

    let ok = false;

    if (pair) {
      // Update the student's attendance status
      await pool.query(
          'UPDATE Visit SET isVisited = true WHERE studentId = $1 AND paraId = $2',
          [studentId, pair.id]
      );
      ok = true;
    } else {
      // If pair code doesn't exist, create a new attendance record for the student
      await pool.query(
          'INSERT INTO Visit (studentId, paraId, isVisited) VALUES ($1, $2, true)',
          [studentId, pairCode]
      );
      ok = true;
    }

    res.json({ ok: ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/attendance/access', async (req, res) => {
  const { teacherId, pairId, accessCode } = req.body;

  if (!teacherId || !pairId || !accessCode) {
    return res.status(400).json({ error: 'Please provide both teacherId, pairId, and accessCode' });
  }

  try {
    // Check if the provided teacherId and pairId match and access code is correct
    const accessQuery = await pool.query(
        'SELECT * FROM Para WHERE teacherId = $1 AND id = $2 AND accessCode = $3',
        [teacherId, pairId, accessCode]
    );
    const access = accessQuery.rows[0];

    let ok = false;

    if (access) {
      ok = true;
    }

    res.json({ ok: ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/attendance/access/remove', async (req, res) => {
  const { teacherId, pairId, accessCode } = req.body;

  if (!teacherId || !pairId || !accessCode) {
    return res.status(400).json({ error: 'Please provide both teacherId, pairId, and accessCode' });
  }

  try {
    // Check if the provided teacherId and pairId match and access code is correct
    const accessQuery = await pool.query(
        'SELECT * FROM Para WHERE teacherId = $1 AND id = $2 AND accessCode = $3',
        [teacherId, pairId, accessCode]
    );
    const access = accessQuery.rows[0];

    let ok = false;

    if (access) {
      // Remove access by updating access code to NULL
      await pool.query('UPDATE Para SET accessCode = NULL WHERE id = $1', [pairId]);
      ok = true;
    }

    res.json({ ok: ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
