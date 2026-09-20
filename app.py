import os
from flask import Flask, render_template, request, redirect, url_for
import sqlite3

app = Flask(__name__, template_folder='templates')
app.secret_key = "barakad_school_secret_key_2026"

# Xalka database-ka: Wuxuu si automatic ah u kala saaraa Windows iyo Render
if os.name == 'posix':  # Linux/Mac (Render)
    DATABASE = os.path.join('/tmp', 'barakad.db')
else:  # Windows (Computer-kaaga)
    DATABASE = "barakad.db"

CLASS_LIST = [
    "1aad", "2aad", "3aad", "4aad",
    "5aad", "6aad", "7aad", "8aad",
    "Form One", "Form Two", "Form Three", "Form Four"
]


# ================= DATABASE =================

def get_db():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with app.app_context():
        db = get_db()

        db.execute("""
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                class_name TEXT NOT NULL,
                phone TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS teachers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                subject TEXT NOT NULL,
                phone TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS parents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS classes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS fees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_name TEXT NOT NULL,
                class_name TEXT DEFAULT '',
                amount REAL NOT NULL,
                status TEXT NOT NULL
            )
        """)

        # Hubi column-ka class_name ee fees
        columns = db.execute("PRAGMA table_info(fees)").fetchall()
        column_names = [column["name"] for column in columns]

        if "class_name" not in column_names:
            db.execute("ALTER TABLE fees ADD COLUMN class_name TEXT DEFAULT ''")

        db.execute("""
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_name TEXT NOT NULL,
                class_name TEXT NOT NULL,
                date TEXT,
                status TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS exams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                class_name TEXT NOT NULL,
                date TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_name TEXT NOT NULL,
                class_name TEXT NOT NULL,
                subject TEXT NOT NULL,
                marks REAL NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS lesson_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                teacher TEXT,
                subject TEXT,
                class_name TEXT,
                lesson TEXT,
                date TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                password TEXT,
                role TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS calendar (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                date TEXT,
                description TEXT
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                content TEXT,
                date TEXT
            )
        """)

        # Classes-ka default-ka ah
        for class_name in CLASS_LIST:
            db.execute(
                "INSERT OR IGNORE INTO classes (name) VALUES (?)",
                (class_name,)
            )

        db.commit()
        db.close()


# Abuur database-ka marka app-ku bilaabmo
init_db()


# ================= HOME =================

@app.route("/")
def home():
    return redirect(url_for("login"))


# ================= LOGIN =================

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()

        if username == "admin" and password == "1234":
            return redirect(url_for("dashboard"))

    return render_template("login.html")


# ================= DASHBOARD =================

@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


# ================= STUDENTS =================

@app.route("/students")
def students():
    db = get_db()
    students_list = db.execute("SELECT * FROM students ORDER BY id DESC").fetchall()
    db.close()
    return render_template("students.html", students=students_list, classes=CLASS_LIST)


@app.route("/students/add", methods=["POST"])
def add_student():
    name = request.form.get("name", "").strip()
    class_name = request.form.get("class_name", "").strip()
    phone = request.form.get("phone", "").strip()

    if not name or not class_name:
        return redirect(url_for("students"))

    db = get_db()
    db.execute("INSERT INTO students (name, class_name, phone) VALUES (?, ?, ?)", (name, class_name, phone))
    db.commit()
    db.close()
    return redirect(url_for("students"))


# ================= TEACHERS =================

@app.route("/teachers")
def teachers():
    db = get_db()
    teachers_list = db.execute("SELECT * FROM teachers ORDER BY id DESC").fetchall()
    db.close()
    return render_template("teachers.html", teachers=teachers_list)


@app.route("/teachers/add", methods=["POST"])
def add_teacher():
    name = request.form.get("name", "").strip()
    subject = request.form.get("subject", "").strip()
    phone = request.form.get("phone", "").strip()

    if not name or not subject:
        return redirect(url_for("teachers"))

    db = get_db()
    db.execute("INSERT INTO teachers (name, subject, phone) VALUES (?, ?, ?)", (name, subject, phone))
    db.commit()
    db.close()
    return redirect(url_for("teachers"))


