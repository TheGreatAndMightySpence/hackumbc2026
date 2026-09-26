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
    } for cid in sorted(chosen)]

    return {"nodes": nodes, "edges": edges}



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
        "rows": [dict(zip(columns, r)) for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }



# Natural-language answers via Gemini
#   POST /api/ai/ask {question} -> {answer}
#   The key stays on the server; Gemini writes SQL, we run it read-only, Gemini explains the result.

gemini = genai.Client(api_key=api_key)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")  # free tier on gemini-3.8-flash is only 5 req/min

def run_sql(sql: str) -> dict:
    """Run one read-only SQLite SELECT statement against the UMBC database and return its rows.
    On error, returns {"error": message}; fix the SQL and try again."""
    try:
        return ai_query(AIQuery(sql=sql))
    except HTTPException as e:
        return {"error": e.detail}

class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)

@app.post("/api/ai/ask")
def ai_ask(req: AskRequest):
    # Semantic cache: simplify the question, then reuse the answer to a sufficiently
    # similar past simplified question. If simplifying or embedding fails, just skip
    # the cache rather than failing the request.
    try:
        simplified, major = past_responses.simplify(gemini, GEMINI_MODEL, req.question)
        embedding = past_responses.embed(gemini, simplified)
        hit = past_responses.find_similar(simplified, embedding)
    except Exception as e:
        print(f"Semantic cache unavailable: {e}")
        embedding, hit = None, None
    if hit:
        past_responses.record_hit(hit["id"])
        return {"answer": hit["answer"], "cached": True,
                "matched_question": hit["question"], "similarity": hit["similarity"]}

    system = (
        "You answer questions from UMBC students about their program, courses and career outcomes. "
        "Use the run_sql tool to look up facts in the database instead of guessing. "
        "Answer in a few plain sentences with concrete numbers; don't show SQL. "
        "If the data can't answer the question, say so.\n\n"
        "Database schema:\n" + json.dumps(build_schema())
    )
    try:
        chat = gemini.chats.create(
            model=GEMINI_MODEL,
            config=types.GenerateContentConfig(system_instruction=system, tools=[run_sql]),
        )
        response = chat.send_message(req.question)  # SDK calls run_sql for Gemini as needed
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")
    if not response.text:
        return {"answer": "Sorry, I couldn't come up with an answer.", "cached": False}
    if embedding is not None:
        past_responses.save_response(req.question, simplified, major, response.text, embedding)
    return {"answer": response.text, "cached": False}


# Most asked questions
#   GET /api/top-questions/{major} -> the 10 most asked past questions for 'cs', 'info' or 'both'

@app.get("/api/top-questions/{major}")
def top_questions(major: Literal["cs", "info", "both"]):
    return past_responses.top_questions(major, limit=10)