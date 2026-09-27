import json
import os
import re
import sqlite3
import time
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator
from dotenv import load_dotenv
from google import genai
from google.genai import types
import past_responses

load_dotenv()
api_key = os.getenv("MY_API_KEY")
if not api_key:
    raise ValueError("API Key not found. Please check your .env file.")

MAJOR_SUBJECT = {"Computer Science": "CMSC", "Information Systems": "IS"}

# Helper Functions
def split_list(value):
    """'A|B|C' -> ['A','B','C'];  NULL (was 'Not Applicable') -> []"""
    return [] if value is None else [v.strip() for v in value.split("|")]

app = FastAPI()
DB_PATH = "umbc.db"

def query(sql, params=()):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/salary-by-year")
def salary_by_year():
    return query("""
        SELECT graduation_year AS year,
               ROUND(AVG(first_job_annual_salary_usd)) AS avg_salary,
               COUNT(*) AS graduates
        FROM alumni GROUP BY graduation_year ORDER BY graduation_year
    """)

@app.get("/api/internships-vs-salary")
def internships_vs_salary():
    return query("""
        SELECT internship_count AS internships,
               ROUND(AVG(first_job_annual_salary_usd)) AS avg_salary,
               COUNT(*) AS alumni
        FROM alumni
        WHERE first_job_annual_salary_usd IS NOT NULL
        GROUP BY internship_count ORDER BY internship_count
    """)

@app.get("/api/majors")
def majors():
    return query("SELECT DISTINCT major FROM alumni ORDER BY major")

@app.get("/api/salary-by-year/{major}")
def salary_by_year_for_major(major: str):
    return query("""
        SELECT graduation_year AS year,
               ROUND(AVG(first_job_annual_salary_usd)) AS avg_salary
        FROM alumni WHERE major = ?
        GROUP BY graduation_year ORDER BY graduation_year
    """, (major,))



#Course map api


@app.get("/api/course-map/{major}")
def course_map(major: str, electives: bool = False):
    catalog = {c["course_id"]: c for c in query("SELECT * FROM course_catalog")}

    # 1. Pick the courses: required for this major (+ optionally the major's electives)
    chosen = {
        cid for cid, c in catalog.items()
        if major in split_list(c["required_for_majors"])
        or (electives and c["course_type"] == "Elective"
            and c["subject"] == MAJOR_SUBJECT.get(major))
    }

    # 2. Pull in any prerequisite that isn't already on the map, so no arrow dangles
    todo = list(chosen)
    while todo:
        for group in split_list(catalog[todo.pop()]["prerequisite_ids"]):
            options = [o.strip() for o in group.split(" or ")]
            if not any(o in chosen for o in options):
                chosen.add(options[0])
                todo.append(options[0])

    # 3. Edges: prerequisite -> course.  "A or B" draws both, flagged as alternatives
    edges = []
    for cid in chosen:
        for group in split_list(catalog[cid]["prerequisite_ids"]):
            options = [o.strip() for o in group.split(" or ")]
            for o in options:
                if o in chosen:
                    edges.append({"id": f"{o}->{cid}", "source": o, "target": cid,
                                  "alternative": len(options) > 1})

    # 4. Earliest semester you could take it = length of the longest prerequisite chain
    memo = {}
    def semester(cid):
        if cid not in memo:
            groups = split_list(catalog[cid]["prerequisite_ids"])
            memo[cid] = 1 + max(
                (min(semester(o.strip()) for o in g.split(" or ") if o.strip() in chosen)
                 for g in groups), default=0)
        return memo[cid]

    nodes = [{
        "id": cid,
        "title": catalog[cid]["course_title"],
        "credits": catalog[cid]["credits"],
        "type": catalog[cid]["course_type"],
        "terms": split_list(catalog[cid]["typical_terms_offered"]),
        "semester": semester(cid),
        "difficulty": catalog[cid]["difficulty_index"],
    } for cid in sorted(chosen)]

    return {"nodes": nodes, "edges": edges}