# ================= PARENTS =================

@app.route("/parents")
def parents():
    db = get_db()
    parents_list = db.execute("SELECT * FROM parents ORDER BY id DESC").fetchall()
    db.close()
    return render_template("parents.html", parents=parents_list)


@app.route("/parents/add", methods=["POST"])
def add_parent():
    name = request.form.get("name", "").strip()
    phone = request.form.get("phone", "").strip()

    if not name:
        return redirect(url_for("parents"))

    db = get_db()
    db.execute("INSERT INTO parents (name, phone) VALUES (?, ?)", (name, phone))
    db.commit()
    db.close()
    return redirect(url_for("parents"))


# ================= CLASSES =================

@app.route("/classes")
def classes():
    db = get_db()
    classes_list = db.execute("SELECT * FROM classes ORDER BY id").fetchall()
    db.close()
    return render_template("classes.html", classes=classes_list)


@app.route("/classes/add", methods=["POST"])
def add_class():
    name = request.form.get("name", "").strip()
    if not name:
        return redirect(url_for("classes"))

    db = get_db()
    db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", (name,))
    db.commit()
    db.close()
    return redirect(url_for("classes"))


# ================= FEES =================

@app.route("/fees")
def fees():
    selected_class = request.args.get("class_name", "").strip()
    db = get_db()

    all_fees = db.execute("SELECT * FROM fees ORDER BY id DESC").fetchall()

    students_list = []
    if selected_class:
        students_list = db.execute("SELECT * FROM students WHERE class_name = ? ORDER BY name", (selected_class,)).fetchall()

    school_total = db.execute("SELECT COALESCE(SUM(amount), 0) FROM fees WHERE status = 'Paid'").fetchone()[0]

    class_total = 0
    if selected_class:
        class_total = db.execute("SELECT COALESCE(SUM(amount), 0) FROM fees WHERE class_name = ? AND status = 'Paid'", (selected_class,)).fetchone()[0]

    school_unpaid = db.execute("SELECT COALESCE(SUM(amount), 0) FROM fees WHERE status = 'Unpaid'").fetchone()[0]
    school_partial = db.execute("SELECT COALESCE(SUM(amount), 0) FROM fees WHERE status = 'Partial'").fetchone()[0]
    total_records = db.execute("SELECT COUNT(*) FROM fees").fetchone()[0]

    db.close()

    return render_template(
        "fees.html",
        fees=all_fees,
        students=students_list,
        classes=CLASS_LIST,
        selected_class=selected_class,
        school_total=school_total,
        class_total=class_total,
        school_unpaid=school_unpaid,
        school_partial=school_partial,
        total_records=total_records
    )


@app.route("/fees/add", methods=["POST"])
def add_fee():
    student_name = request.form.get("student_name", "").strip()
    amount_text = request.form.get("amount", "").strip()
    status = request.form.get("status", "").strip()

    if not student_name or not amount_text or not status:
        return redirect(url_for("fees"))

    try:
        amount = float(amount_text)
    except ValueError:
        return redirect(url_for("fees"))

    if amount < 0:
        return redirect(url_for("fees"))

    db = get_db()
    student = db.execute("SELECT class_name FROM students WHERE name = ? LIMIT 1", (student_name,)).fetchone()
    class_name = student["class_name"] if student else ""

    db.execute("INSERT INTO fees (student_name, class_name, amount, status) VALUES (?, ?, ?, ?)", (student_name, class_name, amount, status))
    db.commit()
    db.close()

    return redirect(url_for("fees", class_name=class_name))


# ================= ATTENDANCE =================

@app.route("/attendance")
def attendance():
    selected_class = request.args.get("class_name", "")
    db = get_db()
    attendance_list = db.execute("SELECT * FROM attendance ORDER BY id DESC").fetchall()
    db.close()
    return render_template("attendance.html", attendance=attendance_list, selected_class=selected_class, classes=CLASS_LIST)


# ================= EXAMS =================

@app.route("/exams")
def exams():
    selected_class = request.args.get("class_name", "")
    db = get_db()
    exams_list = db.execute("SELECT * FROM exams ORDER BY id DESC").fetchall()
    db.close()
    return render_template("exams.html", exams=exams_list, selected_class=selected_class, classes=CLASS_LIST)


