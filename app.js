const express = require("express");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "barakad.db");

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("Database error:", err.message);
  else console.log("Connected to BARAKAD database.");
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "BARAKAD-SCHOOL-SECRET-2026",
    resave: false,
    saveUninitialized: false
  })
);

/* =========================
   DATABASE HELPERS
========================= */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function tableColumns(table) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

async function addColumnIfMissing(table, column, definition) {
  const cols = await tableColumns(table);
  if (!cols.includes(column)) {
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Added ${column} to ${table}`);
    } catch (e) {
      console.log(`Could not add ${column} to ${table}: ${e.message}`);
    }
  }
}

async function ensureDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  // Compatibility columns for older BARAKAD users tables.
  await addColumnIfMissing("users", "name", "TEXT");
  await addColumnIfMissing("users", "role", "TEXT DEFAULT 'student'");
  await addColumnIfMissing("users", "phone", "TEXT");
  await addColumnIfMissing("users", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");

  await run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT UNIQUE,
      name TEXT,
      gender TEXT,
      dob TEXT,
      class_name TEXT,
      parent_name TEXT,
      parent_phone TEXT,
      address TEXT,
      username TEXT,
      password TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id TEXT UNIQUE,
      name TEXT,
      subject TEXT,
      class_name TEXT,
      username TEXT UNIQUE,
      password TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id TEXT UNIQUE,
      name TEXT,
      type TEXT,
      section TEXT,
      teacher_name TEXT,
      academic_year TEXT,
      room TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT UNIQUE,
      name TEXT,
      class_name TEXT,
      teacher_name TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT,
      student_name TEXT,
      class_name TEXT,
      subject_name TEXT,
      teacher_name TEXT,
      attendance_date TEXT,
      session TEXT,
      status TEXT,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* Compatibility columns for older BARAKAD databases */
  const migrations = [
    ["users", "name", "TEXT"],
    ["students", "username", "TEXT"],
    ["students", "password", "TEXT"],
    ["students", "parent_phone", "TEXT"],
    ["students", "address", "TEXT"],
    ["parents", "username", "TEXT"],
    ["parents", "password", "TEXT"],
    ["teachers", "username", "TEXT"],
    ["teachers", "password", "TEXT"],
    ["classes", "class_id", "TEXT"],
    ["classes", "name", "TEXT"],
    ["classes", "type", "TEXT"],
    ["classes", "section", "TEXT"],
    ["classes", "teacher_name", "TEXT"],
    ["classes", "academic_year", "TEXT"],
    ["classes", "room", "TEXT"],
    ["subjects", "subject_id", "TEXT"],
    ["subjects", "name", "TEXT"],
    ["subjects", "class_name", "TEXT"],
    ["subjects", "teacher_name", "TEXT"],
    ["attendance", "student_id", "TEXT"],
    ["attendance", "student_name", "TEXT"],
    ["attendance", "class_name", "TEXT"],
    ["attendance", "subject_name", "TEXT"],
    ["attendance", "teacher_name", "TEXT"],
    ["attendance", "attendance_date", "TEXT"],
    ["attendance", "session", "TEXT"],
    ["attendance", "status", "TEXT"],
    ["attendance", "recorded_at", "DATETIME"]
  ];

  for (const [table, column, definition] of migrations) {
    await addColumnIfMissing(table, column, definition);
  }

  /* Make old rows usable where possible */
  try {
    await run(`
      UPDATE classes
      SET class_id = COALESCE(NULLIF(class_id,''), 'CLS-' || id)
      WHERE class_id IS NULL OR TRIM(class_id) = ''
    `);
  } catch (_) {}

  /* Remove old duplicate attendance rows before adding the one-time rule. */
  try {
    await run(`
      DELETE FROM attendance
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM attendance
        GROUP BY student_id, attendance_date, LOWER(TRIM(subject_name)), LOWER(TRIM(session))
      )
    `);
  } catch (_) {}

  /* One attendance record per student + date + subject + session. */
  try {
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_once
      ON attendance (student_id, attendance_date, subject_name, session)
    `);
  } catch (_) {}

  const admin = await get(`SELECT * FROM users WHERE username = ?`, ["admin"]);
  if (!admin) {
    const hash = await bcrypt.hash("Admin@123", 10);
    await run(`INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)`, [
      "admin",
      hash,
      "Administrator",
      "admin"
    ]);
    console.log("Default admin created.");
  } else {
    await run(`UPDATE users SET name=COALESCE(NULLIF(name,''),'Administrator'), role=COALESCE(NULLIF(role,''),'admin') WHERE username='admin'`);
  }
}

/* =========================
   AUTH HELPERS
========================= */
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).send("Access denied");
  }
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.user || req.session.user.role !== "teacher") {
    return res.status(403).send("Access denied");
  }
  next();
}

function requireParent(req, res, next) {
  if (!req.session.user || req.session.user.role !== "parent") {
    return res.status(403).send("Access denied");
  }
  next();
}

/* =========================
   LOGIN
========================= */
app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  if (req.session.user.role === "admin") return res.redirect("/admin");
  if (req.session.user.role === "teacher") return res.redirect("/teacher");
  if (req.session.user.role === "parent") return res.redirect("/parent");

  res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.render("login", { error: "Username iyo password geli." });
    }

    const admin = await get(`SELECT * FROM users WHERE username = ?`, [username]);

    if (admin) {
      const ok = await bcrypt.compare(password, admin.password || "");
      if (ok) {
        req.session.user = {
          id: admin.id,
          username: admin.username,
          name: admin.name || "Administrator",
          role: "admin"
        };
        return res.redirect("/admin");
      }
    }

    const teacher = await get(
      `SELECT * FROM teachers WHERE username = ?`,
      [username]
    );

    if (teacher) {
      const ok = await bcrypt.compare(password, teacher.password || "");
      if (ok) {
        req.session.user = {
          id: teacher.id,
          teacher_id: teacher.teacher_id,
          username: teacher.username,
          name: teacher.name,
          subject: teacher.subject,
          class_name: teacher.class_name,
          role: "teacher"
        };
        return res.redirect("/teacher");
      }
    }

    const parent = await get(
      `SELECT * FROM parents WHERE username = ?`,
      [username]
    );

    if (parent) {
      const ok = await bcrypt.compare(password, parent.password || "");
      if (ok) {
        req.session.user = {
          id: parent.id,
          parent_id: parent.parent_id,
          username: parent.username,
          name: parent.name,
          phone: parent.phone,
          role: "parent"
        };
        return res.redirect("/parent");
      }
    }

    res.render("login", { error: "Username ama password waa khalad." });
  } catch (err) {
    console.error(err);
    res.status(500).send("Login error: " + err.message);
  }
});

/* =========================
   ADMIN DASHBOARD
========================= */
app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const studentsCount = (await get(`SELECT COUNT(*) AS c FROM students`)).c;
    const teachersCount = (await get(`SELECT COUNT(*) AS c FROM teachers`)).c;
    const parentsCount = (await get(`SELECT COUNT(*) AS c FROM parents`)).c;
    const classesCount = (await get(`SELECT COUNT(*) AS c FROM classes`)).c;

    res.render("admin", {
      user: req.session.user,
      studentsCount,
      teachersCount,
      parentsCount,
      classesCount
    });
  } catch (err) {
    res.status(500).send("Admin error: " + err.message);
  }
});

/* =========================
   STUDENTS
========================= */
app.get("/students", requireAdmin, async (req, res) => {
  try {
    const students = await all(`SELECT * FROM students ORDER BY name ASC`);
    res.render("students", { user: req.session.user, students });
  } catch (err) {
    res.status(500).send("Students error: " + err.message);
  }
});

app.post("/students/add", requireAdmin, async (req, res) => {
  try {
    const {
      student_id,
      name,
      gender,
      dob,
      class_name,
      parent_name,
      parent_phone,
      address,
      username,
      password
    } = req.body;

    let parent = null;
    if (parent_phone) {
      parent = await get(`SELECT * FROM parents WHERE phone = ?`, [
        parent_phone
      ]);
    }

    let parentUsername = username || "";
    let parentPassword = password || "";

    if (parent && parent.username) {
      parentUsername = parent.username;
    }

    if (parent && parent.password) {
      parentPassword = "";
    }

    await run(
      `INSERT INTO students
       (student_id,name,gender,dob,class_name,parent_name,parent_phone,address,username,password)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        student_id,
        name,
        gender,
        dob,
        class_name,
        parent_name,
        parent_phone,
        address,
        parentUsername,
        parentPassword
      ]
    );

    res.redirect("/students");
  } catch (err) {
    res.status(500).send("Student add error: " + err.message);
  }
});

app.get("/students/edit/:id", requireAdmin, async (req, res) => {
  try {
    const student = await get(`SELECT * FROM students WHERE id = ?`, [
      req.params.id
    ]);
    if (!student) return res.status(404).send("Student not found");
    res.render("edit-student", { user: req.session.user, student });
  } catch (err) {
    res.status(500).send("Student edit error: " + err.message);
  }
});

app.post("/students/edit/:id", requireAdmin, async (req, res) => {
  try {
    const {
      student_id,
      name,
      gender,
      dob,
      class_name,
      parent_name,
      parent_phone,
      address,
      username,
      password
    } = req.body;

    await run(
      `UPDATE students SET
       student_id=?, name=?, gender=?, dob=?, class_name=?,
       parent_name=?, parent_phone=?, address=?, username=?,
       password=CASE WHEN ? <> '' THEN ? ELSE password END
       WHERE id=?`,
      [
        student_id,
        name,
        gender,
        dob,
        class_name,
        parent_name,
        parent_phone,
        address,
        username,
        password || "",
        password || "",
        req.params.id
      ]
    );

    res.redirect("/students");
  } catch (err) {
    res.status(500).send("Student update error: " + err.message);
  }
});

app.get("/students/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM students WHERE id = ?`, [req.params.id]);
    res.redirect("/students");
  } catch (err) {
    res.status(500).send("Student delete error: " + err.message);
  }
});

/* =========================
   PARENTS
========================= */
app.get("/parents", requireAdmin, async (req, res) => {
  try {
    const parents = await all(`SELECT * FROM parents ORDER BY name ASC`);
    res.render("parents", { user: req.session.user, parents });
  } catch (err) {
    res.status(500).send("Parents error: " + err.message);
  }
});

app.post("/parents/add", requireAdmin, async (req, res) => {
  try {
    const { parent_id, name, phone, username, password } = req.body;
    const hash = await bcrypt.hash(password || "Parent@123", 10);

    await run(
      `INSERT INTO parents (parent_id,name,phone,username,password)
       VALUES (?,?,?,?,?)`,
      [parent_id, name, phone, username, hash]
    );

    res.redirect("/parents");
  } catch (err) {
    res.status(500).send("Parent add error: " + err.message);
  }
});

app.get("/parents/edit/:id", requireAdmin, async (req, res) => {
  try {
    const parent = await get(`SELECT * FROM parents WHERE id = ?`, [
      req.params.id
    ]);
    if (!parent) return res.status(404).send("Parent not found");
    res.render("edit-parent", { user: req.session.user, parent });
  } catch (err) {
    res.status(500).send("Parent edit error: " + err.message);
  }
});

app.post("/parents/edit/:id", requireAdmin, async (req, res) => {
  try {
    const { parent_id, name, phone, username, password } = req.body;

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await run(
        `UPDATE parents SET parent_id=?,name=?,phone=?,username=?,password=? WHERE id=?`,
        [parent_id, name, phone, username, hash, req.params.id]
      );
    } else {
      await run(
        `UPDATE parents SET parent_id=?,name=?,phone=?,username=? WHERE id=?`,
        [parent_id, name, phone, username, req.params.id]
      );
    }

    res.redirect("/parents");
  } catch (err) {
    res.status(500).send("Parent update error: " + err.message);
  }
});

app.get("/parents/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM parents WHERE id = ?`, [req.params.id]);
    res.redirect("/parents");
  } catch (err) {
    res.status(500).send("Parent delete error: " + err.message);
  }
});

/* =========================
   TEACHERS
========================= */
app.get("/teachers", requireAdmin, async (req, res) => {
  try {
    const teachers = await all(`SELECT * FROM teachers ORDER BY name ASC`);
    res.render("teachers", { user: req.session.user, teachers });
  } catch (err) {
    res.status(500).send("Teachers error: " + err.message);
  }
});

app.post("/teachers/add", requireAdmin, async (req, res) => {
  try {
    const { teacher_id, name, subject, class_name, username, password } = req.body;
    const hash = await bcrypt.hash(password || "Teacher@123", 10);

    await run(
      `INSERT INTO teachers
       (teacher_id,name,subject,class_name,username,password)
       VALUES (?,?,?,?,?,?)`,
      [teacher_id, name, subject, class_name, username, hash]
    );

    res.redirect("/teachers");
  } catch (err) {
    res.status(500).send("Teacher add error: " + err.message);
  }
});

app.get("/teachers/edit/:id", requireAdmin, async (req, res) => {
  try {
    const teacher = await get(`SELECT * FROM teachers WHERE id = ?`, [
      req.params.id
    ]);
    if (!teacher) return res.status(404).send("Teacher not found");
    res.render("edit-teacher", { user: req.session.user, teacher });
  } catch (err) {
    res.status(500).send("Teacher edit error: " + err.message);
  }
});

app.post("/teachers/edit/:id", requireAdmin, async (req, res) => {
  try {
    const { teacher_id, name, subject, class_name, username, password } = req.body;

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await run(
        `UPDATE teachers
         SET teacher_id=?,name=?,subject=?,class_name=?,username=?,password=?
         WHERE id=?`,
        [
          teacher_id,
          name,
          subject,
          class_name,
          username,
          hash,
          req.params.id
        ]
      );
    } else {
      await run(
        `UPDATE teachers
         SET teacher_id=?,name=?,subject=?,class_name=?,username=?
         WHERE id=?`,
        [teacher_id, name, subject, class_name, username, req.params.id]
      );
    }

    res.redirect("/teachers");
  } catch (err) {
    res.status(500).send("Teacher update error: " + err.message);
  }
});

app.get("/teachers/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM teachers WHERE id = ?`, [req.params.id]);
    res.redirect("/teachers");
  } catch (err) {
    res.status(500).send("Teacher delete error: " + err.message);
  }
});

/* =========================
   CLASSES
========================= */
app.get("/classes", requireAdmin, async (req, res) => {
  try {
    const classes = await all(`SELECT * FROM classes ORDER BY name ASC`);
    res.render("classes", { user: req.session.user, classes });
  } catch (err) {
    res.status(500).send("Classes error: " + err.message);
  }
});

app.post("/classes/add", requireAdmin, async (req, res) => {
  try {
    const class_id = req.body.class_id || req.body.id || "";
    const name = req.body.name || req.body.class_name || "";
    const type = req.body.type || "";
    const section = req.body.section || "";
    const teacher_name = req.body.teacher_name || "";
    const academic_year = req.body.academic_year || "";
    const room = req.body.room || req.body.classroom || "";

    const finalClassId =
      String(class_id).trim() || `CLS-${Date.now()}`;

    if (!String(name).trim()) {
      return res.status(400).send("Fadlan geli magaca fasalka.");
    }

    await run(
      `INSERT INTO classes
       (class_id,name,type,section,teacher_name,academic_year,room)
       VALUES (?,?,?,?,?,?,?)`,
      [
        finalClassId,
        name,
        type,
        section,
        teacher_name,
        academic_year,
        room
      ]
    );

    res.redirect("/classes");
  } catch (err) {
    res.status(500).send("Class add error: " + err.message);
  }
});

app.get("/classes/edit/:id", requireAdmin, async (req, res) => {
  try {
    const classRow = await get(`SELECT * FROM classes WHERE id = ?`, [
      req.params.id
    ]);
    if (!classRow) return res.status(404).send("Class not found");
    res.render("edit-class", { user: req.session.user, classRow });
  } catch (err) {
    res.status(500).send("Class edit error: " + err.message);
  }
});