# One course in detail: the catalog entry plus how students have done in it.
# The catalog has no description text, so the planner builds its "Show more" popup from this.
@app.get("/api/courses/{course_id}")
def course_detail(course_id: str):
    rows = query("SELECT * FROM course_catalog WHERE course_id = ?", (course_id,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"No course {course_id}")
    c = rows[0]

    # Finished attempts only: IP (in progress) has no outcome yet
    stats = query("""
        SELECT COUNT(*) AS attempts,
               ROUND(AVG(grade_points), 2) AS avg_grade_points,
               SUM(grade IN ('A','B','C','D')) AS passed,
               SUM(grade = 'W') AS withdrew
        FROM transcripts WHERE course_id = ? AND grade != 'IP'
    """, (course_id,))[0]
    attempts = stats["attempts"]

    return {
        "id": c["course_id"],
        "title": c["course_title"],
        "credits": c["credits"],
        "level": c["course_level"],
        "type": c["course_type"],
        "difficulty": c["difficulty_index"],
        "skills": split_list(c["skill_tags"]),
        "prerequisites": split_list(c["prerequisite_ids"]),  # each entry may read "A or B"
        "required_for": split_list(c["required_for_majors"]),
        "terms": split_list(c["typical_terms_offered"]),
        "attempts": attempts,
        "avg_grade_points": stats["avg_grade_points"],
        "pass_rate": round(stats["passed"] / attempts, 3) if attempts else None,
        "withdraw_rate": round(stats["withdrew"] / attempts, 3) if attempts else None,
    }



# FAQ api
#   Questions live in faq.json so they can be edited without touching code.
#   An empty "majors" list means the question applies to every major.

FAQ_PATH = Path("faq.json")

@app.get("/api/faq")
def faq(major: str | None = None):
    items = json.loads(FAQ_PATH.read_text(encoding="utf-8"))
    if major:
        items = [q for q in items if not q["majors"] or major in q["majors"]]
    return items



# General query api for the AI assistant
#   GET  /api/ai/schema -> tables, columns, descriptions, common values, gotchas
#   POST /api/ai/query  -> run one read-only SELECT, get rows back


AI_DEFAULT_LIMIT = 200
AI_MAX_LIMIT = 5000
AI_TIMEOUT_SECONDS = 5
AI_MAX_ENUM_VALUES = 25  # text columns with this many distinct values or fewer list them in the schema

# How the CSVs look once loaded into SQLite (differs from the CSV docs in data/)
AI_CONVENTIONS = [
    "SQLite dialect. Only a single SELECT (or WITH ... SELECT) statement is allowed.",
    "'Not Applicable' from the CSVs is stored as NULL. Use IS NULL / IS NOT NULL, never = 'Not Applicable'.",
    "Booleans are stored as integers 1 (TRUE) / 0 (FALSE), or NULL where not applicable.",
    "Pipe-delimited list columns (skill_tags, prerequisite_ids, required_for_majors, typical_terms_offered, "
    "role_skill_tags) are plain text like 'Python|SQL'. Match one item with "
    "'|' || col || '|' LIKE '%|Python|%'.",
    "campus_id (CID-NNNNNN) is the person key. A person is in students_current OR alumni, never both. "
    "transcripts and student_experience join on campus_id to either; employment_history is alumni only.",
    "course_id joins transcripts to course_catalog.",
    "Terms look like 'Fall 2023'; season order within a year is Spring, Summer, Fall. Dates are 'YYYY-MM-DD'.",
    "Grades are A B C D F W IP on a 4.0 scale; W and IP have NULL grade_points and are excluded from GPA.",
    "Money is whole nominal US dollars. The dataset's 'today' is 2026-09-15.",
]

_AI_ALLOWED_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION,
                       getattr(sqlite3, "SQLITE_RECURSIVE", 33)}

# Student IDs never leave the server through the AI: they're redacted from query results
# (so the model never sees them), from its answers and charts, and from cached answers.
# The model can still JOIN on campus_id; it just never gets the values back.
STUDENT_ID_PATTERN = re.compile(r"\bCID[\s_-]*\d+\b", re.IGNORECASE)
REDACTED_ID = "[student ID hidden]"

def redact_ids(value):
    """Replace every student ID in a string, or anywhere inside a list/dict, with REDACTED_ID."""
    if isinstance(value, str):
        return STUDENT_ID_PATTERN.sub(REDACTED_ID, value)
    if isinstance(value, list):
        return [redact_ids(v) for v in value]
    if isinstance(value, dict):
        return {k: redact_ids(v) for k, v in value.items()}
    return value

def connect_readonly():
    """Read-only file handle + an authorizer that rejects anything but reads."""
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.set_authorizer(lambda action, *_:
                        sqlite3.SQLITE_OK if action in _AI_ALLOWED_ACTIONS else sqlite3.SQLITE_DENY)
    return conn

def parse_table_doc(md_path):
    """Pull the summary line, field descriptions and gotchas out of a data/*.md file."""
    if not md_path.exists():
        return "", {}, []
    text = md_path.read_text(encoding="utf-8")
    summary = next((l.strip() for l in text.splitlines()[1:] if l.strip() and not l.startswith("#")), "")
    fields = {m[1]: m[2].strip()
              for m in re.finditer(r"^\| `(\w+)` \| [^|]+ \| (.+?) \|$", text, re.M)}
    gotchas = []
    if "## Gotchas" in text:
        section = text.split("## Gotchas", 1)[1].split("\n## ", 1)[0]
        gotchas = [l[2:].strip() for l in section.splitlines() if l.startswith("- ")]
    return summary, fields, gotchas

