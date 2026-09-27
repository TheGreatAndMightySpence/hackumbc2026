import json
import os
import re
import sqlite3
import time
from functools import lru_cache
from pathlib import Path
from typing import Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
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


# Plan advice via Gemini
#   POST /api/ai/plan-advice {major, semesters, question} -> {answer}
#   semesters is the planner's course ids per semester, first to last. The server looks each one
#   up in the catalog, so Gemini sees titles, credits, difficulty, prerequisites and terms offered.
#   No semantic cache: every plan is different, so past answers rarely apply.

PLAN_MAX_SEMESTERS = 16
PLAN_DEFAULT_QUESTION = ("Review my plan. Is the workload balanced across semesters, are any semesters "
                         "too heavy, and what required courses am I still missing?")

class PlanAdviceRequest(BaseModel):
    major: Literal["Computer Science", "Information Systems"]
    semesters: list[list[str]] = Field(..., max_length=PLAN_MAX_SEMESTERS,
                                       description="Course ids in each semester, first to last.")
    question: str = Field("", max_length=1000, description="Empty asks for a general review.")

@app.post("/api/ai/plan-advice")
def plan_advice(req: PlanAdviceRequest):
    catalog = {c["course_id"]: c for c in query("SELECT * FROM course_catalog")}
    unknown = [cid for ids in req.semesters for cid in ids if cid not in catalog]
    if unknown:
        raise HTTPException(400, f"Unknown courses: {unknown}")

    plan = [{
        "semester": i + 1,
        "credits": sum(catalog[cid]["credits"] for cid in ids),
        "courses": [{
            "id": cid,
            "title": catalog[cid]["course_title"],
            "credits": catalog[cid]["credits"],
            "type": catalog[cid]["course_type"],
            "difficulty": catalog[cid]["difficulty_index"],
            "prerequisites": split_list(catalog[cid]["prerequisite_ids"]),
            "terms": split_list(catalog[cid]["typical_terms_offered"]),
        } for cid in ids],
    } for i, ids in enumerate(req.semesters)]

    placed = {cid for ids in req.semesters for cid in ids}
    missing_required = sorted(cid for cid, c in catalog.items()
                              if req.major in split_list(c["required_for_majors"]) and cid not in placed)

    system = (
        f"You are an academic advisor helping a UMBC {req.major} student plan their semesters. "
        "Below is the student's current plan: each semester's courses with credits, difficulty "
        "(1.0 gentle to 5.0 demanding), prerequisites and the terms each course is usually offered. "
        "A full-time load is about 15 credits; more than 19 needs an overload approval. "
        "Semester 1 is the student's first semester; assume semesters alternate Fall, Spring starting "
        "with Fall unless the student says otherwise.\n\n"
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


# Most asked questions
#   GET /api/top-questions/{major} -> the 10 most asked past questions for 'cs', 'info' or 'both'

@app.get("/api/top-questions/{major}")
def top_questions(major: Literal["cs", "info", "both"]):
    return redact_ids(past_responses.top_questions(major, limit=10))