app.post("/classes/edit/:id", requireAdmin, async (req, res) => {
  try {
    const {
      class_id,
      name,
      type,
      section,
      teacher_name,
      academic_year,
      room
    } = req.body;

    await run(
      `UPDATE classes SET
       class_id=?,name=?,type=?,section=?,teacher_name=?,academic_year=?,room=?
       WHERE id=?`,
      [
        class_id,
        name,
        type,
        section,
        teacher_name,
        academic_year,
        room,
        req.params.id
      ]
    );

    res.redirect("/classes");
  } catch (err) {
    res.status(500).send("Class update error: " + err.message);
  }
});

app.get("/classes/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM classes WHERE id = ?`, [req.params.id]);
    res.redirect("/classes");
  } catch (err) {
    res.status(500).send("Class delete error: " + err.message);
  }
});

/* =========================
   SUBJECTS
========================= */
app.get("/subjects", requireAdmin, async (req, res) => {
  try {
    const subjects = await all(`SELECT * FROM subjects ORDER BY name ASC`);
    res.render("subjects", { user: req.session.user, subjects });
  } catch (err) {
    res.status(500).send("Subjects error: " + err.message);
  }
});

app.post("/subjects/add", requireAdmin, async (req, res) => {
  try {
    const { subject_id, name, class_name, teacher_name } = req.body;

    await run(
      `INSERT INTO subjects (subject_id,name,class_name,teacher_name)
       VALUES (?,?,?,?)`,
      [subject_id, name, class_name, teacher_name]
    );

    res.redirect("/subjects");
  } catch (err) {
    res.status(500).send("Subject add error: " + err.message);
  }
});

app.get("/subjects/edit/:id", requireAdmin, async (req, res) => {
  try {
    const subject = await get(`SELECT * FROM subjects WHERE id = ?`, [
      req.params.id
    ]);
    if (!subject) return res.status(404).send("Subject not found");
    res.render("edit-subject", { user: req.session.user, subject });
  } catch (err) {
    res.status(500).send("Subject edit error: " + err.message);
  }
});

app.post("/subjects/edit/:id", requireAdmin, async (req, res) => {
  try {
    const { subject_id, name, class_name, teacher_name } = req.body;

    await run(
      `UPDATE subjects
       SET subject_id=?,name=?,class_name=?,teacher_name=?
       WHERE id=?`,
      [subject_id, name, class_name, teacher_name, req.params.id]
    );

    res.redirect("/subjects");
  } catch (err) {
    res.status(500).send("Subject update error: " + err.message);
  }
});

app.get("/subjects/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM subjects WHERE id = ?`, [req.params.id]);
    res.redirect("/subjects");
  } catch (err) {
    res.status(500).send("Subject delete error: " + err.message);
  }
});

/* =========================
   ADMIN ATTENDANCE
   Filters + statistics + edit/delete
========================= */
app.get("/attendance", requireAdmin, async (req, res) => {
  try {
    const {
      class_name = "",
      subject_name = "",
      teacher_name = "",
      attendance_date = "",
      status = ""
    } = req.query;

    let sql = `SELECT * FROM attendance WHERE 1=1`;
    const params = [];

    if (class_name) {
      sql += ` AND LOWER(TRIM(class_name)) = LOWER(TRIM(?))`;
      params.push(class_name);
    }

    if (subject_name) {
      sql += ` AND LOWER(TRIM(subject_name)) = LOWER(TRIM(?))`;
      params.push(subject_name);
    }

    if (teacher_name) {
      sql += ` AND LOWER(TRIM(teacher_name)) = LOWER(TRIM(?))`;
      params.push(teacher_name);
    }

    if (attendance_date) {
      sql += ` AND attendance_date = ?`;
      params.push(attendance_date);
    }

    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY attendance_date DESC, id DESC`;

    const attendance = await all(sql, params);
    const classes = await all(`SELECT * FROM classes ORDER BY name ASC`);
    const subjects = await all(`SELECT * FROM subjects ORDER BY name ASC`);
    const teachers = await all(`SELECT * FROM teachers ORDER BY name ASC`);

    const totalCount = attendance.length;
    const presentCount = attendance.filter((a) => a.status === "Present").length;
    const absentCount = attendance.filter((a) => a.status === "Absent").length;
    const lateCount = attendance.filter((a) => a.status === "Late").length;

    res.render("attendance", {
      user: req.session.user,
      attendance,
      classes,
      subjects,
      teachers,
      totalCount,
      presentCount,
      absentCount,
      lateCount,
      filters: {
        class_name,
        subject_name,
        teacher_name,
        attendance_date,
        status
      }
    });
  } catch (err) {
    res.status(500).send("Attendance error: " + err.message);
  }
});

app.get("/attendance/edit/:id", requireAdmin, async (req, res) => {
  try {
    const attendance = await get(
      `SELECT * FROM attendance WHERE id = ?`,
      [req.params.id]
    );

    if (!attendance) return res.status(404).send("Attendance not found");

    res.render("edit-attendance", {
      user: req.session.user,
      attendance
    });
  } catch (err) {
    res.status(500).send("Attendance edit error: " + err.message);
  }
});

app.post("/attendance/edit/:id", requireAdmin, async (req, res) => {
  try {
    const {
      student_id,
      student_name,
      class_name,
      subject_name,
      teacher_name,
      attendance_date,
      session,
      status
    } = req.body;

    if (!["Present", "Absent", "Late"].includes(status)) {
      return res.status(400).send("Invalid attendance status");
    }

    await run(
      `UPDATE attendance SET
       student_id=?,student_name=?,class_name=?,subject_name=?,
       teacher_name=?,attendance_date=?,session=?,status=?
       WHERE id=?`,
      [
        student_id,
        student_name,
        class_name,
        subject_name,
        teacher_name,
        attendance_date,
        session,
        status,
        req.params.id
      ]
    );

    res.redirect("/attendance");
  } catch (err) {
    res.status(500).send("Attendance update error: " + err.message);
  }
});

app.get("/attendance/delete/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM attendance WHERE id = ?`, [req.params.id]);
    res.redirect("/attendance");
  } catch (err) {
    res.status(500).send("Attendance delete error: " + err.message);
  }
});

/* =========================
   TEACHER DASHBOARD
========================= */
app.get("/teacher", requireTeacher, async (req, res) => {
  try {
    res.render("teacher", {
      user: req.session.user
    });
  } catch (err) {
    res.status(500).send("Teacher dashboard error: " + err.message);
  }
});

/* =========================
   TEACHER ATTENDANCE
   IMPORTANT:
   One attendance per student + subject + date + session.
========================= */
app.get("/teacher/attendance", requireTeacher, async (req, res) => {
  try {
    const user = req.session.user;

    const students = await all(
      `SELECT * FROM students
       WHERE LOWER(TRIM(class_name)) = LOWER(TRIM(?))
       ORDER BY name ASC`,
      [user.class_name]
    );

    res.render("teacher-attendance", {
      user,
      students
    });
  } catch (err) {
    res.status(500).send("Teacher attendance error: " + err.message);
  }
});