@lru_cache(maxsize=1)
def build_schema():
    # Trusted internal SQL, so no authorizer (it would block pragma_table_info)
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    tables = {}
    table_names = [t for (t,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for table in table_names:
        summary, docs, gotchas = parse_table_doc(Path("data") / f"{table}.md")
        columns = []
        for _, name, col_type, *_ in conn.execute(f'SELECT * FROM pragma_table_info("{table}")').fetchall():
            col = {"name": name, "type": col_type, "description": docs.get(name, "")}
            if col_type == "TEXT":
                values = conn.execute(
                    f'SELECT "{name}" FROM "{table}" WHERE "{name}" IS NOT NULL '
                    f'GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT {AI_MAX_ENUM_VALUES + 1}').fetchall()
                if len(values) <= AI_MAX_ENUM_VALUES:
                    col["values"] = [v for (v,) in values]
            columns.append(col)
        tables[table] = {
            "description": summary,
            "row_count": conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0],
            "columns": columns,
            "gotchas": gotchas,
        }
    conn.close()
    return {"conventions": AI_CONVENTIONS, "tables": tables}

@app.get("/api/ai/schema")
def ai_schema():
    """Everything the assistant needs to write SQL: tables, columns, types,
    descriptions, low-cardinality values, gotchas and storage conventions."""
    return build_schema()

class AIQuery(BaseModel):
    sql: str = Field(..., description="One SQLite SELECT statement. Use ? placeholders for values.")
    params: list = Field(default_factory=list, description="Values bound to ? placeholders, in order.")
    limit: int = Field(AI_DEFAULT_LIMIT, ge=1, le=AI_MAX_LIMIT, description="Maximum rows returned.")

@app.post("/api/ai/query")
def ai_query(req: AIQuery):
    """Run one read-only SQL query. Errors come back as 400 with SQLite's message
    so the assistant can fix its SQL and retry."""
    conn = connect_readonly()
    deadline = time.monotonic() + AI_TIMEOUT_SECONDS
    conn.set_progress_handler(lambda: time.monotonic() > deadline, 10_000)
    try:
        cur = conn.execute(req.sql, req.params)
        if cur.description is None:
            raise HTTPException(400, "Query returned no result set; only SELECT statements are supported.")
        columns = [d[0] for d in cur.description]
        rows = cur.fetchmany(req.limit + 1)
    except sqlite3.Error as e:
        msg = str(e)
        if msg == "interrupted":
            msg = f"Query exceeded {AI_TIMEOUT_SECONDS}s time limit; add filters or aggregate instead."
        elif "not authorized" in msg:
            msg = "Only read-only SELECT queries are allowed."
        raise HTTPException(400, msg)
    finally:
        conn.close()

    truncated = len(rows) > req.limit
    rows = rows[:req.limit]
    return {
        "columns": columns,
        "rows": redact_ids([dict(zip(columns, r)) for r in rows]),
        "row_count": len(rows),
        "truncated": truncated,
    }



# Natural-language answers via Gemini
#   POST /api/ai/ask {question} -> {answer, charts}
#   The key stays on the server; Gemini writes SQL, we run it read-only, Gemini explains the result.
#   charts is a list of {type, title, x_key, x_label, y_keys, y_label, y_format, data, sql}
#   where data is the query's rows, ready to pass straight to a Recharts chart's data prop.

gemini = genai.Client(api_key=api_key)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")  # free tier on gemini-3.8-flash is only 5 req/min

def run_sql(sql: str) -> dict:
    """Run one read-only SQLite SELECT statement against the UMBC database and return its rows.
    On error, returns {"error": message}; fix the SQL and try again."""
    try:
        return ai_query(AIQuery(sql=sql))
    except HTTPException as e:
        return {"error": e.detail}

CHART_TYPES = {"bar", "line", "scatter"}
CHART_Y_FORMATS = {"dollars", "number", "percent"}
CHART_MAX_SERIES = 4
CHART_MAX_POINTS = 500

def chart_tool(charts: list):
    """A make_chart tool for one request; every chart it builds is appended to `charts`."""
    def make_chart(chart_type: str, title: str, sql: str, x_key: str, y_keys: list[str],
                   x_label: str, y_label: str, y_format: str) -> dict:
        """Draw a chart for the student from one read-only SQLite SELECT statement.
        Each row of the result becomes one point; x_key and every y_keys entry must be column
        names (aliases) in the result. chart_type is 'bar' (categories or buckets), 'line'
        (a trend over an ordered x like years) or 'scatter' (one point per person, exactly one y key).
        y_keys lists 1-4 numeric columns, one series each. y_format is 'dollars', 'number' or
        'percent' (percent values are 0-100). Returns the rows so you can describe them, or
        {"error": message}; fix the problem and call again."""
        if chart_type not in CHART_TYPES:
            return {"error": f"chart_type must be one of {sorted(CHART_TYPES)}."}
        if y_format not in CHART_Y_FORMATS:
            return {"error": f"y_format must be one of {sorted(CHART_Y_FORMATS)}."}
        if not 1 <= len(y_keys) <= CHART_MAX_SERIES:
            return {"error": f"Give between 1 and {CHART_MAX_SERIES} y_keys."}
        if chart_type == "scatter" and len(y_keys) != 1:
            return {"error": "A scatter chart takes exactly one y key."}
        try:
            result = ai_query(AIQuery(sql=sql, limit=CHART_MAX_POINTS))
        except HTTPException as e:
            return {"error": e.detail}
        missing = [k for k in [x_key, *y_keys] if k not in result["columns"]]
        if missing:
            return {"error": f"Columns {missing} are not in the result; it has {result['columns']}."}
        if not result["rows"]:
            return {"error": "The query returned no rows, so there is nothing to chart."}
        charts.append({
            "type": chart_type, "title": title, "x_key": x_key, "x_label": x_label,
            "y_keys": y_keys, "y_label": y_label, "y_format": y_format,
            "data": result["rows"], "sql": sql,
        })
        return {"charted": True, "row_count": result["row_count"],
                "truncated": result["truncated"], "rows": result["rows"][:50]}
    return make_chart

class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    major: Literal["cs", "info", "both"] = Field(
        "both", description="The page the question was asked from; assumed when the question names no major.")

MAJOR_FULL_NAMES = {"cs": "Computer Science", "info": "Information Systems",
                    "both": "both Computer Science and Information Systems"}

@app.post("/api/ai/ask")
def ai_ask(req: AskRequest):
    # Semantic cache: simplify the question, then reuse the answer to a sufficiently
    # similar past simplified question. If simplifying or embedding fails, just skip
    # the cache rather than failing the request.
    try:
        simplified, major = past_responses.simplify(gemini, GEMINI_MODEL, req.question, req.major)
        embedding = past_responses.embed(gemini, simplified)
        hit = past_responses.find_similar(simplified, major, embedding)
    except Exception as e:
        print(f"Semantic cache unavailable: {e}")
        embedding, hit = None, None
    if hit:
        past_responses.record_hit(hit["id"])
        return {"answer": redact_ids(hit["answer"]), "charts": redact_ids(hit["charts"]), "cached": True,
                "matched_question": hit["question"], "similarity": hit["similarity"]}

    system = (
        "You answer questions from UMBC students about the Computer Science and Information Systems programs, courses and career outcomes. "
        f"The student is asking from the {MAJOR_FULL_NAMES[req.major]} page. If the question doesn't name "
        "a major, assume it is about that page's major(s): filter on major, and when the page covers both, "
        "compare the two majors side by side. If the question names a major, answer about that one instead. "
        "Use the run_sql tool to look up facts in the database instead of guessing. "
        "Answer in a few plain sentences with concrete numbers; don't show SQL. "
        "If the data can't answer the question, say so. "
        "Never reveal student IDs (campus_id) or anything identifying an individual student; "
        "answer with aggregates instead.\n\n"
        "When the student asks for a graph, chart, plot or visualization, or asks how one measure "
        "varies across many groups (e.g. average salary per GPA, per year, per internship count), "
        "call make_chart so the answer comes with a chart, then describe what it shows in the text. "
        "Group continuous values into buckets before charting (e.g. ROUND(final_gpa * 2) / 2 AS gpa "
        "for half-point GPA bands) and order rows by the x column. Give columns short snake_case "
        "aliases. Don't say you can't draw charts; the app renders whatever make_chart returns.\n\n"
        "Database schema:\n" + json.dumps(build_schema())
    )
    charts = []
    try:
        chat = gemini.chats.create(
            model=GEMINI_MODEL,
            config=types.GenerateContentConfig(system_instruction=system,
                                               tools=[run_sql, chart_tool(charts)]),
        )
        response = chat.send_message(req.question)  # SDK calls the tools for Gemini as needed
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")
    if not response.text:
        return {"answer": "Sorry, I couldn't come up with an answer.", "charts": charts, "cached": False}
    answer, charts = redact_ids(response.text), redact_ids(charts)
    if embedding is not None:
        past_responses.save_response(req.question, simplified, major, answer, embedding, charts)
    return {"answer": answer, "charts": charts, "cached": False}


# Course results from the planner
#   POST /api/plan/progress {results} -> {credits_earned, credits_transferred, credits_failed, gpa}
#   results lists what happened in each attempt at a course, e.g.
#   {"course_id": "CMSC201", "attempt": 1, "status": "failed"} then
#   {"course_id": "CMSC201", "attempt": 2, "status": "passed", "grade": "B"}.
#   status is passed (with a grade), transferred or failed; attempts not listed are just planned.
#   GPA uses the transcripts' 4.0 scale: every graded attempt counts (a fail as an F),
#   transfer credit doesn't.

GRADE_POINTS = {"A": 4.0, "B": 3.0, "C": 2.0, "D": 1.0}

class CourseResult(BaseModel):
    course_id: str
    attempt: int = Field(1, ge=1, description="1 for the first try, 2 for the first retake, ...")
    status: Literal["passed", "transferred", "failed"]
    grade: Literal["A", "B", "C", "D"] | None = Field(None, description="Only for passed courses.")

    @model_validator(mode="after")
    def grade_only_when_passed(self):
        if (self.status == "passed") != (self.grade is not None):
            raise ValueError("A passed course needs a grade (A-D); transferred and failed take none.")
        return self

class PlanProgressRequest(BaseModel):
    results: list[CourseResult] = Field(default_factory=list, description="One entry per attempt with a result.")

@app.post("/api/plan/progress")
def plan_progress(req: PlanProgressRequest):
    credits = {c["course_id"]: c["credits"] for c in query("SELECT course_id, credits FROM course_catalog")}
    unknown = [r.course_id for r in req.results if r.course_id not in credits]
    if unknown:
        raise HTTPException(400, f"Unknown courses: {unknown}")

    def total(status):
        return sum(credits[r.course_id] for r in req.results if r.status == status)

    graded = [(credits[r.course_id], GRADE_POINTS.get(r.grade, 0.0))  # failed counts as an F
              for r in req.results if r.status != "transferred"]
    graded_credits = sum(cr for cr, _ in graded)
    return {
        "credits_earned": total("passed") + total("transferred"),
        "credits_transferred": total("transferred"),
        "credits_failed": total("failed"),
        "gpa": round(sum(cr * pts for cr, pts in graded) / graded_credits, 2) if graded_credits else None,
    }


# Plan advice via Gemini
#   POST /api/ai/plan-advice {major, semesters, terms, results, question} -> {answer}
#   semesters is the planner's course ids per semester, first to last, and terms is each one's
#   term ("Fall 2027"); older clients leave terms out. A retake repeats its course id in a later
#   semester. results is the same list /api/plan/progress takes. The server looks each course
#   up in the catalog, so Gemini sees titles, credits, difficulty, prerequisites and terms offered.
#   No semantic cache: every plan is different, so past answers rarely apply.

PLAN_MAX_SEMESTERS = 16
PLAN_DEFAULT_QUESTION = ("Review my plan. Is the workload balanced across semesters, are any semesters "
                         "too heavy, and what required courses am I still missing?")

class PlanAdviceRequest(BaseModel):
    major: Literal["Computer Science", "Information Systems"]
    semesters: list[list[str]] = Field(..., max_length=PLAN_MAX_SEMESTERS,
                                       description="Course ids in each semester, first to last.")
    terms: list[str] = Field(default_factory=list, max_length=PLAN_MAX_SEMESTERS,
                             description='Each semester\'s term, e.g. "Fall 2027". Empty if unknown.')
    results: list[CourseResult] = Field(default_factory=list, description="One entry per attempt with a result.")
    question: str = Field("", max_length=1000, description="Empty asks for a general review.")

def describe_plan(catalog, semesters, terms, results):
    """The plan as Gemini sees it: each semester's courses looked up in the catalog, with results.
    Semesters run first to last, so the nth time a course shows up is its nth attempt."""
    results = {(r.course_id, r.attempt): r for r in results}
    attempts = {}
    has_terms = len(terms) == len(semesters)
    plan = []
    for i, ids in enumerate(semesters):
        courses = []
        for cid in ids:
            attempts[cid] = attempts.get(cid, 0) + 1
            result = results.get((cid, attempts[cid]))
            courses.append({
                "id": cid,
                **({"attempt": attempts[cid]} if attempts[cid] > 1 else {}),
                "title": catalog[cid]["course_title"],
                "credits": catalog[cid]["credits"],
                "type": catalog[cid]["course_type"],
                "difficulty": catalog[cid]["difficulty_index"],
                "prerequisites": split_list(catalog[cid]["prerequisite_ids"]),
                "terms": split_list(catalog[cid]["typical_terms_offered"]),
                **({"result": result.model_dump(exclude={"course_id", "attempt"}, exclude_none=True)}
                   if result else {}),
            })
        plan.append({
            "semester": i + 1,
            **({"term": terms[i]} if has_terms else {}),
            "credits": sum(catalog[cid]["credits"] for cid in ids),
            "courses": courses,
        })
    return plan

@app.post("/api/ai/plan-advice")
def plan_advice(req: PlanAdviceRequest):
    catalog = {c["course_id"]: c for c in query("SELECT * FROM course_catalog")}
    unknown = [cid for ids in req.semesters for cid in ids if cid not in catalog]
    if unknown:
        raise HTTPException(400, f"Unknown courses: {unknown}")

    has_terms = len(req.terms) == len(req.semesters)
    plan = describe_plan(catalog, req.semesters, req.terms, req.results)

    # A course counts toward what's required once some attempt at it isn't a fail
    failed = {(r.course_id, r.attempt) for r in req.results if r.status == "failed"}
    attempts = {}
    placed = set()
    for cid in (cid for ids in req.semesters for cid in ids):
        attempts[cid] = attempts.get(cid, 0) + 1
        if (cid, attempts[cid]) not in failed:
            placed.add(cid)
    missing_required = sorted(cid for cid, c in catalog.items()
                              if req.major in split_list(c["required_for_majors"]) and cid not in placed)

    system = (
        f"You are an academic advisor helping a UMBC {req.major} student plan their semesters. "
        "Below is the student's current plan: each semester's courses with credits, difficulty "
        "(1.0 gentle to 5.0 demanding), prerequisites and the terms each course is usually offered. "
        "A full-time load is about 15 credits; more than 19 needs an overload approval. "
        + ("Each semester is labeled with the term the student plans to take it (e.g. Fall 2027).\n\n"
           if has_terms else
           "Semester 1 is the student's first semester; assume semesters alternate Fall, Summer, Spring starting "
           "with Fall unless the student says otherwise.\n\n") +
        "Courses with a result are already done: passed (with the letter grade), transferred in from another "
        "school, or failed. A failed course must be retaken in a later semester before anything that needs it; "
        "a retake shows up again with its attempt number. A student who has failed a course twice needs "
        "permission to take it a third time. Courses with no result are still planned.\n\n"
        "Base your advice on the plan. Point out semesters that are too heavy or too light, hard "
        "courses stacked together, courses placed in a term they aren't usually offered, and required "
        "courses that aren't in the plan yet. Suggest concrete moves (which course to which semester). "
        "Use the run_sql tool when past student outcomes would help (e.g. pass rates or average grades "
        "for a course from transcripts). Answer in short paragraphs or a bulleted list; don't show SQL. "
        "Never reveal student IDs (campus_id) or anything identifying an individual student.\n\n"
        "Current plan:\n" + json.dumps(plan) + "\n\n"
        f"Required {req.major} courses not in the plan yet: " + json.dumps(missing_required) + "\n\n"
        "Database schema:\n" + json.dumps(build_schema())
    )
    try:
        chat = gemini.chats.create(
            model=GEMINI_MODEL,
            config=types.GenerateContentConfig(system_instruction=system, tools=[run_sql]),
        )
        response = chat.send_message(req.question.strip() or PLAN_DEFAULT_QUESTION)
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")
    return {"answer": redact_ids(response.text or "Sorry, I couldn't come up with any advice.")}


# Recommended schedule via Gemini
#   POST /api/ai/plan-schedule {major, semesters, terms, results, note}
#     -> {semesters, terms, added, explanation, adjusted, unplaced}
#   Keeps the student's plan as it is and adds what's left: every required course not in it yet
#   (a retake if it was failed) and electives up to PLAN_ELECTIVES. New courses go into semesters
#   that haven't started, then into new Fall/Spring semesters after the last one.
#   Gemini picks where they go and checks its picks with the submit_schedule tool, which applies
#   the planner's rules (planLogic.ts): prerequisites in an earlier semester, offered that season,
#   a retake after the semester it was failed in, and the credit limit. Anything it gets wrong or
#   leaves out, a simple scheduler fills in, so the answer is always a plan the planner accepts.
#   semesters comes back as the planner's attempt keys ("CMSC201", "CMSC201#2" for a retake),
#   terms as "Fall 2027"; added lists the keys that are new. note is the student's preferences.

PLAN_CREDIT_LIMIT = 19  # more needs an overload approval
PLAN_TARGET_LOAD = 15  # a full-time semester; the fallback scheduler fills up to this
# Electives the recommended plan includes. The catalog doesn't say how many each major needs.
PLAN_ELECTIVES = {"Computer Science": 5, "Information Systems": 4}
PLAN_PERMISSION_ATTEMPT = 3  # failing twice means the next attempt needs permission
SEASON_START_MONTH = {"Spring": 1, "Summer": 6, "Fall": 8}  # as in planLogic.ts
PLAN_SCHEDULE_DEFAULT_NOTE = "Make me a recommended schedule."

# Terms are (season, year) here and "Fall 2027" in the API
def parse_term(label):
    m = re.fullmatch(r"(Spring|Summer|Fall) (\d{4})", label.strip())
    if not m:
        raise HTTPException(400, f'Terms look like "Fall 2027", not "{label}".')
    return m[1], int(m[2])

def term_label(t):
    return f"{t[0]} {t[1]}"

def first_term(today):
    """Same as the planner: the coming Fall until August, then the coming Spring."""
    return ("Fall", today.year) if today.month <= 7 else ("Spring", today.year + 1)

def next_term(t):
    """The regular term after t, skipping Summer: Fall -> Spring -> Fall."""
    return ("Spring", t[1] + 1) if t[0] == "Fall" else ("Fall", t[1])

def term_started(t, today):
    return date(t[1], SEASON_START_MONTH[t[0]], 1) <= today

def attempt_key(cid, attempt):
    """The planner's key for one attempt: "CMSC201", then "CMSC201#2" for the first retake."""
    return cid if attempt == 1 else f"{cid}#{attempt}"

class ScheduleRules:
    """Everything fixed while scheduling one request: the major's courses (the planner's course
    map, so every course we add is one the planner can show) and the student's plan so far."""

    def __init__(self, req, today):
        self.major = req.major
        self.today = today
        self.catalog = {c["course_id"]: c for c in query("SELECT * FROM course_catalog")}
        self.courses = {n["id"]: n for n in course_map(req.major, electives=True)["nodes"]}
        unknown = [cid for ids in req.semesters for cid in ids if cid not in self.courses]
        if unknown:
            raise HTTPException(400, f"Not in the {req.major} course list: {unknown}")
        if len(req.terms) != len(req.semesters):
            raise HTTPException(400, "Give one term per semester.")

        # Each group is one course or "A or B"; like the planner, only options on the map count
        self.prereqs = {cid: [[o.strip() for o in g.split(" or ") if o.strip() in self.courses]
                              for g in split_list(self.catalog[cid]["prerequisite_ids"])]
                        for cid in self.courses}
        self.required = [cid for cid in self.courses
                         if self.major in split_list(self.catalog[cid]["required_for_majors"])]
        # Electives that unlock early come first when the fallback scheduler picks
        self.electives = sorted((cid for cid, c in self.courses.items() if c["type"] == "Elective"),
                                key=lambda cid: (self.courses[cid]["semester"], cid))

        # Length of the longest chain of courses waiting on each one: schedule long chains first
        dependents = {cid: [d for d in self.courses if any(cid in g for g in self.prereqs[d])]
                      for cid in self.courses}
        self.depth = {}
        def depth(cid):
            if cid not in self.depth:
                self.depth[cid] = 1 + max((depth(d) for d in dependents[cid]), default=0)
            return self.depth[cid]
        for cid in self.courses:
            depth(cid)

        # The plan so far: (course id, attempt, failed?) per semester
        failed = {(r.course_id, r.attempt) for r in req.results if r.status == "failed"}
        attempts = {}
        self.semesters = []
        for ids in req.semesters:
            semester = []
            for cid in ids:
                attempts[cid] = attempts.get(cid, 0) + 1
                semester.append((cid, attempts[cid], (cid, attempts[cid]) in failed))
            self.semesters.append(semester)
        self.terms = [parse_term(t) for t in req.terms]
        self.passing = {cid for s in self.semesters for cid, _, f in s if not f}  # not failed
        self.failures = {cid: sum(f for s in self.semesters for c, _, f in s if c == cid)
                         for cid in {c for s in self.semesters for c, _, _ in s}}

        # New semesters follow the last one, but never in a term that's already begun
        t = next_term(self.terms[-1]) if self.terms else first_term(today)
        while term_started(t, today):
            t = next_term(t)
        self.new_terms = [t]
        while len(self.terms) + len(self.new_terms) < PLAN_MAX_SEMESTERS:
            self.new_terms.append(next_term(self.new_terms[-1]))

    def course_info(self, cid):
        c = self.courses[cid]
        return {"id": cid, "title": c["title"], "credits": c["credits"], "difficulty": c["difficulty"],
                "prerequisites": [" or ".join(g) for g in self.prereqs[cid] if g], "terms": c["terms"]}

def build_schedule(rules, proposal, fill):
    """Add `proposal` (course ids to add to each semester, semester 1 first) to the student's plan.
    Additions that break a rule are left out and listed in `skipped`. With fill, a simple scheduler
    then adds what's still missing, semester by semester up to PLAN_TARGET_LOAD credits: required
    courses first (longest prerequisite chains first), then electives."""
    semesters = [list(s) for s in rules.semesters]
    terms = list(rules.terms)
    skipped, added = [], []

    def load(i):
        return sum(rules.courses[c]["credits"] for c, _, _ in semesters[i])

    def add(cid, i):
        """Put cid in semester i if the rules allow; otherwise return why not."""
        while len(semesters) <= i:  # a new semester
            terms.append(rules.new_terms[len(semesters) - len(rules.semesters)])
            semesters.append([])
        where = f"{cid} in semester {i + 1} ({term_label(terms[i])})"
        if cid not in rules.courses:
            return f"{cid} isn't in the {rules.major} course list."
        earlier = [j for j, s in enumerate(semesters) for c, _, f in s if c == cid]
        if any(not f for s in semesters for c, _, f in s if c == cid):
            return f"{cid} is already in the plan."
        if term_started(terms[i], rules.today):
            return f"{where}: that semester has already started; only add to semesters that haven't."
        course = rules.courses[cid]
        if course["terms"] and terms[i][0] not in course["terms"]:
            return f"{where}: it's only offered in {', '.join(course['terms'])}."
        done = {c for s in semesters[:i] for c, _, f in s if not f}
        missing = [" or ".join(g) for g in rules.prereqs[cid] if g and not any(o in done for o in g)]
        if missing:
            return f"{where}: needs {', '.join(missing)} in an earlier semester."
        if earlier and max(earlier) >= i:
            return f"{where}: a retake has to come after the semester it was failed in."
        if load(i) + course["credits"] > PLAN_CREDIT_LIMIT:
            return (f"{where}: that semester would have {load(i) + course['credits']} credits; "
                    f"the limit is {PLAN_CREDIT_LIMIT}.")
        semesters[i].append((cid, len(earlier) + 1, False))
        added.append(attempt_key(cid, len(earlier) + 1))
        return None

    def still_missing():
        have = {c for s in semesters for c, _, f in s if not f}
        required = sorted((c for c in rules.required if c not in have), key=lambda c: (-rules.depth[c], c))
        return required, max(0, PLAN_ELECTIVES[rules.major] - sum(c in have for c in rules.electives))

    def fits(cid, i):  # under a full load, or the first course in an empty semester
        return i >= len(semesters) or not semesters[i] or load(i) + rules.courses[cid]["credits"] <= PLAN_TARGET_LOAD

    if len(proposal) > PLAN_MAX_SEMESTERS:
        skipped.append(f"The plan can have at most {PLAN_MAX_SEMESTERS} semesters.")
    for i, ids in enumerate(proposal[:PLAN_MAX_SEMESTERS]):
        for cid in ids:
            # Tolerate "cmsc 341" and retake keys like "CMSC201#2"
            problem = add(re.sub(r"\s+", "", cid).upper().split("#")[0], i)
            if problem:
                skipped.append(problem)

    proposed = len(added)
    if fill:
        for i in range(PLAN_MAX_SEMESTERS):
            required, electives = still_missing()
            if not required and not electives:
                break
            for cid in required:
                if fits(cid, i):
                    add(cid, i)
            for cid in rules.electives:
                if electives and fits(cid, i) and add(cid, i) is None:
                    electives -= 1

    # New semesters nothing landed in don't need to be in the plan
    while len(semesters) > len(rules.semesters) and not semesters[-1]:
        semesters.pop()
        terms.pop()

    required, electives = still_missing()
    return {
        "semesters": [[attempt_key(c, a) for c, a, _ in s] for s in semesters],
        "terms": [term_label(t) for t in terms],
        "added": added,
        "skipped": skipped,
        "filled": added[proposed:],  # what the fallback scheduler added
        "unplaced": required,
        "electives_missing": electives,
    }

class PlanScheduleRequest(BaseModel):
    major: Literal["Computer Science", "Information Systems"]
    semesters: list[list[str]] = Field(..., max_length=PLAN_MAX_SEMESTERS,
                                       description="Course ids in each semester, first to last.")
    terms: list[str] = Field(..., max_length=PLAN_MAX_SEMESTERS,
                             description='Each semester\'s term, e.g. "Fall 2027".')
    results: list[CourseResult] = Field(default_factory=list, description="One entry per attempt with a result.")
    note: str = Field("", max_length=1000, description="The student's preferences, e.g. 'I like AI, keep it light'.")

@app.post("/api/ai/plan-schedule")
def plan_schedule(req: PlanScheduleRequest):
    rules = ScheduleRules(req, date.today())
    start = build_schedule(rules, [], fill=False)  # the plan as it is
    if not start["unplaced"] and not start["electives_missing"]:
        return {"semesters": start["semesters"], "terms": start["terms"], "added": [], "adjusted": False,
                "unplaced": [], "explanation": "Your plan already has every required course and enough "
                                               "electives, so there's nothing to add."}

    plan = describe_plan(rules.catalog, req.semesters, req.terms, req.results)
    for semester, t in zip(plan, rules.terms):
        semester["can_add_courses"] = not term_started(t, rules.today)
    must_add = []
    for cid in start["unplaced"]:
        fails = rules.failures.get(cid, 0)
        must_add.append({**rules.course_info(cid),
                         **({"retake": True} if fails else {}),
                         **({"needs_permission": True} if fails + 1 >= PLAN_PERMISSION_ATTEMPT else {})})
    elective_options = [rules.course_info(cid) for cid in rules.electives if cid not in rules.passing]
    new_semesters = [{"semester": len(rules.terms) + i + 1, "term": term_label(t)}
                     for i, t in enumerate(rules.new_terms)]

    submitted = []  # every schedule Gemini submits; the last one is its answer
    def submit_schedule(semesters: list[list[str]]) -> dict:
        """Check a schedule. semesters lists the course ids to ADD to each semester, semester 1
        first: one list per semester, counting the student's current semesters, so pass [] for
        semesters you add nothing to. Lists past the current plan are new semesters, with the terms
        under 'New semesters'. Returns {"ok": true} when the schedule follows every rule, otherwise
        {"ok": false, "problems": [...]}; fix every problem and submit the whole schedule again."""
        submitted.append(semesters)
        result = build_schedule(rules, semesters, fill=False)
        problems = result["skipped"]
        if result["unplaced"]:
            problems.append(f"Still missing required courses: {', '.join(result['unplaced'])}.")
        if result["electives_missing"]:
            problems.append(f"Add {result['electives_missing']} more elective(s).")
        if not problems:
            return {"ok": True}
        return {"ok": False, "problems": problems,
                "credits_per_semester": [sum(rules.courses[k.split("#")[0]]["credits"] for k in s)
                                         for s in result["semesters"]]}

    have = sum(cid in rules.passing for cid in rules.electives)
    system = (
        f"You are an academic advisor building a recommended semester schedule for a UMBC {req.major} "
        "student. Keep every course already in their plan where it is and add what they still need: "
        "every course under 'Must add', plus electives from 'Elective options' until the plan has "
        f"{PLAN_ELECTIVES[req.major]} electives (it has {have} now). Only add more electives if the "
        "student asks. Pick electives that fit what the student says they're interested in.\n\n"
        "Rules:\n"
        "- Only add courses to current semesters marked can_add_courses, and to new semesters after them.\n"
        "- A course goes in a semester after all its prerequisites (for 'A or B', either one). A failed "
        "course's retake goes after the semester it was failed in, and courses that need it after the retake.\n"
        "- A course only goes in a semester whose season is one of its terms.\n"
        f"- At most {PLAN_CREDIT_LIMIT} credits in a semester. Aim for about {PLAN_TARGET_LOAD}, spread hard "
        "courses (difficulty 1.0 gentle to 5.0 demanding) so they don't stack up, and finish in as few "
        "semesters as that allows. Follow the student's preferences where the rules allow.\n\n"
        "Call submit_schedule with the courses to add. It checks the schedule against these rules; fix "
        "every problem it lists and submit again until it returns ok. Then explain the schedule to the "
        "student in a short bulleted list: what went where and why, and anything to watch for (a heavy "
        "semester, a retake that needs permission). Don't mention the tool or show JSON.\n\n"
        "Current plan:\n" + json.dumps(plan) + "\n\n"
        "Must add:\n" + json.dumps(must_add) + "\n\n"
        "Elective options:\n" + json.dumps(elective_options) + "\n\n"
        "New semesters:\n" + json.dumps(new_semesters)
    )
    explanation = None
    try:
        chat = gemini.chats.create(
            model=GEMINI_MODEL,
            config=types.GenerateContentConfig(system_instruction=system, tools=[submit_schedule]),
        )
        explanation = chat.send_message(req.note.strip() or PLAN_SCHEDULE_DEFAULT_NOTE).text
    except Exception as e:
        print(f"Gemini schedule request failed, using the fallback scheduler: {e}")

    # Gemini's last schedule, with any rule-breaking picks dropped and anything missing filled in
    result = build_schedule(rules, submitted[-1] if submitted else [], fill=True)
    if not submitted or not explanation:
        explanation = ("The AI advisor didn't finish this one, so the planner filled in the rest: required "
                       "courses first, as early as their prerequisites allow, then electives, at about "
                       f"{PLAN_TARGET_LOAD} credits a semester.")
    return {
        "semesters": result["semesters"],
        "terms": result["terms"],
        "added": result["added"],
        "explanation": redact_ids(explanation),
        "adjusted": bool(submitted) and bool(result["skipped"] or result["filled"]),
        "unplaced": result["unplaced"],  # required courses that didn't fit in PLAN_MAX_SEMESTERS
    }


# Most asked questions
#   GET /api/top-questions/{major} -> the 10 most asked past questions for 'cs', 'info' or 'both'

@app.get("/api/top-questions/{major}")
def top_questions(major: Literal["cs", "info", "both"]):
    return redact_ids(past_responses.top_questions(major, limit=10))