# ================= RESULTS =================

@app.route("/results", methods=["GET", "POST"])
def results():
    selected_class = request.values.get("class_name", "")
    db = get_db()

    students_data = []
    if selected_class:
        students_data = db.execute("SELECT * FROM students WHERE class_name = ? ORDER BY name", (selected_class,)).fetchall()

    if request.method == "POST":
        action = request.form.get("action")

        if action == "delete":
            result_id = request.form.get("result_id")
            db.execute("DELETE FROM results WHERE id = ?", (result_id,))
            db.commit()
            db.close()
            return redirect(url_for("results", class_name=selected_class))

        elif action == "edit":
            result_id = request.form.get("result_id")
            student_name = request.form.get("student_name", "").strip()
            subject = request.form.get("subject", "").strip()
            marks = request.form.get("marks", "0")

            db.execute("UPDATE results SET student_name = ?, subject = ?, marks = ? WHERE id = ?", (student_name, subject, marks, result_id))
            db.commit()
            db.close()
            return redirect(url_for("results", class_name=selected_class))

        else:
            student_name = request.form.get("student_name", "").strip()
            subject = request.form.get("subject", "").strip()
            marks = request.form.get("marks", "0")

            db.execute("INSERT INTO results (student_name, class_name, subject, marks) VALUES (?, ?, ?, ?)", (student_name, selected_class, subject, marks))
            db.commit()
            db.close()
            return redirect(url_for("results", class_name=selected_class))

    raw_results = []
    if selected_class:
        raw_results = db.execute("SELECT * FROM results WHERE class_name = ? ORDER BY marks DESC", (selected_class,)).fetchall()

    student_averages = {}
    for result in raw_results:
        name = result["student_name"]
        if name not in student_averages:
            student_averages[name] = []
        student_averages[name].append(float(result["marks"]))

    average_map = {}
    for name, marks_list in student_averages.items():
        average_map[name] = round(sum(marks_list) / len(marks_list), 2)

    sorted_students = sorted(average_map.items(), key=lambda x: x[1], reverse=True)
    rank_map = {}
    for index, item in enumerate(sorted_students, start=1):
        rank_map[item[0]] = index

    results_data = []
    for result in raw_results:
        name = result["student_name"]
        marks = float(result["marks"])
        average = average_map[name]
        status = "Gudbay"
        if average < 50:
            status = "Haray"

        results_data.append({
            "id": result["id"],
            "student_name": name,
            "subject": result["subject"],
            "marks": marks,
            "percentage": marks,
            "average": average,
            "rank": rank_map[name],
            "status": status
        })

    db.close()

    return render_template("results.html", results=results_data, selected_class=selected_class, classes=CLASS_LIST, students=students_data)


# ================= LESSON PLAN =================

@app.route("/lesson-plan")
def lesson_plan():
    db = get_db()
    lesson_plans = db.execute("SELECT * FROM lesson_plans ORDER BY id DESC").fetchall()
    db.close()
    return render_template("lesson_plan.html", lesson_plans=lesson_plans, classes=CLASS_LIST)


# ================= USERS =================

@app.route("/users")
def users():
    db = get_db()
    users_list = db.execute("SELECT * FROM users ORDER BY id DESC").fetchall()
    db.close()
    return render_template("users.html", users=users_list)


# ================= ADMIN =================

@app.route("/admin")
def admin():
    return render_template("admin.html")


# ================= REPORTS =================

@app.route("/reports")
def reports():
    db = get_db()
    reports_list = db.execute("SELECT * FROM reports ORDER BY id DESC").fetchall()
    db.close()
    return render_template("reports.html", reports=reports_list)


# ================= CALENDAR =================

@app.route("/calendar")
def calendar():
    db = get_db()
    events = db.execute("SELECT * FROM calendar ORDER BY date").fetchall()
    db.close()
    return render_template("calendar.html", events=events)


# ================= ABOUT US =================

@app.route("/about")
def about():
    return render_template("about.html")


# ================= RUN =================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)