app.post("/teacher/attendance/save", requireTeacher, async (req, res) => {
  try {
    const user = req.session.user;

    const attendanceDate = String(req.body.attendance_date || "").trim();
    const sessionName = String(req.body.session || "Morning").trim();
    let studentIds = req.body.student_ids || [];

    if (!Array.isArray(studentIds)) {
      studentIds = [studentIds];
    }

    if (!attendanceDate) {
      return res.status(400).send("Fadlan dooro taariikhda.");
    }

    if (!["Morning", "Afternoon"].includes(sessionName)) {
      return res.status(400).send("Session-ku waa inuu noqdaa Morning ama Afternoon.");
    }

    if (studentIds.length === 0) {
      return res.status(400).send("Arday lama helin.");
    }

    /*
      LOCKING RULE:
      The same student cannot be marked again for the same:
      - date
      - subject
      - session

      If any record already exists, the whole submission is rejected.
      Admin can still edit/delete the record from Admin > Attendance.
    */
    for (const studentId of studentIds) {
      const existing = await get(
        `SELECT id FROM attendance
         WHERE student_id = ?
         AND LOWER(TRIM(subject_name)) = LOWER(TRIM(?))
         AND attendance_date = ?
         AND LOWER(TRIM(session)) = LOWER(TRIM(?))
         LIMIT 1`,
        [studentId, user.subject, attendanceDate, sessionName]
      );

      if (existing) {
        return res
          .status(409)
          .send(
            `Attendance-ka ${attendanceDate} ee ${user.subject} (${sessionName}) hore ayaa loo diiwaangeliyey. Mar labaad lama xaadiri karo. Admin ayaa kaliya wax ka beddeli kara.`
          );
      }
    }

    let completed = 0;

    for (const studentId of studentIds) {
      const student = await get(
        `SELECT * FROM students
         WHERE student_id = ?
         AND LOWER(TRIM(class_name)) = LOWER(TRIM(?))`,
        [studentId, user.class_name]
      );

      if (!student) continue;

      const status = String(
        (req.body.statuses && req.body.statuses[studentId]) || ""
      ).trim();

      if (!["Present", "Absent", "Late"].includes(status)) {
        continue;
      }

      await run(
        `INSERT INTO attendance
         (student_id,student_name,class_name,subject_name,teacher_name,
          attendance_date,session,status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          student.student_id,
          student.name,
          student.class_name,
          user.subject,
          user.name,
          attendanceDate,
          sessionName,
          status
        ]
      );

      completed++;
    }

    if (completed === 0) {
      return res.status(400).send("Wax attendance ah lama keydin.");
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="2;url=/teacher/attendance">
        <title>Attendance Saved</title>
        <style>
          body{font-family:Arial;text-align:center;padding:70px;background:#f5f7fb}
          .box{max-width:600px;margin:auto;background:white;padding:35px;border-radius:15px;box-shadow:0 5px 20px #ddd}
          h2{color:#16834b}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>Attendance waa la keydiyey.</h2>
          <p>Arday kasta hal mar ayaa loo diiwaangeliyey.</p>
          <p>2 ilbiriqsi kadib waad ku laabanaysaa.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Teacher attendance save error:", err);
    res.status(500).send("Attendance save error: " + err.message);
  }
});

/* Teacher attendance history */
app.get("/teacher/attendance/history", requireTeacher, async (req, res) => {
  try {
    const attendance = await all(
      `SELECT * FROM attendance
       WHERE LOWER(TRIM(teacher_name)) = LOWER(TRIM(?))
       ORDER BY attendance_date DESC, id DESC`,
      [req.session.user.name]
    );

    res.render("teacher-attendance-history", {
      user: req.session.user,
      attendance
    });
  } catch (err) {
    res.status(500).send("Teacher history error: " + err.message);
  }
});

/* =========================
   PARENT DASHBOARD
========================= */
app.get("/parent", requireParent, async (req, res) => {
  try {
    const user = req.session.user;

    const students = await all(
      `SELECT * FROM students
       WHERE LOWER(TRIM(parent_name)) = LOWER(TRIM(?))
          OR (
            parent_phone IS NOT NULL
            AND TRIM(parent_phone) <> ''
            AND parent_phone = ?
          )
       ORDER BY name ASC`,
      [user.name, user.phone || ""]
    );

    res.render("parent", {
      user,
      students
    });
  } catch (err) {
    res.status(500).send("Parent dashboard error: " + err.message);
  }
});

/* =========================
   PARENT ATTENDANCE
========================= */
app.get("/parent/attendance", requireParent, async (req, res) => {
  try {
    const user = req.session.user;

    const students = await all(
      `SELECT * FROM students
       WHERE LOWER(TRIM(parent_name)) = LOWER(TRIM(?))
          OR (
            parent_phone IS NOT NULL
            AND TRIM(parent_phone) <> ''
            AND parent_phone = ?
          )
       ORDER BY name ASC`,
      [user.name, user.phone || ""]
    );

    res.render("parent-attendance", {
      user,
      students,
      attendance: [],
      student: null,
      presentCount: 0,
      absentCount: 0,
      lateCount: 0,
      totalCount: 0,
      attendancePercentage: 0
    });
  } catch (err) {
    res.status(500).send("Parent attendance error: " + err.message);
  }
});

app.get("/parent/attendance/:student_id", requireParent, async (req, res) => {
  try {
    const user = req.session.user;

    const student = await get(
      `SELECT * FROM students
       WHERE student_id = ?
       AND (
         LOWER(TRIM(parent_name)) = LOWER(TRIM(?))
         OR (
           parent_phone IS NOT NULL
           AND TRIM(parent_phone) <> ''
           AND parent_phone = ?
         )
       )`,
      [req.params.student_id, user.name, user.phone || ""]
    );

    if (!student) {
      return res.status(403).send("Ardaygan ma aha ilmahaaga.");
    }

    const attendance = await all(
      `SELECT * FROM attendance
       WHERE student_id = ?
       ORDER BY attendance_date DESC, id DESC`,
      [student.student_id]
    );

    const totalCount = attendance.length;
    const presentCount = attendance.filter((a) => a.status === "Present").length;
    const absentCount = attendance.filter((a) => a.status === "Absent").length;
    const lateCount = attendance.filter((a) => a.status === "Late").length;

    const attendancePercentage =
      totalCount > 0 ? (presentCount / totalCount) * 100 : 0;

    res.render("parent-attendance", {
      user,
      student,
      attendance,
      presentCount,
      absentCount,
      lateCount,
      totalCount,
      attendancePercentage
    });
  } catch (err) {
    res.status(500).send("Parent child attendance error: " + err.message);
  }
});

/* =========================================================
   BARAKAD 35-MODULE EXTENSION
   One-file backend foundation. Uses existing SQLite DB.
   No existing data is deleted.
========================================================= */

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title, body, user) {
  const nav = user ? `<div style="margin-bottom:18px"><a href="/admin">Admin</a> | <a href="/all-modules">35 Modules</a> | <a href="/logout">Logout</a></div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>body{font-family:Arial;background:#f4f6f8;margin:0;padding:20px;color:#222}.box{max-width:1100px;margin:auto;background:#fff;padding:22px;border-radius:14px;box-shadow:0 3px 15px #ddd}h1,h2{margin-top:0}a{color:#075fc8;text-decoration:none}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #ddd;padding:9px;text-align:left}th{background:#eef3f8}input,select,textarea{padding:9px;width:100%;box-sizing:border-box;margin:4px 0 10px;border:1px solid #ccc;border-radius:6px}button{padding:9px 14px;border:0;border-radius:7px;background:#1266d6;color:white;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:#f7f9fc;padding:15px;border-radius:10px;border:1px solid #e2e6eb}.muted{color:#666}</style></head><body><div class="box">${nav}${body}</div></body></html>`;
}

async function safeCreate(sql) { try { await run(sql); } catch (e) { console.error("Module table error:", e.message); } }

async function setup35Modules() {
  await safeCreate(`CREATE TABLE IF NOT EXISTS salaries (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT, employee_name TEXT NOT NULL, employee_type TEXT DEFAULT 'Teacher', salary_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0, month TEXT, year TEXT, payment_date TEXT, status TEXT DEFAULT 'Unpaid', notes TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await safeCreate(`CREATE TABLE IF NOT EXISTS salary_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, salary_id INTEGER, employee_id TEXT, employee_name TEXT, amount REAL DEFAULT 0, method TEXT DEFAULT 'Cash', reference TEXT, payment_date TEXT, status TEXT DEFAULT 'Approved', approved_at TEXT, approved_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const tables = [
    `CREATE TABLE IF NOT EXISTS academic_years (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, start_date TEXT, end_date TEXT, active INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS calendar_events (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, event_date TEXT, description TEXT, type TEXT)`,
    `CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, location TEXT, phone TEXT, active INTEGER DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS sections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, branch TEXT, description TEXT)`,
    `CREATE TABLE IF NOT EXISTS timetables (id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT, day TEXT, period TEXT, subject_name TEXT, teacher_name TEXT, room TEXT)`,
    `CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT, subject_name TEXT, teacher_name TEXT, title TEXT, description TEXT, due_date TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS assignment_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER, student_id TEXT, answer TEXT, submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP, grade REAL)`,
    `CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, message TEXT, audience TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, subject TEXT, message TEXT, read_status INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS app_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, role TEXT, display_name TEXT, phone TEXT, active INTEGER DEFAULT 1, password_hash TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, module_name TEXT, can_view INTEGER DEFAULT 0, can_add INTEGER DEFAULT 0, can_edit INTEGER DEFAULT 0, can_delete INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT UNIQUE, setting_value TEXT)`,
    `CREATE TABLE IF NOT EXISTS student_promotions (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, from_class TEXT, to_class TEXT, academic_year TEXT, promoted_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS student_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, card_number TEXT UNIQUE, issue_date TEXT, expiry_date TEXT, status TEXT DEFAULT 'Active')`,
    `CREATE TABLE IF NOT EXISTS teacher_ids (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id TEXT, card_number TEXT UNIQUE, issue_date TEXT, expiry_date TEXT, status TEXT DEFAULT 'Active')`,
    `CREATE TABLE IF NOT EXISTS certificates (id INTEGER PRIMARY KEY AUTOINCREMENT, person_type TEXT, person_id TEXT, person_name TEXT, certificate_type TEXT, issue_date TEXT, notes TEXT)`,
    `CREATE TABLE IF NOT EXISTS official_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, letter_no TEXT, recipient TEXT, subject TEXT, body TEXT, issue_date TEXT, created_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS library_books (id INTEGER PRIMARY KEY AUTOINCREMENT, isbn TEXT, title TEXT, author TEXT, category TEXT, quantity INTEGER DEFAULT 1, available INTEGER DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS library_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER, borrower_id TEXT, borrower_name TEXT, issue_date TEXT, due_date TEXT, return_date TEXT, status TEXT DEFAULT 'Borrowed')`,
    `CREATE TABLE IF NOT EXISTS transport (id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_no TEXT, driver_name TEXT, route TEXT, capacity INTEGER, active INTEGER DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS transport_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, vehicle_id INTEGER, pickup_point TEXT)`,
    `CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT, category TEXT, quantity INTEGER DEFAULT 0, unit TEXT, location TEXT, min_quantity INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS parent_communications (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_phone TEXT, student_id TEXT, subject TEXT, message TEXT, status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, title TEXT, message TEXT, read_status INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, action TEXT, module_name TEXT, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS fees (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, student_name TEXT, amount REAL DEFAULT 0, paid REAL DEFAULT 0, balance REAL DEFAULT 0, fee_type TEXT, due_date TEXT, status TEXT DEFAULT 'Unpaid', paid_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS fee_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, fee_id INTEGER, student_id TEXT, amount REAL, method TEXT, reference TEXT, status TEXT DEFAULT 'Pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS salary_records (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id TEXT, employee_name TEXT, month TEXT, basic_salary REAL DEFAULT 0, allowance REAL DEFAULT 0, deduction REAL DEFAULT 0, net_salary REAL DEFAULT 0, paid_status TEXT DEFAULT 'Pending', paid_date TEXT)`,
    `CREATE TABLE IF NOT EXISTS exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, exam_date TEXT, class_name TEXT, term TEXT, academic_year TEXT)`,
    `CREATE TABLE IF NOT EXISTS exam_results (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER, student_id TEXT, student_name TEXT, subject_name TEXT, marks REAL DEFAULT 0, grade TEXT, remarks TEXT)`,
    `CREATE TABLE IF NOT EXISTS system_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, notes TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, token TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
  ];
  for (const t of tables) await safeCreate(t);

  // Compatibility columns for Exams & Results in existing BARAKAD databases.
  await addColumnIfMissing("exams", "subject_name", "TEXT");
  await addColumnIfMissing("exams", "total_marks", "REAL DEFAULT 100");
  await addColumnIfMissing("exams", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("exam_results", "percentage", "REAL DEFAULT 0");
  await addColumnIfMissing("exam_results", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("app_users", "phone", "TEXT");
  await addColumnIfMissing("app_users", "password_hash", "TEXT");
  await addColumnIfMissing("app_users", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("notifications", "link", "TEXT");
  await addColumnIfMissing("fees", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("fees", "notes", "TEXT");
  await addColumnIfMissing("fees", "academic_year", "TEXT");
  await addColumnIfMissing("fees", "month", "TEXT");
  await addColumnIfMissing("fees", "created_by", "TEXT");
  await addColumnIfMissing("fee_payments", "approved_at", "TEXT");
  await addColumnIfMissing("fee_payments", "approved_by", "TEXT");
  await addColumnIfMissing("fee_payments", "payment_date", "TEXT");
}

async function log35(req, action, moduleName, details = "") {
  try { await run(`INSERT INTO audit_logs (username,action,module_name,details) VALUES (?,?,?,?)`, [req.session.user?.username || req.session.user?.name || "system", action, moduleName, details]); } catch (_) {}
}

function simpleAdmin(req, res, next) { return requireAdmin(req, res, next); }

/* 1. TIMETABLE */
app.get("/timetable", simpleAdmin, async (req,res)=>{ const rows=await all(`SELECT * FROM timetables ORDER BY day,period`); res.send(page("Timetable",`<h1>1. Timetable</h1><form method="post" action="/timetable/add"><div class="grid"><input name="class_name" placeholder="Class" required><input name="day" placeholder="Day" required><input name="period" placeholder="Period" required><input name="subject_name" placeholder="Subject" required><input name="teacher_name" placeholder="Teacher"><input name="room" placeholder="Room"></div><button>Add</button></form><table><tr><th>Class</th><th>Day</th><th>Period</th><th>Subject</th><th>Teacher</th><th>Room</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.class_name)}</td><td>${escHtml(x.day)}</td><td>${escHtml(x.period)}</td><td>${escHtml(x.subject_name)}</td><td>${escHtml(x.teacher_name)}</td><td>${escHtml(x.room)}</td></tr>`).join("")}</table>`,req.session.user)); });
app.post("/timetable/add",simpleAdmin,async(req,res)=>{await run(`INSERT INTO timetables(class_name,day,period,subject_name,teacher_name,room) VALUES(?,?,?,?,?,?)`,[req.body.class_name,req.body.day,req.body.period,req.body.subject_name,req.body.teacher_name,req.body.room]);await log35(req,"add","Timetable",req.body.subject_name);res.redirect("/timetable")});

/* 2. ASSIGNMENTS */
app.get("/assignments",requireLogin,async(req,res)=>{const rows=await all(`SELECT * FROM assignments ORDER BY id DESC`);let form=req.session.user.role==="admin"?`<form method="post" action="/assignments/add"><input name="class_name" placeholder="Class" required><input name="subject_name" placeholder="Subject" required><input name="title" placeholder="Title" required><textarea name="description" placeholder="Description"></textarea><input type="date" name="due_date"><button>Add Assignment</button></form>`:"";res.send(page("Assignments",`<h1>2. Assignments</h1>${form}<table><tr><th>Title</th><th>Class</th><th>Subject</th><th>Due</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.title)}</td><td>${escHtml(x.class_name)}</td><td>${escHtml(x.subject_name)}</td><td>${escHtml(x.due_date)}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/assignments/add",simpleAdmin,async(req,res)=>{await run(`INSERT INTO assignments(class_name,subject_name,teacher_name,title,description,due_date) VALUES(?,?,?,?,?,?)`,[req.body.class_name,req.body.subject_name,req.session.user.name||"admin",req.body.title,req.body.description,req.body.due_date]);await log35(req,"add","Assignments",req.body.title);res.redirect("/assignments")});

app.get("/assignments/edit/:id",simpleAdmin,async(req,res)=>{
  const a=await get(`SELECT * FROM assignments WHERE id=?`,[req.params.id]);
  if(!a)return res.status(404).send("Assignment not found");
  res.send(page("Edit Assignment",`<h1>Edit Assignment</h1><form method="post" action="/assignments/edit/${a.id}"><input name="class_name" value="${escHtml(a.class_name)}" required><input name="subject_name" value="${escHtml(a.subject_name)}" required><input name="title" value="${escHtml(a.title)}" required><textarea name="description">${escHtml(a.description)}</textarea><input type="date" name="due_date" value="${escHtml(a.due_date)}"><button>Save</button></form>`,req.session.user));
});
app.post("/assignments/edit/:id",simpleAdmin,async(req,res)=>{await run(`UPDATE assignments SET class_name=?,subject_name=?,title=?,description=?,due_date=? WHERE id=?`,[req.body.class_name,req.body.subject_name,req.body.title,req.body.description,req.body.due_date,req.params.id]);res.redirect("/assignments")});
app.get("/assignments/delete/:id",simpleAdmin,async(req,res)=>{await run(`DELETE FROM assignment_submissions WHERE assignment_id=?`,[req.params.id]);await run(`DELETE FROM assignments WHERE id=?`,[req.params.id]);res.redirect("/assignments")});

/* 2B. EXAMS */
function examGrade(percent){
  const p=Number(percent||0);
  if(p>=90)return "A";
  if(p>=80)return "B";
  if(p>=70)return "C";
  if(p>=60)return "D";
  if(p>=50)return "E";
  return "F";
}
function examRemark(percent){return Number(percent||0)>=50?"Pass":"Fail";}

app.get("/exams",simpleAdmin,async(req,res)=>{
  const exams=await all(`SELECT * FROM exams ORDER BY exam_date DESC,id DESC`);
  const classes=await all(`SELECT name FROM classes ORDER BY name`);
  const subjects=await all(`SELECT DISTINCT name FROM subjects WHERE name IS NOT NULL AND TRIM(name)<>'' ORDER BY name`);
  const classOptions=classes.map(x=>`<option value="${escHtml(x.name)}"></option>`).join("");
  const subjectOptions=subjects.map(x=>`<option value="${escHtml(x.name)}"></option>`).join("");
  const rows=exams.map(x=>`<tr><td>${x.id}</td><td>${escHtml(x.title)}</td><td>${escHtml(x.subject_name)}</td><td>${escHtml(x.class_name)}</td><td>${escHtml(x.term)}</td><td>${escHtml(x.exam_date)}</td><td>${x.total_marks}</td><td><a href="/exams/edit/${x.id}">Edit</a> | <a href="/exams/delete/${x.id}" onclick="return confirm('Delete exam and its results?')">Delete</a> | <a href="/results?exam_id=${x.id}">Results</a></td></tr>`).join("");
  res.send(page("Exams",`<h1>Exams Management</h1><form method="post" action="/exams/add"><div class="grid"><input name="title" placeholder="Exam name" required><input name="subject_name" list="subjects" placeholder="Subject" required><datalist id="subjects">${subjectOptions}</datalist><input name="class_name" list="classes" placeholder="Class" required><datalist id="classes">${classOptions}</datalist><input name="term" placeholder="Term"><input type="text" name="academic_year" placeholder="Academic Year"><input type="date" name="exam_date" required><input type="number" step="0.01" min="1" name="total_marks" value="100" required></div><button>Add Exam</button></form><table><tr><th>ID</th><th>Exam</th><th>Subject</th><th>Class</th><th>Term</th><th>Date</th><th>Total</th><th>Actions</th></tr>${rows}</table>`,req.session.user));
});
app.post("/exams/add",simpleAdmin,async(req,res)=>{const total=Math.max(1,Number(req.body.total_marks||100));await run(`INSERT INTO exams(title,subject_name,exam_date,class_name,term,academic_year,total_marks) VALUES(?,?,?,?,?,?,?)`,[req.body.title,req.body.subject_name,req.body.exam_date,req.body.class_name,req.body.term,req.body.academic_year,total]);await log35(req,"add","Exams",req.body.title);res.redirect("/exams")});
app.get("/exams/edit/:id",simpleAdmin,async(req,res)=>{const x=await get(`SELECT * FROM exams WHERE id=?`,[req.params.id]);if(!x)return res.status(404).send("Exam not found");res.send(page("Edit Exam",`<h1>Edit Exam</h1><form method="post" action="/exams/edit/${x.id}"><input name="title" value="${escHtml(x.title)}" required><input name="subject_name" value="${escHtml(x.subject_name)}" required><input name="class_name" value="${escHtml(x.class_name)}" required><input name="term" value="${escHtml(x.term)}"><input name="academic_year" value="${escHtml(x.academic_year)}"><input type="date" name="exam_date" value="${escHtml(x.exam_date)}"><input type="number" step="0.01" min="1" name="total_marks" value="${x.total_marks||100}" required><button>Save</button></form>`,req.session.user))});
app.post("/exams/edit/:id",simpleAdmin,async(req,res)=>{const total=Math.max(1,Number(req.body.total_marks||100));await run(`UPDATE exams SET title=?,subject_name=?,exam_date=?,class_name=?,term=?,academic_year=?,total_marks=? WHERE id=?`,[req.body.title,req.body.subject_name,req.body.exam_date,req.body.class_name,req.body.term,req.body.academic_year,total,req.params.id]);res.redirect("/exams")});
app.get("/exams/delete/:id",simpleAdmin,async(req,res)=>{await run(`DELETE FROM exam_results WHERE exam_id=?`,[req.params.id]);await run(`DELETE FROM exams WHERE id=?`,[req.params.id]);res.redirect("/exams")});

/* 2C. RESULTS */
app.get("/results",simpleAdmin,async(req,res)=>{
  const examId=String(req.query.exam_id||"").trim();
  const exams=await all(`SELECT * FROM exams ORDER BY exam_date DESC,id DESC`);
  const students=await all(`SELECT student_id,name,class_name FROM students ORDER BY name`);
  const where=examId?`WHERE r.exam_id=?`:``;
  const params=examId?[examId]:[];
  const results=await all(`SELECT r.*,e.title exam_title,e.class_name,e.subject_name exam_subject,e.total_marks FROM exam_results r LEFT JOIN exams e ON e.id=r.exam_id ${where} ORDER BY e.exam_date DESC,r.marks DESC,r.student_name ASC`,params);
  const examOptions=exams.map(e=>`<option value="${e.id}" ${String(e.id)===examId?"selected":""}>${escHtml(e.title)} — ${escHtml(e.class_name)} — ${escHtml(e.subject_name)} (${e.total_marks||100})</option>`).join("");
  const studentOptions=students.map(s=>`<option value="${escHtml(s.student_id)}" data-name="${escHtml(s.name)}">${escHtml(s.name)} — ${escHtml(s.student_id)} — ${escHtml(s.class_name)}</option>`).join("");
  const rows=results.map((r,i)=>`<tr><td>${i+1}</td><td>${escHtml(r.exam_title)}</td><td>${escHtml(r.student_name)}</td><td>${escHtml(r.student_id)}</td><td>${escHtml(r.exam_subject||r.subject_name)}</td><td>${r.marks}</td><td>${r.total_marks||100}</td><td>${Number(r.percentage||0).toFixed(1)}%</td><td>${escHtml(r.grade)}</td><td>${escHtml(r.remarks)}</td><td><a href="/results/edit/${r.id}">Edit</a> | <a href="/results/delete/${r.id}" onclick="return confirm('Delete result?')">Delete</a></td></tr>`).join("");
  res.send(page("Results",`<h1>Results Management</h1><form method="get"><select name="exam_id"><option value="">All Exams</option>${examOptions}</select><button>Filter</button></form><form method="post" action="/results/add"><div class="grid"><select name="exam_id" required><option value="">Select Exam</option>${examOptions}</select><select name="student_id" required onchange="this.form.student_name.value=this.options[this.selectedIndex].dataset.name||''"><option value="">Select Student</option>${studentOptions}</select><input type="hidden" name="student_name"><input type="number" step="0.01" name="marks" placeholder="Marks" required><input name="remarks" placeholder="Remarks"></div><button>Add Result</button></form><p><a href="/results/report${examId?`?exam_id=${encodeURIComponent(examId)}`:""}">View Result Report</a> | <a href="/reports/results.csv">Export CSV</a></p><table><tr><th>#</th><th>Exam</th><th>Student</th><th>ID</th><th>Subject</th><th>Marks</th><th>Total</th><th>%</th><th>Grade</th><th>Remarks</th><th>Actions</th></tr>${rows}</table>`,req.session.user));
});
app.post("/results/add",simpleAdmin,async(req,res)=>{const exam=await get(`SELECT * FROM exams WHERE id=?`,[req.body.exam_id]);if(!exam)return res.status(400).send("Exam not found");const student=await get(`SELECT * FROM students WHERE student_id=?`,[req.body.student_id]);if(!student)return res.status(400).send("Student not found");if(exam.class_name&&student.class_name&&String(exam.class_name).trim().toLowerCase()!==String(student.class_name).trim().toLowerCase())return res.status(400).send("Student-ka fasalkiisu ma waafaqsana exam-ka.");const total=Number(exam.total_marks||100);const marks=Number(req.body.marks||0);if(marks<0||marks>total)return res.status(400).send(`Marks-ku waa inuu u dhexeeyaa 0 iyo ${total}.`);const pct=total?marks/total*100:0;const grade=examGrade(pct);const remarks=req.body.remarks||examRemark(pct);const exists=await get(`SELECT id FROM exam_results WHERE exam_id=? AND student_id=?`,[exam.id,student.student_id]);if(exists)return res.status(409).send("Result-kan ardayga hore ayaa loogu diiwaangeliyey exam-kan.");await run(`INSERT INTO exam_results(exam_id,student_id,student_name,subject_name,marks,grade,remarks,percentage) VALUES(?,?,?,?,?,?,?,?)`,[exam.id,student.student_id,student.name,exam.subject_name||"",marks,grade,remarks,pct]);res.redirect(`/results?exam_id=${exam.id}`)});
app.get("/results/edit/:id",simpleAdmin,async(req,res)=>{const r=await get(`SELECT r.*,e.title exam_title,e.total_marks,e.class_name,e.subject_name FROM exam_results r LEFT JOIN exams e ON e.id=r.exam_id WHERE r.id=?`,[req.params.id]);if(!r)return res.status(404).send("Result not found");res.send(page("Edit Result",`<h1>Edit Result</h1><p><b>Exam:</b> ${escHtml(r.exam_title)} | <b>Student:</b> ${escHtml(r.student_name)} | <b>Subject:</b> ${escHtml(r.subject_name)}</p><form method="post" action="/results/edit/${r.id}"><input type="number" step="0.01" min="0" max="${r.total_marks||100}" name="marks" value="${r.marks}" required><input name="remarks" value="${escHtml(r.remarks)}" placeholder="Remarks"><button>Save Result</button></form>`,req.session.user))});
app.post("/results/edit/:id",simpleAdmin,async(req,res)=>{const r=await get(`SELECT r.*,e.total_marks FROM exam_results r LEFT JOIN exams e ON e.id=r.exam_id WHERE r.id=?`,[req.params.id]);if(!r)return res.status(404).send("Result not found");const total=Number(r.total_marks||100),marks=Number(req.body.marks||0);if(marks<0||marks>total)return res.status(400).send(`Marks-ku waa inuu u dhexeeyaa 0 iyo ${total}.`);const pct=total?marks/total*100:0;await run(`UPDATE exam_results SET marks=?,percentage=?,grade=?,remarks=? WHERE id=?`,[marks,pct,examGrade(pct),req.body.remarks||examRemark(pct),req.params.id]);res.redirect(`/results?exam_id=${r.exam_id}`)});
app.get("/results/delete/:id",simpleAdmin,async(req,res)=>{const r=await get(`SELECT exam_id FROM exam_results WHERE id=?`,[req.params.id]);await run(`DELETE FROM exam_results WHERE id=?`,[req.params.id]);res.redirect(r?`/results?exam_id=${r.exam_id}`:"/results")});
app.get("/results/report",simpleAdmin,async(req,res)=>{const examId=String(req.query.exam_id||"").trim();if(!examId)return res.redirect("/results");const exam=await get(`SELECT * FROM exams WHERE id=?`,[examId]);if(!exam)return res.status(404).send("Exam not found");const rows=await all(`SELECT * FROM exam_results WHERE exam_id=? ORDER BY marks DESC,student_name ASC`,[examId]);const body=`<h1>Result Report</h1><p><b>Exam:</b> ${escHtml(exam.title)} | <b>Subject:</b> ${escHtml(exam.subject_name)} | <b>Class:</b> ${escHtml(exam.class_name)} | <b>Total:</b> ${exam.total_marks||100}</p><table><tr><th>Rank</th><th>Student</th><th>ID</th><th>Marks</th><th>%</th><th>Grade</th><th>Remarks</th></tr>${rows.map((x,i)=>`<tr><td>${i+1}</td><td>${escHtml(x.student_name)}</td><td>${escHtml(x.student_id)}</td><td>${x.marks}</td><td>${Number(x.percentage||0).toFixed(1)}%</td><td>${escHtml(x.grade)}</td><td>${escHtml(x.remarks)}</td></tr>`).join("")}</table><button onclick="window.print()">Print</button>`;res.send(page("Result Report",body,req.session.user))});

/* 3. ANNOUNCEMENTS */
app.get("/announcements",requireLogin,async(req,res)=>{const rows=await all(`SELECT * FROM announcements ORDER BY id DESC`);res.send(page("Announcements",`<h1>3. Announcements</h1>${req.session.user.role==="admin"?`<form method="post" action="/announcements/add"><input name="title" placeholder="Title" required><textarea name="message" placeholder="Message" required></textarea><input name="audience" placeholder="Audience: All/Teachers/Parents/Students"><button>Publish</button></form>`:""}<div>${rows.map(x=>`<div class="card"><b>${escHtml(x.title)}</b><p>${escHtml(x.message)}</p><small>${escHtml(x.audience)} • ${escHtml(x.created_at)}</small></div>`).join("")}</div>`,req.session.user))});
app.post("/announcements/add",simpleAdmin,async(req,res)=>{await run(`INSERT INTO announcements(title,message,audience,created_by) VALUES(?,?,?,?)`,[req.body.title,req.body.message,req.body.audience||"All",req.session.user.username]);await log35(req,"publish","Announcements",req.body.title);res.redirect("/announcements")});

/* 4. MESSAGES */
app.get("/messages",requireLogin,async(req,res)=>{const u=req.session.user.username||req.session.user.name;const rows=await all(`SELECT * FROM messages WHERE receiver=? OR sender=? ORDER BY id DESC`,[u,u]);res.send(page("Messages",`<h1>4. Messages</h1><form method="post" action="/messages/send"><input name="receiver" placeholder="Receiver username" required><input name="subject" placeholder="Subject"><textarea name="message" required placeholder="Message"></textarea><button>Send</button></form><table><tr><th>From</th><th>To</th><th>Subject</th><th>Message</th><th>Date</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.sender)}</td><td>${escHtml(x.receiver)}</td><td>${escHtml(x.subject)}</td><td>${escHtml(x.message)}</td><td>${escHtml(x.created_at)}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/messages/send",requireLogin,async(req,res)=>{await run(`INSERT INTO messages(sender,receiver,subject,message) VALUES(?,?,?,?)`,[req.session.user.username||req.session.user.name,req.body.receiver,req.body.subject,req.body.message]);res.redirect("/messages")});

/* 5. REPORTS / CHARTS */
app.get("/reports",simpleAdmin,async(req,res)=>{const s=(await get(`SELECT COUNT(*) c FROM students`)).c,t=(await get(`SELECT COUNT(*) c FROM teachers`)).c,p=(await get(`SELECT COUNT(*) c FROM parents`)).c,a=(await get(`SELECT COUNT(*) c FROM attendance`)).c;const present=(await get(`SELECT COUNT(*) c FROM attendance WHERE status='Present'`)).c;res.send(page("Reports",`<h1>5. Reports & Charts</h1><div class="grid"><div class="card">Students: <b>${s}</b></div><div class="card">Teachers: <b>${t}</b></div><div class="card">Parents: <b>${p}</b></div><div class="card">Attendance: <b>${a}</b></div><div class="card">Present: <b>${present}</b></div></div><p><a href="/reports/attendance.csv">Download Attendance CSV</a> | <a href="/reports/students.csv">Download Students CSV</a> | <a href="/reports/results.csv">Download Results CSV</a></p>`,req.session.user))});
app.get("/reports/attendance.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT student_id,student_name,class_name,subject_name,teacher_name,attendance_date,session,status,recorded_at FROM attendance ORDER BY attendance_date DESC`);res.type("text/csv").send("Student ID,Student Name,Class,Subject,Teacher,Date,Session,Status,Recorded At\n"+rows.map(x=>[x.student_id,x.student_name,x.class_name,x.subject_name,x.teacher_name,x.attendance_date,x.session,x.status,x.recorded_at].map(csv35).join(",")).join("\n"))});
app.get("/reports/students.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT student_id,name,gender,dob,class_name,parent_name,parent_phone,address FROM students`);res.type("text/csv").send("Student ID,Name,Gender,DOB,Class,Parent,Phone,Address\n"+rows.map(x=>[x.student_id,x.name,x.gender,x.dob,x.class_name,x.parent_name,x.parent_phone,x.address].map(csv35).join(",")).join("\n"))});
app.get("/reports/results.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT er.*,e.title exam_title,e.class_name,e.term,e.academic_year,e.exam_date,e.total_marks FROM exam_results er LEFT JOIN exams e ON e.id=er.exam_id ORDER BY e.exam_date DESC,er.student_name`);res.type("text/csv").send("ID,Exam,Exam Date,Class,Term,Academic Year,Student ID,Student Name,Subject,Marks,Total Marks,Percentage,Grade,Remarks\n"+rows.map(x=>[x.id,x.exam_title,x.exam_date,x.class_name,x.term,x.academic_year,x.student_id,x.student_name,x.subject_name,x.marks,x.total_marks,x.percentage,x.grade,x.remarks].map(csv35).join(",")).join("\n"))});
app.get("/reports/fees.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM fees ORDER BY id DESC`);res.type("text/csv").send("ID,Student ID,Student Name,Fee Type,Amount,Paid,Balance,Status,Due Date,Paid At,Notes\n"+rows.map(x=>[x.id,x.student_id,x.student_name,x.fee_type,x.amount,x.paid,x.balance,x.status,x.due_date,x.paid_at,x.notes].map(csv35).join(",")).join("\n"))});
function csv35(v){return `"${String(v??"").replace(/"/g,'""')}"`}

/* 6. USERS & PERMISSIONS */
const PERMISSION_MODULES = ["students","teachers","parents","classes","subjects","attendance","exams","results","fees","reports","notifications","assignments","users"];
app.get("/users-permissions",simpleAdmin,async(req,res)=>{
  const users=await all(`SELECT id,username,role,display_name,phone,active,created_at FROM app_users ORDER BY username`);
  const perms=await all(`SELECT * FROM permissions ORDER BY username,module_name`);
  const userOptions=users.map(u=>`<option value="${escHtml(u.username)}">${escHtml(u.username)} - ${escHtml(u.display_name||"")}</option>`).join("");
  const moduleOptions=PERMISSION_MODULES.map(m=>`<option>${escHtml(m)}</option>`).join("");
  res.send(page("Users & Permissions",`<h1>6. Users & Permissions</h1>
  <h2>Create / Update User</h2><form method="post" action="/users-permissions/add"><div class="grid">
  <input name="username" placeholder="Username" required><input name="display_name" placeholder="Full name">
  <input name="phone" placeholder="Phone"><select name="role"><option>admin</option><option>teacher</option><option>parent</option><option>student</option></select>
  <input type="password" name="password" placeholder="Optional password">
  <select name="active"><option value="1">Active</option><option value="0">Inactive</option></select></div><button>Save User</button></form>
  <h2>Users</h2><table><tr><th>Username</th><th>Name</th><th>Role</th><th>Phone</th><th>Active</th><th>Actions</th></tr>
  ${users.map(u=>`<tr><td>${escHtml(u.username)}</td><td>${escHtml(u.display_name||"")}</td><td>${escHtml(u.role||"")}</td><td>${escHtml(u.phone||"")}</td><td>${u.active?'Yes':'No'}</td><td><a href="/users-permissions/delete/${u.id}" onclick="return confirm('Delete user?')">Delete</a></td></tr>`).join("")}</table>
  <h2>Add / Update Permission</h2><form method="post" action="/permissions/save"><div class="grid"><select name="username" required><option value="">Select User</option>${userOptions}</select><select name="module_name" required><option value="">Select Module</option>${moduleOptions}</select>
  <select name="can_view"><option value="0">View: No</option><option value="1">View: Yes</option></select><select name="can_add"><option value="0">Add: No</option><option value="1">Add: Yes</option></select><select name="can_edit"><option value="0">Edit: No</option><option value="1">Edit: Yes</option></select><select name="can_delete"><option value="0">Delete: No</option><option value="1">Delete: Yes</option></select></div><button>Save Permission</button></form>
  <h2>Permission Matrix</h2><table><tr><th>User</th><th>Module</th><th>View</th><th>Add</th><th>Edit</th><th>Delete</th><th>Action</th></tr>
  ${perms.map(x=>`<tr><td>${escHtml(x.username)}</td><td>${escHtml(x.module_name)}</td><td>${x.can_view?'Yes':'No'}</td><td>${x.can_add?'Yes':'No'}</td><td>${x.can_edit?'Yes':'No'}</td><td>${x.can_delete?'Yes':'No'}</td><td><a href="/permissions/delete/${x.id}" onclick="return confirm('Delete permission?')">Delete</a></td></tr>`).join("")}</table>`,req.session.user));
});
app.post("/users-permissions/add",simpleAdmin,async(req,res)=>{
  const username=String(req.body.username||"").trim(); if(!username) return res.status(400).send("Username required");
  const existing=await get(`SELECT id FROM app_users WHERE username=?`,[username]);
  const hash=req.body.password?await bcrypt.hash(String(req.body.password),10):null;
  if(existing){ await run(`UPDATE app_users SET role=?,display_name=?,phone=?,active=?,password_hash=COALESCE(?,password_hash) WHERE username=?`,[req.body.role,req.body.display_name,req.body.phone,Number(req.body.active||1),hash,username]); }
  else { await run(`INSERT INTO app_users(username,role,display_name,phone,active,password_hash) VALUES(?,?,?,?,?,?)`,[username,req.body.role,req.body.display_name,req.body.phone,Number(req.body.active||1),hash]); }
  await log35(req,"save","Users",username); res.redirect("/users-permissions");
});
app.get("/users-permissions/delete/:id",simpleAdmin,async(req,res)=>{const u=await get(`SELECT username FROM app_users WHERE id=?`,[req.params.id]); if(u){await run(`DELETE FROM permissions WHERE username=?`,[u.username]);await run(`DELETE FROM app_users WHERE id=?`,[req.params.id]);await log35(req,"delete","Users",u.username);} res.redirect("/users-permissions")});
app.post("/permissions/save",simpleAdmin,async(req,res)=>{await run(`DELETE FROM permissions WHERE username=? AND module_name=?`,[req.body.username,req.body.module_name]);await run(`INSERT INTO permissions(username,module_name,can_view,can_add,can_edit,can_delete) VALUES(?,?,?,?,?,?)`,[req.body.username,req.body.module_name,Number(req.body.can_view||0),Number(req.body.can_add||0),Number(req.body.can_edit||0),Number(req.body.can_delete||0)]);await log35(req,"save","Permissions",`${req.body.username}:${req.body.module_name}`);res.redirect("/users-permissions")});
app.get("/permissions/delete/:id",simpleAdmin,async(req,res)=>{await run(`DELETE FROM permissions WHERE id=?`,[req.params.id]);await log35(req,"delete","Permissions",String(req.params.id));res.redirect("/users-permissions")});

/* 7. PASSWORD CHANGE */

/* 7. PASSWORD CHANGE */
app.get("/change-password",requireLogin,(req,res)=>res.send(page("Change Password",`<h1>7. Change Password</h1><form method="post"><input type="password" name="old_password" placeholder="Old password" required><input type="password" name="new_password" placeholder="New password" required><button>Change Password</button></form>`,req.session.user)))
app.post("/change-password",requireLogin,async(req,res)=>{const u=req.session.user;const newHash=await bcrypt.hash(req.body.new_password,10);let table=u.role==="admin"?"users":u.role==="teacher"?"teachers":u.role==="parent"?"parents":"students";const row=await get(`SELECT * FROM ${table} WHERE username=?`,[u.username]);if(!row)return res.status(404).send("User account not found");const ok=await bcrypt.compare(req.body.old_password,row.password||"");if(!ok)return res.status(400).send("Old password is incorrect");await run(`UPDATE ${table} SET password=? WHERE username=?`,[newHash,u.username]);res.send(page("Password Changed",'<h2>Password changed successfully.</h2><a href="/admin">Back</a>',u));});

/* 8. STUDENT PROMOTION */
app.get("/promotion",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM student_promotions ORDER BY id DESC`);res.send(page("Promotion",`<h1>8. Student Promotion</h1><form method="post" action="/promotion/add"><div class="grid"><input name="student_id" placeholder="Student ID" required><input name="from_class" placeholder="From Class"><input name="to_class" placeholder="To Class" required><input name="academic_year" placeholder="Academic Year"></div><button>Promote</button></form><table><tr><th>Student</th><th>From</th><th>To</th><th>Year</th><th>Date</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.student_id)}</td><td>${escHtml(x.from_class)}</td><td>${escHtml(x.to_class)}</td><td>${escHtml(x.academic_year)}</td><td>${escHtml(x.promoted_at)}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/promotion/add",simpleAdmin,async(req,res)=>{const s=await get(`SELECT * FROM students WHERE student_id=?`,[req.body.student_id]);if(!s)return res.status(404).send("Student not found");await run(`INSERT INTO student_promotions(student_id,from_class,to_class,academic_year) VALUES(?,?,?,?)`,[s.student_id,s.class_name,req.body.to_class,req.body.academic_year]);await run(`UPDATE students SET class_name=? WHERE student_id=?`,[req.body.to_class,s.student_id]);await log35(req,"promote","Student Promotion",s.student_id);res.redirect("/promotion")});

/* 9. PRINT & EXCEL-COMPATIBLE REPORTS */
app.get("/print-all",simpleAdmin,async(req,res)=>res.send(page("Print Reports",`<h1>9. Print & Excel Reports</h1><p>CSV files open directly in Excel.</p><p><a href="/reports/students.csv">Students CSV</a></p><p><a href="/reports/attendance.csv">Attendance CSV</a></p><p><a href="/reports/results.csv">Results CSV</a></p><button onclick="window.print()">Print this page</button>`,req.session.user)))

/* 10. SETTINGS */
app.get("/settings",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM settings ORDER BY setting_key`);res.send(page("Settings",`<h1>10. Settings</h1><form method="post" action="/settings/save"><input name="setting_key" placeholder="Setting key" required><input name="setting_value" placeholder="Value" required><button>Save</button></form><table><tr><th>Key</th><th>Value</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.setting_key)}</td><td>${escHtml(x.setting_value)}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/settings/save",simpleAdmin,async(req,res)=>{await run(`INSERT INTO settings(setting_key,setting_value) VALUES(?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value`,[req.body.setting_key,req.body.setting_value]);res.redirect("/settings")});

/* 11. ACADEMIC YEAR / CALENDAR */
app.get("/academic-calendar",simpleAdmin,async(req,res)=>{const y=await all(`SELECT * FROM academic_years ORDER BY id DESC`),e=await all(`SELECT * FROM calendar_events ORDER BY event_date`);res.send(page("Academic Calendar",`<h1>11. Academic Year & Calendar</h1><form method="post" action="/academic-calendar/year"><input name="name" placeholder="2026-2027" required><input type="date" name="start_date"><input type="date" name="end_date"><button>Add Year</button></form><form method="post" action="/academic-calendar/event"><input name="title" placeholder="Event" required><input type="date" name="event_date" required><textarea name="description"></textarea><input name="type" placeholder="Exam/Holiday/Event"><button>Add Event</button></form><h2>Years</h2><table>${y.map(x=>`<tr><td>${escHtml(x.name)}</td><td>${escHtml(x.start_date)}</td><td>${escHtml(x.end_date)}</td></tr>`).join("")}</table><h2>Events</h2><table>${e.map(x=>`<tr><td>${escHtml(x.event_date)}</td><td>${escHtml(x.title)}</td><td>${escHtml(x.type)}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/academic-calendar/year",simpleAdmin,async(req,res)=>{await run(`INSERT INTO academic_years(name,start_date,end_date) VALUES(?,?,?)`,[req.body.name,req.body.start_date,req.body.end_date]);res.redirect("/academic-calendar")});app.post("/academic-calendar/event",simpleAdmin,async(req,res)=>{await run(`INSERT INTO calendar_events(title,event_date,description,type) VALUES(?,?,?,?)`,[req.body.title,req.body.event_date,req.body.description,req.body.type]);res.redirect("/academic-calendar")});

/* 12. BRANCHES / SECTIONS */
app.get("/branches",simpleAdmin,async(req,res)=>{const b=await all(`SELECT * FROM branches`),s=await all(`SELECT * FROM sections`);res.send(page("Branches",`<h1>12. Branches & Sections</h1><form method="post" action="/branches/add"><input name="name" placeholder="Branch"><input name="location" placeholder="Location"><input name="phone" placeholder="Phone"><button>Add Branch</button></form><form method="post" action="/sections/add"><input name="name" placeholder="Section"><input name="branch" placeholder="Branch"><input name="description" placeholder="Description"><button>Add Section</button></form><h2>Branches</h2>${b.map(x=>`<p>${escHtml(x.name)} — ${escHtml(x.location)} — ${escHtml(x.phone)}</p>`).join("")}<h2>Sections</h2>${s.map(x=>`<p>${escHtml(x.name)} — ${escHtml(x.branch)}</p>`).join("")}`,req.session.user))});
app.post("/branches/add",simpleAdmin,async(req,res)=>{await run(`INSERT INTO branches(name,location,phone) VALUES(?,?,?)`,[req.body.name,req.body.location,req.body.phone]);res.redirect("/branches")});app.post("/sections/add",simpleAdmin,async(req,res)=>{await run(`INSERT INTO sections(name,branch,description) VALUES(?,?,?)`,[req.body.name,req.body.branch,req.body.description]);res.redirect("/branches")});

/* 13. STUDENT IDs / 14. TEACHER IDs */
app.get("/ids",simpleAdmin,async(req,res)=>{const s=await all(`SELECT * FROM student_ids ORDER BY id DESC`),t=await all(`SELECT * FROM teacher_ids ORDER BY id DESC`);res.send(page("IDs",`<h1>13-14. Student & Teacher IDs</h1><form method="post" action="/ids/student"><input name="student_id" placeholder="Student ID" required><input name="card_number" placeholder="Card Number" required><input type="date" name="issue_date"><input type="date" name="expiry_date"><button>Create Student ID Record</button></form><form method="post" action="/ids/teacher"><input name="teacher_id" placeholder="Teacher ID" required><input name="card_number" placeholder="Card Number" required><input type="date" name="issue_date"><input type="date" name="expiry_date"><button>Create Teacher ID Record</button></form><h2>Student IDs</h2>${s.map(x=>`<p>${escHtml(x.student_id)} — ${escHtml(x.card_number)} — ${escHtml(x.status)}</p>`).join("")}<h2>Teacher IDs</h2>${t.map(x=>`<p>${escHtml(x.teacher_id)} — ${escHtml(x.card_number)} — ${escHtml(x.status)}</p>`).join("")}<button onclick="window.print()">Print IDs page</button>`,req.session.user))});
app.post("/ids/student",simpleAdmin,async(req,res)=>{await run(`INSERT INTO student_ids(student_id,card_number,issue_date,expiry_date) VALUES(?,?,?,?)`,[req.body.student_id,req.body.card_number,req.body.issue_date,req.body.expiry_date]);res.redirect("/ids")});app.post("/ids/teacher",simpleAdmin,async(req,res)=>{await run(`INSERT INTO teacher_ids(teacher_id,card_number,issue_date,expiry_date) VALUES(?,?,?,?)`,[req.body.teacher_id,req.body.card_number,req.body.issue_date,req.body.expiry_date]);res.redirect("/ids")});

/* 15. CERTIFICATES */
app.get("/certificates",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM certificates ORDER BY id DESC`);res.send(page("Certificates",`<h1>15. Certificates</h1><form method="post"><input name="person_type" placeholder="Student/Teacher"><input name="person_id" placeholder="ID"><input name="person_name" placeholder="Name"><input name="certificate_type" placeholder="Certificate Type"><input type="date" name="issue_date"><textarea name="notes"></textarea><button>Create Record</button></form>${rows.map(x=>`<div class="card"><b>${escHtml(x.certificate_type)}</b> — ${escHtml(x.person_name)} <button onclick="window.print()">Print</button></div>`).join("")}`,req.session.user))});
app.post("/certificates",simpleAdmin,async(req,res)=>{await run(`INSERT INTO certificates(person_type,person_id,person_name,certificate_type,issue_date,notes) VALUES(?,?,?,?,?,?)`,[req.body.person_type,req.body.person_id,req.body.person_name,req.body.certificate_type,req.body.issue_date,req.body.notes]);res.redirect("/certificates")});

/* 16. OFFICIAL LETTERS */
app.get("/letters",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM official_letters ORDER BY id DESC`);res.send(page("Letters",`<h1>16. Official Letters</h1><form method="post"><input name="letter_no" placeholder="Letter No"><input name="recipient" placeholder="Recipient"><input name="subject" placeholder="Subject"><textarea name="body" placeholder="Letter body"></textarea><input type="date" name="issue_date"><button>Create Letter</button></form>${rows.map(x=>`<div class="card"><b>${escHtml(x.letter_no)} — ${escHtml(x.subject)}</b><p>To: ${escHtml(x.recipient)}</p><p>${escHtml(x.body)}</p><button onclick="window.print()">Print</button></div>`).join("")}`,req.session.user))});
app.post("/letters",simpleAdmin,async(req,res)=>{await run(`INSERT INTO official_letters(letter_no,recipient,subject,body,issue_date,created_by) VALUES(?,?,?,?,?,?)`,[req.body.letter_no,req.body.recipient,req.body.subject,req.body.body,req.body.issue_date,req.session.user.username]);res.redirect("/letters")});

/* 17. LIBRARY */
app.get("/library",simpleAdmin,async(req,res)=>{const b=await all(`SELECT * FROM library_books ORDER BY title`),l=await all(`SELECT * FROM library_loans ORDER BY id DESC`);res.send(page("Library",`<h1>17. Library</h1><form method="post" action="/library/book"><input name="isbn" placeholder="ISBN"><input name="title" placeholder="Title" required><input name="author" placeholder="Author"><input name="category" placeholder="Category"><input type="number" name="quantity" value="1"><button>Add Book</button></form><table><tr><th>Title</th><th>Author</th><th>Qty</th><th>Available</th></tr>${b.map(x=>`<tr><td>${escHtml(x.title)}</td><td>${escHtml(x.author)}</td><td>${x.quantity}</td><td>${x.available}</td></tr>`).join("")}</table><h2>Loans</h2>${l.map(x=>`<p>${escHtml(x.borrower_name)} — ${escHtml(x.status)}</p>`).join("")}`,req.session.user))});
app.post("/library/book",simpleAdmin,async(req,res)=>{await run(`INSERT INTO library_books(isbn,title,author,category,quantity,available) VALUES(?,?,?,?,?,?)`,[req.body.isbn,req.body.title,req.body.author,req.body.category,req.body.quantity,req.body.quantity]);res.redirect("/library")});

/* 18. TRANSPORT */
app.get("/transport",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM transport`);res.send(page("Transport",`<h1>18. Transport</h1><form method="post"><input name="vehicle_no" placeholder="Vehicle No"><input name="driver_name" placeholder="Driver"><input name="route" placeholder="Route"><input type="number" name="capacity" placeholder="Capacity"><button>Add Vehicle</button></form>${rows.map(x=>`<div class="card">${escHtml(x.vehicle_no)} — ${escHtml(x.driver_name)} — ${escHtml(x.route)} — Capacity ${x.capacity}</div>`).join("")}`,req.session.user))});
app.post("/transport",simpleAdmin,async(req,res)=>{await run(`INSERT INTO transport(vehicle_no,driver_name,route,capacity) VALUES(?,?,?,?)`,[req.body.vehicle_no,req.body.driver_name,req.body.route,req.body.capacity]);res.redirect("/transport")});

/* 19. INVENTORY */
app.get("/inventory",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM inventory ORDER BY item_name`);res.send(page("Inventory",`<h1>19. Inventory</h1><form method="post"><input name="item_name" placeholder="Item" required><input name="category" placeholder="Category"><input type="number" name="quantity" value="0"><input name="unit" placeholder="Unit"><input name="location" placeholder="Location"><input type="number" name="min_quantity" value="0"><button>Add Item</button></form><table><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Location</th><th>Min</th></tr>${rows.map(x=>`<tr><td>${escHtml(x.item_name)}</td><td>${x.quantity}</td><td>${escHtml(x.unit)}</td><td>${escHtml(x.location)}</td><td>${x.min_quantity}</td></tr>`).join("")}</table>`,req.session.user))});
app.post("/inventory",simpleAdmin,async(req,res)=>{await run(`INSERT INTO inventory(item_name,category,quantity,unit,location,min_quantity) VALUES(?,?,?,?,?,?)`,[req.body.item_name,req.body.category,req.body.quantity,req.body.unit,req.body.location,req.body.min_quantity]);res.redirect("/inventory")});

/* 20. PARENT COMMUNICATION */
app.get("/parent-communication",requireLogin,async(req,res)=>{const rows=await all(`SELECT * FROM parent_communications ORDER BY id DESC`);res.send(page("Parent Communication",`<h1>20. Parent Communication</h1><form method="post"><input name="parent_phone" placeholder="Parent Phone"><input name="student_id" placeholder="Student ID"><input name="subject" placeholder="Subject"><textarea name="message" placeholder="Message"></textarea><button>Send/Record</button></form>${rows.map(x=>`<div class="card">${escHtml(x.parent_phone)} — ${escHtml(x.subject)} — ${escHtml(x.status)}<p>${escHtml(x.message)}</p></div>`).join("")}`,req.session.user))});
app.post("/parent-communication",requireLogin,async(req,res)=>{await run(`INSERT INTO parent_communications(parent_phone,student_id,subject,message,status) VALUES(?,?,?,?,?)`,[req.body.parent_phone,req.body.student_id,req.body.subject,req.body.message,"Pending"]);res.redirect("/parent-communication")});

/* 21. NOTIFICATIONS */
app.get("/notifications",requireLogin,async(req,res)=>{
  const u=req.session.user.username||req.session.user.name; const rows=await all(`SELECT * FROM notifications WHERE username=? OR username='ALL' ORDER BY id DESC`,[u]);
  const unread=rows.filter(x=>!x.read_status).length;
  res.send(page("Notifications",`<h1>21. Notifications</h1><p><b>${unread}</b> unread notification(s).</p>${req.session.user.role==="admin"?`<form method="post" action="/notifications"><div class="grid"><input name="username" placeholder="Username or ALL" value="ALL"><input name="title" placeholder="Title" required><input name="link" placeholder="Optional link e.g. /results"><textarea name="message" placeholder="Message" required></textarea></div><button>Send Notification</button></form>`:""}<p><a href="/notifications/read-all">Mark all as read</a></p>${rows.map(x=>`<div class="card"><b>${escHtml(x.title)}</b> ${x.read_status?'':'<strong>(NEW)</strong>'}<p>${escHtml(x.message)}</p><small>${escHtml(x.created_at)}</small>${x.link?`<p><a href="${escHtml(x.link)}">Open</a></p>`:''}<p><a href="/notifications/read/${x.id}">Mark read</a></p></div>`).join("")}`,req.session.user));
});
app.post("/notifications",simpleAdmin,async(req,res)=>{await run(`INSERT INTO notifications(username,title,message,link) VALUES(?,?,?,?)`,[req.body.username||"ALL",req.body.title,req.body.message,req.body.link||""]);await log35(req,"create","Notifications",req.body.title);res.redirect("/notifications")});
app.get("/notifications/read/:id",requireLogin,async(req,res)=>{const u=req.session.user.username||req.session.user.name;await run(`UPDATE notifications SET read_status=1 WHERE id=? AND (username=? OR username='ALL')`,[req.params.id,u]);res.redirect("/notifications")});
app.get("/notifications/read-all",requireLogin,async(req,res)=>{const u=req.session.user.username||req.session.user.name;await run(`UPDATE notifications SET read_status=1 WHERE username=? OR username='ALL'`,[u]);res.redirect("/notifications")});

/* 22. ADVANCED DASHBOARD */

/* 22. ADVANCED DASHBOARD */
app.get("/advanced-dashboard",simpleAdmin,async(req,res)=>{const q=async sql=>(await get(sql)).c;const vals={students:await q(`SELECT COUNT(*) c FROM students`),teachers:await q(`SELECT COUNT(*) c FROM teachers`),parents:await q(`SELECT COUNT(*) c FROM parents`),classes:await q(`SELECT COUNT(*) c FROM classes`),subjects:await q(`SELECT COUNT(*) c FROM subjects`),attendance:await q(`SELECT COUNT(*) c FROM attendance`),present:await q(`SELECT COUNT(*) c FROM attendance WHERE status='Present'`)};const pct=vals.attendance?((vals.present/vals.attendance)*100).toFixed(1):0;res.send(page("Advanced Dashboard",`<h1>22. Advanced Dashboard</h1><div class="grid">${Object.entries(vals).map(([k,v])=>`<div class="card"><b>${k}</b><h2>${v}</h2></div>`).join("")}<div class="card"><b>Attendance %</b><h2>${pct}%</h2></div></div>`,req.session.user))});

/* 23. BACKUP / RESTORE */
app.get("/backup",simpleAdmin,async(req,res)=>{res.send(page("Backup",`<h1>23. Backup & Restore</h1><p>Backup-ku wuxuu kuu soo dejinayaa SQLite database-ka hadda jira.</p><p><a href="/backup/download">Download barakad.db</a></p><p class="muted">Restore toos ah lama samaynayo si aan xogtaada si qalad ah loo tirtirin; beddelka DB-ga waxaa lagu sameeyaa adigoo server-ka joojiya.</p>`,req.session.user))});
app.get("/backup/download",simpleAdmin,(req,res)=>{res.download(DB_FILE,"barakad-backup.db")});

/* 24. AUDIT LOG */
app.get("/audit-log",simpleAdmin,async(req,res)=>{
  const user=String(req.query.username||"").trim(), module=String(req.query.module||"").trim(), action=String(req.query.action||"").trim();
  let sql=`SELECT * FROM audit_logs WHERE 1=1`, p=[]; if(user){sql+=` AND username LIKE ?`;p.push(`%${user}%`)} if(module){sql+=` AND module_name LIKE ?`;p.push(`%${module}%`)} if(action){sql+=` AND action LIKE ?`;p.push(`%${action}%`)} sql+=` ORDER BY id DESC LIMIT 500`;
  const rows=await all(sql,p);
  res.send(page("Audit Log",`<h1>24. Audit Log</h1><form method="get"><div class="grid"><input name="username" placeholder="Username" value="${escHtml(user)}"><input name="module" placeholder="Module" value="${escHtml(module)}"><input name="action" placeholder="Action" value="${escHtml(action)}"></div><button>Filter</button> <a href="/audit-log/export.csv">Export CSV</a></form><table><tr><th>#</th><th>User</th><th>Action</th><th>Module</th><th>Details</th><th>Date</th></tr>${rows.map(x=>`<tr><td>${x.id}</td><td>${escHtml(x.username)}</td><td>${escHtml(x.action)}</td><td>${escHtml(x.module_name)}</td><td>${escHtml(x.details)}</td><td>${escHtml(x.created_at)}</td></tr>`).join("")}</table>`,req.session.user));
});
app.get("/audit-log/export.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM audit_logs ORDER BY id DESC`);res.type("text/csv").send("ID,Username,Action,Module,Details,Created At\n"+rows.map(x=>[x.id,x.username,x.action,x.module_name,x.details,x.created_at].map(csv35).join(",")).join("\n"))});

/* 25. ONLINE DEPLOYMENT FOUNDATION */

/* 25. ONLINE DEPLOYMENT FOUNDATION */
app.get("/deployment",simpleAdmin,async(req,res)=>res.send(page("Online Deployment",`<h1>25. Online Deployment</h1><p>App-ka wuxuu leeyahay server Express oo diyaar u ah deployment.</p><ul><li>PORT waxaa laga akhriyaa environment.</li><li>SQLite database-ka waxaa lagu hayaa server-ka.</li><li>Production-ka waxaa lagu talinayaa HTTPS, environment secrets iyo cloud database/volume.</li></ul><p>Deployment-ka laftiisa lagama fulin karo gudaha app.js oo keliya.</p>`,req.session.user)));

/* 26. MOBILE APP API */
app.get("/api/status",async(req,res)=>res.json({ok:true,app:"BARAKAD School Management System",version:"35-modules",time:new Date().toISOString()}));
app.get("/mobile-api",simpleAdmin,async(req,res)=>res.send(page("Mobile API",`<h1>26. Mobile App API Foundation</h1><p>API status: <a href="/api/status">/api/status</a></p><p>Mobile Android/iOS app-ka wuxuu API-ga ku xirmi karaa marka domain-ka online noqdo.</p>`,req.session.user)))

/* 27. PARENT PORTAL */
app.get("/portal/parent",requireParent,async(req,res)=>{const u=req.session.user;const students=await all(`SELECT * FROM students WHERE LOWER(TRIM(parent_name))=LOWER(TRIM(?)) OR parent_phone=? ORDER BY name`,[u.name,u.phone||""]);res.send(page("Parent Portal",`<h1>27. Parent Portal</h1><p>Parent: ${escHtml(u.name)}</p>${students.map(s=>`<div class="card"><b>${escHtml(s.name)}</b><p>Class: ${escHtml(s.class_name)}</p><a href="/parent/attendance/${encodeURIComponent(s.student_id)}">Attendance</a></div>`).join("")}`,u))});

/* 28. TEACHER PORTAL */
app.get("/portal/teacher",requireTeacher,async(req,res)=>res.send(page("Teacher Portal",`<h1>28. Teacher Portal</h1><p>${escHtml(req.session.user.name)}</p><p>Class: ${escHtml(req.session.user.class_name)}</p><p>Subject: ${escHtml(req.session.user.subject)}</p><p><a href="/teacher/attendance">Attendance</a> | <a href="/assignments">Assignments</a></p>`,req.session.user)));

/* 29. STUDENT PORTAL */
app.get("/portal/student",requireLogin,async(req,res)=>{if(req.session.user.role!=="student")return res.status(403).send("Student portal only");res.send(page("Student Portal",`<h1>29. Student Portal</h1><p>Welcome ${escHtml(req.session.user.name||req.session.user.username)}</p><p><a href="/assignments">Assignments</a> | <a href="/announcements">Announcements</a></p>`,req.session.user))});

/* 30. COMPLETE FEES MANAGEMENT */
app.get("/fees",simpleAdmin,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const status=String(req.query.status||"").trim();
    const fee_type=String(req.query.fee_type||"").trim();
    let where=[]; let params=[];
    if(q){where.push(`(student_id LIKE ? OR student_name LIKE ? OR fee_type LIKE ?)`); params.push(`%${q}%`,`%${q}%`,`%${q}%`);}
    if(status){where.push(`status=?`); params.push(status);}
    if(fee_type){where.push(`fee_type=?`); params.push(fee_type);}
    const whereSql=where.length?`WHERE ${where.join(" AND ")}`:"";
    const rows=await all(`SELECT * FROM fees ${whereSql} ORDER BY id DESC`,params);
    const payments=await all(`SELECT p.*,f.student_name,f.fee_type FROM fee_payments p LEFT JOIN fees f ON f.id=p.fee_id ORDER BY p.id DESC LIMIT 200`);
    const students=await all(`SELECT student_id,name,class_name,parent_name FROM students ORDER BY name`);
    const totals=await get(`SELECT COALESCE(SUM(amount),0) amount,COALESCE(SUM(paid),0) paid,COALESCE(SUM(balance),0) balance,COUNT(*) count FROM fees`);
    const pending=await get(`SELECT COUNT(*) c,COALESCE(SUM(amount),0) amount FROM fee_payments WHERE status='Pending'`);
    const studentOptions=students.map(st=>`<option value="${escHtml(st.student_id)}" data-name="${escHtml(st.name)}">${escHtml(st.name)} — ${escHtml(st.student_id)} (${escHtml(st.class_name||"")})</option>`).join("");
    const feeRows=rows.map(f=>`<tr>
      <td>${escHtml(f.student_name||"")}<br><small>${escHtml(f.student_id||"")}</small></td>
      <td>${escHtml(f.fee_type||"")}</td><td>${Number(f.amount||0).toFixed(2)}</td>
      <td>${Number(f.paid||0).toFixed(2)}</td><td>${Number(f.balance||0).toFixed(2)}</td>
      <td>${escHtml(f.status||"")}</td><td>${escHtml(f.due_date||"")}</td>
      <td><a href="/fees/payment/new/${f.id}">Payment</a> | <a href="/fees/receipt/${f.id}">Receipt</a> | <a href="/fees/edit/${f.id}">Edit</a> | <a href="/fees/delete/${f.id}" onclick="return confirm('Delete fee and its payments?')">Delete</a></td>
    </tr>`).join("");
    const paymentRows=payments.map(x=>`<tr><td>${x.id}</td><td>${escHtml(x.student_name||"")}<br><small>${escHtml(x.student_id||"")}</small></td><td>${escHtml(x.fee_type||"")}</td><td>${Number(x.amount||0).toFixed(2)}</td><td>${escHtml(x.method||"")}</td><td>${escHtml(x.reference||"")}</td><td>${escHtml(x.status||"")}</td><td>${x.status==='Pending'?`<a href="/fees/payment/approve/${x.id}" onclick="return confirm('Approve this payment?')">Approve</a> | <a href="/fees/payment/reject/${x.id}" onclick="return confirm('Reject this payment?')">Reject</a>`:'-'}</td></tr>`).join("");
    res.send(page("Fees Management",`<h1>30. Fees Management</h1>
      <div class="grid">
        <div class="card">Fee Records<br><b>${totals.count}</b></div>
        <div class="card">Total Fees<br><b>${Number(totals.amount).toFixed(2)}</b></div>
        <div class="card">Total Paid<br><b>${Number(totals.paid).toFixed(2)}</b></div>
        <div class="card">Total Balance<br><b>${Number(totals.balance).toFixed(2)}</b></div>
        <div class="card">Pending Payments<br><b>${pending.c}</b> (${Number(pending.amount||0).toFixed(2)})</div>
      </div>
      <h2>Add Fee</h2>
      <form method="post" action="/fees/add">
        <div class="grid">
          <select name="student_id" required onchange="this.form.student_name.value=this.options[this.selectedIndex].dataset.name||''"><option value="">Select Student</option>${studentOptions}</select>
          <input type="hidden" name="student_name"><input type="number" min="0.01" step="0.01" name="amount" placeholder="Total Amount" required>
          <input name="fee_type" placeholder="Fee Type (Tuition, Exam, Transport...)" required>
          <input name="academic_year" placeholder="Academic Year">
          <input name="month" placeholder="Month (optional)">
          <input type="date" name="due_date"><textarea name="notes" placeholder="Notes"></textarea>
        </div><button>Add Fee</button>
      </form>
      <h2>Search / Filter</h2>
      <form method="get" action="/fees"><div class="grid"><input name="q" value="${escHtml(q)}" placeholder="Student ID, name or fee type"><select name="status"><option value="">All Status</option><option ${status==='Unpaid'?'selected':''}>Unpaid</option><option ${status==='Partial'?'selected':''}>Partial</option><option ${status==='Paid'?'selected':''}>Paid</option></select><input name="fee_type" value="${escHtml(fee_type)}" placeholder="Exact fee type"><button>Filter</button></div></form>
      <p><a href="/reports/fees.csv">Export Fees CSV</a> | <a href="/reports/fee-payments.csv">Export Payments CSV</a></p>
      <h2>Fee Records</h2><table><tr><th>Student</th><th>Type</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Due</th><th>Actions</th></tr>${feeRows||'<tr><td colspan="8">No fee records.</td></tr>'}</table>
      <h2>Payment Requests / History</h2><table><tr><th>ID</th><th>Student</th><th>Type</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th><th>Action</th></tr>${paymentRows||'<tr><td colspan="8">No payments.</td></tr>'}</table>
    `,req.session.user));
  }catch(err){res.status(500).send("Fees page error: "+err.message)}
});

app.post("/fees/add",simpleAdmin,async(req,res)=>{
  try{
    const amount=Number(req.body.amount||0);
    if(!req.body.student_id||!req.body.fee_type||amount<=0)return res.status(400).send("Student, fee type and a valid amount are required.");
    const student=await get(`SELECT * FROM students WHERE student_id=?`,[req.body.student_id]);
    if(!student)return res.status(404).send("Student not found");
    await run(`INSERT INTO fees(student_id,student_name,amount,paid,balance,fee_type,due_date,status,paid_at,notes,academic_year,month,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,[student.student_id,student.name,amount,0,amount,req.body.fee_type,req.body.due_date||"","Unpaid",null,req.body.notes||"",req.body.academic_year||"",req.body.month||"",req.session.user.username||req.session.user.name||"admin"]);
    await log35(req,"create","Fees",`${student.student_id} / ${req.body.fee_type} / ${amount}`);res.redirect("/fees");
  }catch(err){res.status(500).send("Fee add error: "+err.message)}
});

app.get("/fees/edit/:id",simpleAdmin,async(req,res)=>{
  try{
    const f=await get(`SELECT * FROM fees WHERE id=?`,[req.params.id]); if(!f)return res.status(404).send("Fee not found");
    const students=await all(`SELECT student_id,name,class_name FROM students ORDER BY name`);
    const opts=students.map(s=>`<option value="${escHtml(s.student_id)}" ${s.student_id===f.student_id?'selected':''}>${escHtml(s.name)} — ${escHtml(s.student_id)} (${escHtml(s.class_name||"")})</option>`).join("");
    res.send(page("Edit Fee",`<h1>Edit Fee #${f.id}</h1><form method="post"><div class="grid"><select name="student_id" required>${opts}</select><input type="number" min="0.01" step="0.01" name="amount" value="${Number(f.amount||0)}" required><input type="number" min="0" step="0.01" name="paid" value="${Number(f.paid||0)}" required><input name="fee_type" value="${escHtml(f.fee_type||"")}" required><input name="academic_year" value="${escHtml(f.academic_year||"")}" placeholder="Academic Year"><input name="month" value="${escHtml(f.month||"")}" placeholder="Month"><input type="date" name="due_date" value="${escHtml(f.due_date||"")}"><textarea name="notes" placeholder="Notes">${escHtml(f.notes||"")}</textarea></div><p class="muted">Paid amount should match approved payments unless you are correcting a record as administrator.</p><button>Save Changes</button></form><p><a href="/fees">Back to Fees</a></p>`,req.session.user));
  }catch(err){res.status(500).send("Fee edit error: "+err.message)}
});

app.post("/fees/edit/:id",simpleAdmin,async(req,res)=>{
  try{
    const f=await get(`SELECT * FROM fees WHERE id=?`,[req.params.id]); if(!f)return res.status(404).send("Fee not found");
    const student=await get(`SELECT * FROM students WHERE student_id=?`,[req.body.student_id]); if(!student)return res.status(404).send("Student not found");
    const amount=Number(req.body.amount||0), paid=Math.max(0,Number(req.body.paid||0));
    if(amount<=0||paid>amount)return res.status(400).send("Invalid total or paid amount.");
    const balance=amount-paid; const status=balance===0?"Paid":paid>0?"Partial":"Unpaid";
    await run(`UPDATE fees SET student_id=?,student_name=?,amount=?,paid=?,balance=?,fee_type=?,due_date=?,status=?,paid_at=?,notes=?,academic_year=?,month=? WHERE id=?`,[student.student_id,student.name,amount,paid,balance,req.body.fee_type,req.body.due_date||"",status,balance===0?new Date().toISOString():null,req.body.notes||"",req.body.academic_year||"",req.body.month||"",req.params.id]);
    await log35(req,"update","Fees",String(req.params.id));res.redirect("/fees");
  }catch(err){res.status(500).send("Fee update error: "+err.message)}
});

app.get("/fees/delete/:id",simpleAdmin,async(req,res)=>{try{await run(`DELETE FROM fee_payments WHERE fee_id=?`,[req.params.id]);await run(`DELETE FROM fees WHERE id=?`,[req.params.id]);await log35(req,"delete","Fees",String(req.params.id));res.redirect("/fees")}catch(err){res.status(500).send("Fee delete error: "+err.message)}});

app.get("/fees/payment/new/:id",simpleAdmin,async(req,res)=>{
  const f=await get(`SELECT * FROM fees WHERE id=?`,[req.params.id]); if(!f)return res.status(404).send("Fee not found");
  res.send(page("Record Payment",`<h1>Record Payment</h1><div class="card"><b>${escHtml(f.student_name)}</b><br>Fee: ${escHtml(f.fee_type)}<br>Total: ${Number(f.amount||0).toFixed(2)}<br>Paid: ${Number(f.paid||0).toFixed(2)}<br>Balance: ${Number(f.balance||0).toFixed(2)}</div><form method="post" action="/fees/payment/add"><input type="hidden" name="fee_id" value="${f.id}"><div class="grid"><input type="number" min="0.01" max="${Number(f.balance||0)}" step="0.01" name="amount" placeholder="Payment Amount" required><select name="method"><option>Cash</option><option>Bank</option><option>Mobile Money</option><option>Card</option><option>Other</option></select><input name="reference" placeholder="Reference / Receipt No"><input type="date" name="payment_date" value="${new Date().toISOString().slice(0,10)}"></div><button>Save Payment</button></form><p><a href="/fees">Back</a></p>`,req.session.user));
});

app.post("/fees/payment/add",simpleAdmin,async(req,res)=>{
  try{
    const f=await get(`SELECT * FROM fees WHERE id=?`,[req.body.fee_id]); if(!f)return res.status(404).send("Fee not found");
    const amount=Number(req.body.amount||0); if(amount<=0||amount>Number(f.balance||0))return res.status(400).send("Payment amount is greater than the balance or invalid.");
    const receiptNo=String(req.body.reference||(`RCPT-${Date.now()}`)).trim();
    await run(`INSERT INTO fee_payments(fee_id,student_id,amount,method,reference,status,approved_at,approved_by,payment_date) VALUES(?,?,?,?,?,?,?,?,?)`,[f.id,f.student_id,amount,req.body.method||"Cash",receiptNo,"Approved",new Date().toISOString(),req.session.user.username||req.session.user.name||"admin",req.body.payment_date||new Date().toISOString().slice(0,10)]);
    const paid=Number(f.paid||0)+amount,balance=Math.max(0,Number(f.amount||0)-paid),status=balance===0?"Paid":"Partial";
    await run(`UPDATE fees SET paid=?,balance=?,status=?,paid_at=? WHERE id=?`,[paid,balance,status,balance===0?new Date().toISOString():f.paid_at,f.id]);
    await log35(req,"payment","Fees",`${f.id} / ${amount} / ${receiptNo}`);res.redirect(`/fees/receipt/${f.id}`);
  }catch(err){res.status(500).send("Payment error: "+err.message)}
});

app.get("/fees/payment/approve/:id",simpleAdmin,async(req,res)=>{
  try{
    const p=await get(`SELECT * FROM fee_payments WHERE id=?`,[req.params.id]); if(!p)return res.redirect("/fees");
    if(p.status!=="Pending")return res.redirect("/fees");
    const f=await get(`SELECT * FROM fees WHERE id=?`,[p.fee_id]); if(!f)return res.redirect("/fees");
    const amount=Number(p.amount||0); if(amount<=0||amount>Number(f.balance||0)){await run(`UPDATE fee_payments SET status='Rejected',approved_at=?,approved_by=? WHERE id=?`,[new Date().toISOString(),req.session.user.username||"admin",p.id]);return res.redirect("/fees");}
    await run(`UPDATE fee_payments SET status='Approved',approved_at=?,approved_by=? WHERE id=?`,[new Date().toISOString(),req.session.user.username||req.session.user.name||"admin",p.id]);
    const paid=Number(f.paid||0)+amount,balance=Math.max(0,Number(f.amount||0)-paid),status=balance===0?"Paid":"Partial";
    await run(`UPDATE fees SET paid=?,balance=?,status=?,paid_at=? WHERE id=?`,[paid,balance,status,balance===0?new Date().toISOString():f.paid_at,f.id]);
    await log35(req,"approve","Fee Payment",String(p.id));res.redirect("/fees");
  }catch(err){res.status(500).send("Payment approval error: "+err.message)}
});
app.get("/fees/payment/reject/:id",simpleAdmin,async(req,res)=>{try{await run(`UPDATE fee_payments SET status='Rejected',approved_at=?,approved_by=? WHERE id=? AND status='Pending'`,[new Date().toISOString(),req.session.user.username||"admin",req.params.id]);await log35(req,"reject","Fee Payment",String(req.params.id));res.redirect("/fees")}catch(err){res.status(500).send("Payment rejection error: "+err.message)}});

app.get("/fees/receipt/:id",simpleAdmin,async(req,res)=>{
  try{
    const f=await get(`SELECT f.*,s.class_name,s.parent_name,s.parent_phone FROM fees f LEFT JOIN students s ON s.student_id=f.student_id WHERE f.id=?`,[req.params.id]); if(!f)return res.status(404).send("Fee not found");
    const payments=await all(`SELECT * FROM fee_payments WHERE fee_id=? AND status='Approved' ORDER BY id ASC`,[f.id]);
    const paymentRows=payments.map(p=>`<tr><td>${escHtml(p.payment_date||p.created_at||"")}</td><td>${escHtml(p.reference||"")}</td><td>${escHtml(p.method||"")}</td><td>${Number(p.amount||0).toFixed(2)}</td></tr>`).join("");
    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fee Receipt #${f.id}</title><style>body{font-family:Arial;padding:25px}.receipt{max-width:760px;margin:auto;border:1px solid #ccc;padding:25px}.top{text-align:center}.row{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:7px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ccc;padding:8px}button{padding:10px 18px;border:0;border-radius:6px}@media print{button,.back{display:none}}</style></head><body><div class="receipt"><div class="top"><h1>BARAKAD SCHOOL</h1><h2>FEE RECEIPT</h2><p>Receipt #${f.id}</p></div><div class="row"><b>Student</b><span>${escHtml(f.student_name)}</span></div><div class="row"><b>Student ID</b><span>${escHtml(f.student_id)}</span></div><div class="row"><b>Class</b><span>${escHtml(f.class_name||"")}</span></div><div class="row"><b>Fee Type</b><span>${escHtml(f.fee_type||"")}</span></div><div class="row"><b>Total</b><span>${Number(f.amount||0).toFixed(2)}</span></div><div class="row"><b>Paid</b><span>${Number(f.paid||0).toFixed(2)}</span></div><div class="row"><b>Balance</b><span>${Number(f.balance||0).toFixed(2)}</span></div><h3>Approved Payments</h3><table><tr><th>Date</th><th>Reference</th><th>Method</th><th>Amount</th></tr>${paymentRows||'<tr><td colspan="4">No approved payments.</td></tr>'}</table><p>Parent: ${escHtml(f.parent_name||"")} ${f.parent_phone?`— ${escHtml(f.parent_phone)}`:""}</p><p>Due Date: ${escHtml(f.due_date||"")}</p><p class="back"><button onclick="window.print()">Print Receipt</button> <a href="/fees">Back to Fees</a></p></div></body></html>`);
  }catch(err){res.status(500).send("Receipt error: "+err.message)}
});

app.get("/reports/fee-payments.csv",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT p.*,f.student_name,f.fee_type FROM fee_payments p LEFT JOIN fees f ON f.id=p.fee_id ORDER BY p.id DESC`);const csv=["Payment ID,Fee ID,Student ID,Student Name,Fee Type,Amount,Method,Reference,Status,Payment Date,Approved By,Approved At",...rows.map(x=>[x.id,x.fee_id,x.student_id,x.student_name,x.fee_type,x.amount,x.method,x.reference,x.status,x.payment_date,x.approved_by,x.approved_at].map(csv35).join(","))].join("\n");res.type("text/csv").send(csv)});

/* Parent fee view: parent can only see fees belonging to their children. */
app.get("/parent/fees",requireParent,async(req,res)=>{
  try{
    const u=req.session.user;
    const fees=await all(`SELECT f.* FROM fees f JOIN students s ON s.student_id=f.student_id WHERE LOWER(TRIM(s.parent_name))=LOWER(TRIM(?)) OR (s.parent_phone IS NOT NULL AND TRIM(s.parent_phone)<>'' AND s.parent_phone=?) ORDER BY f.id DESC`,[u.name,u.phone||""]);
    res.send(page("My Children's Fees",`<h1>My Children's Fees</h1><table><tr><th>Student</th><th>Fee Type</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Due</th><th>Receipt</th></tr>${fees.map(f=>`<tr><td>${escHtml(f.student_name)}<br><small>${escHtml(f.student_id)}</small></td><td>${escHtml(f.fee_type||"")}</td><td>${Number(f.amount||0).toFixed(2)}</td><td>${Number(f.paid||0).toFixed(2)}</td><td>${Number(f.balance||0).toFixed(2)}</td><td>${escHtml(f.status||"")}</td><td>${escHtml(f.due_date||"")}</td><td><a href="/parent/fees/receipt/${f.id}">View</a></td></tr>`).join("")||'<tr><td colspan="8">No fee records.</td></tr>'}</table>`,req.session.user));
  }catch(err){res.status(500).send("Parent fees error: "+err.message)}
});
app.get("/parent/fees/receipt/:id",requireParent,async(req,res)=>{
  const u=req.session.user; const f=await get(`SELECT f.*,s.class_name,s.parent_name,s.parent_phone FROM fees f JOIN students s ON s.student_id=f.student_id WHERE f.id=? AND (LOWER(TRIM(s.parent_name))=LOWER(TRIM(?)) OR (s.parent_phone IS NOT NULL AND TRIM(s.parent_phone)<>'' AND s.parent_phone=?))`,[req.params.id,u.name,u.phone||""]); if(!f)return res.status(403).send("Fee record not found or not authorized.");
  const payments=await all(`SELECT * FROM fee_payments WHERE fee_id=? AND status='Approved' ORDER BY id`,[f.id]);
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Fee Receipt</title><style>body{font-family:Arial;padding:25px}.receipt{max-width:700px;margin:auto;border:1px solid #ccc;padding:25px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:8px}@media print{button{display:none}}</style></head><body><div class="receipt"><h1>BARAKAD SCHOOL</h1><h2>Fee Receipt</h2><p>Student: <b>${escHtml(f.student_name)}</b> (${escHtml(f.student_id)})</p><p>Fee: ${escHtml(f.fee_type||"")}</p><p>Total: ${Number(f.amount||0).toFixed(2)} | Paid: ${Number(f.paid||0).toFixed(2)} | Balance: ${Number(f.balance||0).toFixed(2)}</p><table><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr>${payments.map(p=>`<tr><td>${escHtml(p.payment_date||p.created_at||"")}</td><td>${escHtml(p.method||"")}</td><td>${escHtml(p.reference||"")}</td><td>${Number(p.amount||0).toFixed(2)}</td></tr>`).join("")||'<tr><td colspan="4">No payments.</td></tr>'}</table><br><button onclick="window.print()">Print</button> <a href="/parent/fees">Back</a></div></body></html>`);
});

/* 31. ADVANCED ANALYTICS */
app.get("/analytics",simpleAdmin,async(req,res)=>{
 const totals={students:(await get(`SELECT COUNT(*) c FROM students`)).c,teachers:(await get(`SELECT COUNT(*) c FROM teachers`)).c,parents:(await get(`SELECT COUNT(*) c FROM parents`)).c,attendance:(await get(`SELECT COUNT(*) c FROM attendance`)).c};
 const attendance=await all(`SELECT class_name,COUNT(*) total,SUM(CASE WHEN status='Present' THEN 1 ELSE 0 END) present,SUM(CASE WHEN status='Absent' THEN 1 ELSE 0 END) absent,SUM(CASE WHEN status='Late' THEN 1 ELSE 0 END) late FROM attendance GROUP BY class_name ORDER BY class_name`);
 const results=await all(`SELECT subject_name,COUNT(*) count,AVG(marks) avg_marks,MAX(marks) max_marks,MIN(marks) min_marks FROM exam_results GROUP BY subject_name ORDER BY subject_name`);
 const fees=await get(`SELECT COALESCE(SUM(amount),0) amount,COALESCE(SUM(paid),0) paid,COALESCE(SUM(balance),0) balance FROM fees`);
 const exams=await get(`SELECT COUNT(*) c FROM exams`);
 res.send(page("Analytics",`<h1>31. Advanced Analytics</h1><div class="grid"><div class="card">Students<br><b>${totals.students}</b></div><div class="card">Teachers<br><b>${totals.teachers}</b></div><div class="card">Parents<br><b>${totals.parents}</b></div><div class="card">Attendance Records<br><b>${totals.attendance}</b></div><div class="card">Exams<br><b>${exams.c}</b></div><div class="card">Fees Total<br><b>${Number(fees.amount).toFixed(2)}</b></div><div class="card">Fees Paid<br><b>${Number(fees.paid).toFixed(2)}</b></div><div class="card">Fees Balance<br><b>${Number(fees.balance).toFixed(2)}</b></div></div>
 <h2>Attendance by Class</h2><table><tr><th>Class</th><th>Total</th><th>Present</th><th>Absent</th><th>Late</th><th>Attendance %</th></tr>${attendance.map(x=>`<tr><td>${escHtml(x.class_name)}</td><td>${x.total}</td><td>${x.present}</td><td>${x.absent}</td><td>${x.late}</td><td>${x.total?((x.present/x.total)*100).toFixed(1):0}%</td></tr>`).join("")}</table>
 <h2>Results by Subject</h2><table><tr><th>Subject</th><th>Results</th><th>Average</th><th>Max</th><th>Min</th></tr>${results.map(x=>`<tr><td>${escHtml(x.subject_name||"")}</td><td>${x.count}</td><td>${Number(x.avg_marks||0).toFixed(1)}</td><td>${x.max_marks||0}</td><td>${x.min_marks||0}</td></tr>`).join("")}</table>
 <p><a href="/reports/results.csv">Results CSV</a> | <a href="/reports/fees.csv">Fees CSV</a> | <a href="/audit-log">Audit Log</a></p>`,req.session.user));
});

/* 32. SMART SCHOOL ASSISTANT */

/* 32. SMART SCHOOL ASSISTANT */
app.get("/smart-assistant",requireLogin,(req,res)=>res.send(page("Smart School Assistant",`<h1>32. Smart School Assistant</h1><p>Su'aalaha xogta dugsiga waxaad ka heli kartaa menu-yada:</p><div class="grid"><div class="card"><a href="/advanced-dashboard">Dashboard</a></div><div class="card"><a href="/reports">Reports</a></div><div class="card"><a href="/analytics">Analytics</a></div><div class="card"><a href="/announcements">Announcements</a></div></div><p class="muted">Tani waa assistant-ka gudaha app-ka; AI dibadda ah laguma darin si app-ku u shaqeeyo isagoo aan API key u baahnayn.</p>`,req.session.user)))

/* 33. SMS / WHATSAPP FOUNDATION */
app.get("/communications",simpleAdmin,async(req,res)=>res.send(page("SMS & WhatsApp",`<h1>33. SMS / WhatsApp Notification Foundation</h1><form method="post"><input name="phone" placeholder="Phone"><textarea name="message" placeholder="Message"></textarea><select name="channel"><option>SMS</option><option>WhatsApp</option></select><button>Queue Message</button></form><p class="muted">Message-ka waxaa lagu kaydin karaa parent_communications. SMS/WhatsApp live wuxuu u baahan yahay provider iyo API credentials.</p>`,req.session.user)));
app.post("/communications",simpleAdmin,async(req,res)=>{await run(`INSERT INTO parent_communications(parent_phone,subject,message,status) VALUES(?,?,?,?)`,[req.body.phone,req.body.channel,req.body.message,"Queued"]);res.redirect("/communications")});

/* 34. CLOUD BACKUP FOUNDATION */
app.get("/cloud-backup",simpleAdmin,async(req,res)=>res.send(page("Cloud Backup",`<h1>34. Cloud Backup Foundation</h1><p><a href="/backup/download">Download current backup</a></p><p>Cloud storage sida Google Drive, S3 ama provider kale wuxuu u baahan yahay account/API configuration. App.js-kan wuxuu bixiyaa backup download endpoint.</p>`,req.session.user)))

/* 35. MAINTENANCE / UPDATES */
app.get("/maintenance",simpleAdmin,async(req,res)=>{const rows=await all(`SELECT * FROM system_tasks ORDER BY id DESC`);res.send(page("Maintenance",`<h1>35. Maintenance & Updates</h1><form method="post"><input name="title" placeholder="Task / Update" required><input name="status" placeholder="Planned/In Progress/Done"><textarea name="notes"></textarea><button>Save Task</button></form>${rows.map(x=>`<div class="card"><b>${escHtml(x.title)}</b> — ${escHtml(x.status)}<p>${escHtml(x.notes)}</p></div>`).join("")}`,req.session.user))});
app.post("/maintenance",simpleAdmin,async(req,res)=>{await run(`INSERT INTO system_tasks(title,status,notes) VALUES(?,?,?)`,[req.body.title,req.body.status,req.body.notes]);res.redirect("/maintenance")});

/* ALL 35 MODULES INDEX */
app.get("/all-modules",requireLogin,(req,res)=>{const mods=[
[1,"Timetable","/timetable"],[2,"Assignments","/assignments"],[3,"Announcements","/announcements"],[4,"Messages","/messages"],[5,"Reports & Charts","/reports"],[6,"Users & Permissions","/users-permissions"],[7,"Password Change","/change-password"],[8,"Student Promotion","/promotion"],[9,"Print & Excel Reports","/print-all"],[10,"Settings","/settings"],[11,"Academic Year & Calendar","/academic-calendar"],[12,"Branches & Sections","/branches"],[13,"Student IDs","/ids"],[14,"Teacher IDs","/ids"],[15,"Certificates","/certificates"],[16,"Official Letters","/letters"],[17,"Library","/library"],[18,"Transport","/transport"],[19,"Inventory","/inventory"],[20,"Parent Communication","/parent-communication"],[21,"Notifications","/notifications"],[22,"Advanced Dashboard","/advanced-dashboard"],[23,"Backup & Restore","/backup"],[24,"Audit Log","/audit-log"],[25,"Online Deployment Foundation","/deployment"],[26,"Mobile App API","/mobile-api"],[27,"Parent Portal","/portal/parent"],[28,"Teacher Portal","/portal/teacher"],[29,"Student Portal","/portal/student"],[30,"Fees & Online Payment","/fees"],[31,"Salaries","/salaries"],[32,"Advanced Analytics","/analytics"],[32,"Smart School Assistant","/smart-assistant"],[33,"SMS / WhatsApp","/communications"],[34,"Cloud Backup","/cloud-backup"],[35,"Maintenance & Updates","/maintenance"]];res.send(page("35 Modules",`<h1>BARAKAD — 35 Modules</h1><div class="grid">${mods.map(m=>`<div class="card"><b>${m[0]}. ${escHtml(m[1])}</b><p><a href="${m[2]}">Open</a></p></div>`).join("")}</div>`,req.session.user))});


/* =========================
   LOGOUT
========================= */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

/* =========================
   404
========================= */
/* SALARY MANAGEMENT */
app.get("/salaries",simpleAdmin,async(req,res)=>{const rows=await all("SELECT * FROM salaries ORDER BY id DESC");const body=`<h1>💰 Salary Management</h1><p><a href="/reports/salaries.csv">📥 Export CSV</a></p><form method="post" action="/salaries/add"><input name="employee_id" placeholder="Employee ID"><input name="employee_name" placeholder="Employee name" required><select name="employee_type"><option>Teacher</option><option>Employee</option><option>Staff</option></select><input name="salary_amount" type="number" step="0.01" min="0" placeholder="Salary" required><input name="month" placeholder="Month" required><input name="year" placeholder="Year" required><input name="notes" placeholder="Notes"><button>Add Salary</button></form><table><tr><th>Employee</th><th>Month</th><th>Salary</th><th>Paid</th><th>Balance</th><th>Status</th><th>Actions</th></tr>${rows.map(r=>`<tr><td>${escHtml(r.employee_name)}</td><td>${escHtml(r.month||"")} ${escHtml(r.year||"")}</td><td>${(+r.salary_amount||0).toFixed(2)}</td><td>${(+r.paid_amount||0).toFixed(2)}</td><td>${(+r.balance||0).toFixed(2)}</td><td>${escHtml(r.status||"Unpaid")}</td><td><a href="/salaries/payment/new/${r.id}">Pay</a> | <a href="/salaries/edit/${r.id}">Edit</a> | <a href="/salaries/receipt/${r.id}" target="_blank">Receipt</a> | <a href="/salaries/delete/${r.id}">Delete</a></td></tr>`).join("")}</table>`;res.send(page("Salaries",body,req.session.user))});
app.post("/salaries/add",simpleAdmin,async(req,res)=>{const a=+req.body.salary_amount||0;await run(`INSERT INTO salaries(employee_id,employee_name,employee_type,salary_amount,paid_amount,balance,month,year,status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[req.body.employee_id||"",req.body.employee_name,req.body.employee_type||"Teacher",a,0,a,req.body.month,req.body.year,"Unpaid",req.body.notes||"",req.session.user.username||"admin"]);res.redirect("/salaries")});
app.get("/salaries/edit/:id",simpleAdmin,async(req,res)=>{const r=await get("SELECT * FROM salaries WHERE id=?",[req.params.id]);if(!r)return res.status(404).send("Salary not found");res.send(page("Edit Salary",`<h1>Edit Salary</h1><form method="post" action="/salaries/edit/${r.id}"><input name="employee_name" value="${escHtml(r.employee_name)}" required><input name="salary_amount" type="number" step="0.01" value="${r.salary_amount}" required><input name="month" value="${escHtml(r.month||"")}" required><input name="year" value="${escHtml(r.year||"")}" required><button>Save</button></form>`,req.session.user))});
app.post("/salaries/edit/:id",simpleAdmin,async(req,res)=>{const r=await get("SELECT * FROM salaries WHERE id=?",[req.params.id]);const a=+req.body.salary_amount||0,p=+r.paid_amount||0;if(a<p)return res.status(400).send("Salary cannot be less than paid amount");await run("UPDATE salaries SET employee_name=?,salary_amount=?,balance=?,month=?,year=?,status=? WHERE id=?",[req.body.employee_name,a,a-p,req.body.month,req.body.year,a-p===0?"Paid":p?"Partial":"Unpaid",req.params.id]);res.redirect("/salaries")});
app.get("/salaries/delete/:id",simpleAdmin,async(req,res)=>{await run("DELETE FROM salary_payments WHERE salary_id=?",[req.params.id]);await run("DELETE FROM salaries WHERE id=?",[req.params.id]);res.redirect("/salaries")});
app.get("/salaries/payment/new/:id",simpleAdmin,async(req,res)=>{const r=await get("SELECT * FROM salaries WHERE id=?",[req.params.id]);res.send(page("Pay Salary",`<h1>Pay Salary</h1><p>${escHtml(r.employee_name)} — Balance: ${(+r.balance||0).toFixed(2)}</p><form method="post" action="/salaries/payment/add"><input type="hidden" name="salary_id" value="${r.id}"><input name="amount" type="number" step="0.01" max="${r.balance}" required><select name="method"><option>Cash</option><option>Bank</option><option>Mobile Money</option></select><input name="reference" placeholder="Reference"><input name="payment_date" type="date" value="${new Date().toISOString().slice(0,10)}"><button>Save Payment</button></form>`,req.session.user))});
app.post("/salaries/payment/add",simpleAdmin,async(req,res)=>{const s=await get("SELECT * FROM salaries WHERE id=?",[req.body.salary_id]),a=+req.body.amount||0;if(!s||a<=0||a>s.balance)return res.status(400).send("Invalid payment");const paid=(+s.paid_amount||0)+a,b=Math.max(0,s.salary_amount-paid);await run(`INSERT INTO salary_payments(salary_id,employee_id,employee_name,amount,method,reference,payment_date,status,approved_at,approved_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,[s.id,s.employee_id,s.employee_name,a,req.body.method||"Cash",req.body.reference||("SAL-"+Date.now()),req.body.payment_date||new Date().toISOString().slice(0,10),"Approved",new Date().toISOString(),req.session.user.username||"admin"]);await run("UPDATE salaries SET paid_amount=?,balance=?,status=?,payment_date=? WHERE id=?",[paid,b,b===0?"Paid":"Partial",req.body.payment_date||"",s.id]);res.redirect("/salaries")});
app.get("/salaries/receipt/:id",simpleAdmin,async(req,res)=>{const s=await get("SELECT * FROM salaries WHERE id=?",[req.params.id]),ps=await all("SELECT * FROM salary_payments WHERE salary_id=?",[req.params.id]);res.send(`<html><body><h1>BARAKAD SCHOOL</h1><h2>Salary Receipt</h2><p>Employee: ${escHtml(s.employee_name)}</p><p>Month: ${escHtml(s.month)} ${escHtml(s.year)}</p><table border="1"><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr>${ps.map(x=>`<tr><td>${escHtml(x.payment_date||"")}</td><td>${escHtml(x.method||"")}</td><td>${escHtml(x.reference||"")}</td><td>${x.amount}</td></tr>`).join("")}</table><p>Balance: ${s.balance}</p><button onclick="window.print()">Print</button></body></html>`) });
app.get("/reports/salaries.csv",simpleAdmin,async(req,res)=>{const rows=await all("SELECT * FROM salaries ORDER BY year DESC,month DESC,employee_name");let csv="Employee,Month,Year,Salary,Paid,Balance,Status\n";rows.forEach(r=>csv+=`"${String(r.employee_name||"").replace(/"/g,'""')}","${r.month||""}","${r.year||""}",${r.salary_amount||0},${r.paid_amount||0},${r.balance||0},"${r.status||""}"\n`);res.setHeader("Content-Type","text/csv");res.setHeader("Content-Disposition",'attachment; filename="salaries.csv"');res.send(csv)});

/* ================= USER MANAGEMENT ================= */
app.get("/users", simpleAdmin, async (req,res)=>{
  const q=String(req.query.q||"").trim();
  const role=String(req.query.role||"").trim();
  let sql="SELECT id,username,name,role,phone FROM users WHERE 1=1", params=[];
  if(q){sql+=" AND (username LIKE ? OR name LIKE ? OR phone LIKE ?)";params.push("%"+q+"%","%"+q+"%","%"+q+"%");}
  if(role){sql+=" AND role=?";params.push(role);}
  sql+=" ORDER BY id DESC";
  const users=await all(sql,params);
  const body=`<h1>👤 User Management</h1>
  <form method="get" action="/users">
    <input name="q" placeholder="Search username/name/phone" value="${escHtml(q)}">
    <select name="role"><option value="">All Roles</option>${["admin","teacher","parent","student"].map(x=>`<option ${role===x?"selected":""}>${x}</option>`).join("")}</select>
    <button>Search</button> <a href="/users">Reset</a>
  </form>
  <h2>Add User</h2>
  <form method="post" action="/users/add">
    <input name="username" placeholder="Username" required>
    <input name="name" placeholder="Full name" required>
    <input name="phone" placeholder="Phone">
    <select name="role"><option>admin</option><option>teacher</option><option>parent</option><option>student</option></select>
    <input name="password" type="password" placeholder="Password" required>
    <button>Add User</button>
  </form>
  <table><tr><th>ID</th><th>Username</th><th>Name</th><th>Phone</th><th>Role</th><th>Actions</th></tr>
  ${users.map(u=>`<tr><td>${u.id}</td><td>${escHtml(u.username||"")}</td><td>${escHtml(u.name||"")}</td><td>${escHtml(u.phone||"")}</td><td>${escHtml(u.role||"")}</td>
  <td><a href="/users/edit/${u.id}">Edit</a> | <a href="/users/password/${u.id}">Change Password</a> | <a href="/users/delete/${u.id}" onclick="return confirm('Delete user?')">Delete</a></td></tr>`).join("")}</table>`;
  res.send(page("Users",body,req.session.user));
});

app.post("/users/add", simpleAdmin, async (req,res)=>{
  const username=String(req.body.username||"").trim();
  const name=String(req.body.name||"").trim();
  const password=String(req.body.password||"");
  if(!username||!name||!password) return res.status(400).send("Username, name and password are required.");
  const exists=await get("SELECT id FROM users WHERE username=?",[username]);
  if(exists) return res.status(400).send("Username already exists.");
  const hash=await bcrypt.hash(password,10);
  await run("INSERT INTO users(username,name,password,role,phone) VALUES(?,?,?,?,?)",
    [username,name,hash,req.body.role||"student",req.body.phone||""]);
  res.redirect("/users");
});

app.get("/users/edit/:id", simpleAdmin, async (req,res)=>{
  const u=await get("SELECT id,username,name,role,phone FROM users WHERE id=?",[req.params.id]);
  if(!u) return res.status(404).send("User not found.");
  const body=`<h1>Edit User</h1><form method="post" action="/users/edit/${u.id}">
    <input name="username" value="${escHtml(u.username||"")}" required>
    <input name="name" value="${escHtml(u.name||"")}" required>
    <input name="phone" value="${escHtml(u.phone||"")}">
    <select name="role">${["admin","teacher","parent","student"].map(x=>`<option ${u.role===x?"selected":""}>${x}</option>`).join("")}</select>
    <button>Save</button></form>`;
  res.send(page("Edit User",body,req.session.user));
});

app.post("/users/edit/:id", simpleAdmin, async (req,res)=>{
  const username=String(req.body.username||"").trim();
  const duplicate=await get("SELECT id FROM users WHERE username=? AND id<>?",[username,req.params.id]);
  if(duplicate) return res.status(400).send("Username already exists.");
  await run("UPDATE users SET username=?,name=?,role=?,phone=? WHERE id=?",
    [username,req.body.name||"",req.body.role||"student",req.body.phone||"",req.params.id]);
  res.redirect("/users");
});

app.get("/users/password/:id", simpleAdmin, async (req,res)=>{
  const u=await get("SELECT id,username,name FROM users WHERE id=?",[req.params.id]);
  if(!u) return res.status(404).send("User not found.");
  const body=`<h1>🔑 Change Password</h1><p>${escHtml(u.username||"")}</p>
  <form method="post" action="/users/password/${u.id}">
    <input name="password" type="password" placeholder="New password" required>
    <button>Update Password</button>
  </form>`;
  res.send(page("Change Password",body,req.session.user));
});

app.post("/users/password/:id", simpleAdmin, async (req,res)=>{
  const password=String(req.body.password||"");
  if(password.length<4) return res.status(400).send("Password must be at least 4 characters.");
  const hash=await bcrypt.hash(password,10);
  await run("UPDATE users SET password=? WHERE id=?",[hash,req.params.id]);
  res.redirect("/users");
});

app.get("/users/delete/:id", simpleAdmin, async (req,res)=>{
  if(String(req.params.id)===String(req.session.user.id)) return res.status(400).send("You cannot delete your current account.");
  await run("DELETE FROM users WHERE id=?",[req.params.id]);
  res.redirect("/users");
});
/* ================= END USER MANAGEMENT ================= */


app.use((req, res) => {
  res.status(404).send("Page not found");
});

/* =========================
   START
========================= */
ensureDatabase()
  .then(() => setup35Modules())
  .then(() => {
    app.listen(PORT, () => {
      console.log("");
      console.log(`http://localhost:${PORT}`);
      console.log("");
      console.log("Default Admin:");
      console.log("Username: admin");
      console.log("Password: Admin@123");
      console.log("======================================");
    });
  })
  .catch((err) => {
    console.error("Database setup error:", err);
  });
