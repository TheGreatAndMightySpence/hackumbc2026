import json
import os
import re
import sqlite3
import numpy as np
from pathlib import Path
from google.genai import types


# Semantic cache for the AI assistant
#   Every question is first rewritten by Gemini into a short, simplified form (and tagged with
#   the major it relates to). The simplified question is embedded and stored; a new question whose
#   simplified embedding is close enough (cosine similarity) to a past one reuses that answer
#   instead of calling Gemini, and bumps that row's times_asked counter.

DB_PATH = Path("past_responses.db")
EMBED_MODEL = os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001")
SIMILARITY_THRESHOLD = float(os.getenv("SEMANTIC_CACHE_THRESHOLD", "0.95"))


def connect():
    # One connection per call: FastAPI runs sync endpoints on worker threads
    return sqlite3.connect(DB_PATH)


def create_table():
    conn = connect()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS past_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            simplified_question TEXT,
            major TEXT CHECK (major IN ('cs', 'info', 'both')),  -- NULL = not about a major
            answer TEXT NOT NULL,
            embedding BLOB NOT NULL,
            times_asked INTEGER NOT NULL DEFAULT 1,
            charts TEXT  -- JSON list of chart specs from make_chart; NULL = none
        )
        """
    )
    # Add the newer columns to a database created before they existed
    existing = {r[1] for r in conn.execute("PRAGMA table_info(past_responses)")}
    for column, ddl in [("simplified_question", "TEXT"),
                        ("major", "TEXT"),
                        ("times_asked", "INTEGER NOT NULL DEFAULT 1"),
                        ("charts", "TEXT")]:
        if column not in existing:
            conn.execute(f"ALTER TABLE past_responses ADD COLUMN {column} {ddl}")
    conn.commit()
    conn.close()


MAJORS = ("cs", "info", "both")
SIMPLIFY_PROMPT = (
    "You normalize questions from UMBC students so similar questions can be matched.\n"
    "1. Rewrite the question as a short, plain question with filler, greetings and personal "
    "context removed. Keep every detail that changes the answer: numbers, years, course codes "
    "(e.g. CMSC 341), which statistic is asked for (average, median, highest, ...) and whether "
    "a graph or chart is asked for. "
    "Write Computer Science as CS and Information Systems as IS.\n"
    "2. Classify which major the question relates to: 'cs' (Computer Science), "
    "'info' (Information Systems), 'both', or 'none' if it isn't about a specific major."
)
SIMPLIFY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "simplified": {"type": "STRING"},
        "major": {"type": "STRING", "enum": [*MAJORS, "none"]},
    },
    "required": ["simplified", "major"],
}


def simplify(client, model: str, question: str) -> tuple[str, str | None]:
    """(simplified question, major) where major is 'cs', 'info', 'both' or None."""
    result = client.models.generate_content(
        model=model,
        contents=question,
        config=types.GenerateContentConfig(
            system_instruction=SIMPLIFY_PROMPT,
            response_mime_type="application/json",
            response_schema=SIMPLIFY_SCHEMA,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )
    data = json.loads(result.text)
    simplified = data.get("simplified", "").strip() or question
    major = data.get("major")
    return simplified, major if major in MAJORS else None


def embed(client, text: str) -> np.ndarray:
    """Unit-length embedding of the question, so a dot product is cosine similarity."""
    result = client.models.embed_content(
        model=EMBED_MODEL,
        contents=text.strip().lower(),
        config=types.EmbedContentConfig(task_type="SEMANTIC_SIMILARITY"),
    )
    vec = np.asarray(result.embeddings[0].values, dtype=np.float32)
    return vec / np.linalg.norm(vec)


STAT_WORDS = {"average": "avg", "avg": "avg", "mean": "avg", "median": "median",
              "highest": "max", "max": "max", "maximum": "max",
              "lowest": "min", "min": "min", "minimum": "min", "total": "total"}
CHART_WORDS = {"graph", "graphs", "chart", "charts", "plot", "plots", "visualize",
               "visualise", "visualization", "visualisation", "diagram"}


def key_terms(question: str) -> set:
    """Details embeddings blur together but that change the answer:
    numbers (years, course numbers), acronyms (CS vs IS, CMSC), which statistic is asked for
    and whether a chart is asked for."""
    words = re.findall(r"[a-z]+", question.lower())
    terms = set(re.findall(r"\d+", question))
    terms |= set(re.findall(r"\b[A-Z]{2,}\b", question))
    terms |= {STAT_WORDS[w] for w in words if w in STAT_WORDS}
    if CHART_WORDS.intersection(words):
        terms.add("chart")
    return terms


def find_similar(simplified: str, embedding: np.ndarray,
                 threshold: float = SIMILARITY_THRESHOLD) -> dict | None:
    """Most similar past simplified question at or above the threshold with the same key terms, or None."""
    conn = connect()
    # Rows saved before simplification existed compare against their original question
    rows = conn.execute(
        "SELECT id, COALESCE(simplified_question, question), answer, embedding, charts "
        "FROM past_responses"
    ).fetchall()
    conn.close()
    # Skip rows from a different embedding model (different vector size), and rows
    # asking about a different year/course/major/statistic however similar they read
    terms = key_terms(simplified)
    rows = [r for r in rows if len(r[3]) == embedding.nbytes and key_terms(r[1]) == terms]
    if not rows:
        return None

    matrix = np.stack([np.frombuffer(r[3], dtype=np.float32) for r in rows])
    scores = matrix @ embedding
    best = int(np.argmax(scores))
    if scores[best] < threshold:
        return None
    row_id, question, answer, _, charts = rows[best]
    return {"id": row_id, "question": question, "answer": answer,
            "charts": json.loads(charts) if charts else [], "similarity": float(scores[best])}


def record_hit(row_id: int):
    """Count another asking of a cached question."""
    conn = connect()
    conn.execute("UPDATE past_responses SET times_asked = times_asked + 1 WHERE id = ?", (row_id,))
    conn.commit()
    conn.close()


def top_questions(major: str, limit: int = 10) -> list[dict]:
    """Most asked questions relevant to this major ('cs', 'info' or 'both').
    'cs' and 'info' also include questions about both majors, 'both' includes either major,
    and questions not about a specific major fill any remaining spots. Among equally asked
    questions, the closest match to the major comes first, then the newest."""
    relevant = ("cs", "info", "both") if major == "both" else (major, "both")
    conn = connect()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, question, COALESCE(simplified_question, question) AS simplified_question, "
        "major, answer, times_asked, charts FROM past_responses "
        f"WHERE major IN ({', '.join('?' * len(relevant))}) OR major IS NULL "
        "ORDER BY times_asked DESC, "
        "CASE WHEN major = ? THEN 0 WHEN major IS NOT NULL THEN 1 ELSE 2 END, id DESC LIMIT ?",
        (*relevant, major, limit),
    ).fetchall()
    conn.close()
    return [{**dict(r), "charts": json.loads(r["charts"]) if r["charts"] else []} for r in rows]


def save_response(question: str, simplified: str, major: str | None,
                  answer: str, embedding: np.ndarray, charts: list | None = None):
    conn = connect()
    conn.execute(
        "INSERT INTO past_responses (question, simplified_question, major, answer, embedding, charts) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (question, simplified, major, answer, embedding.astype(np.float32).tobytes(),
         json.dumps(charts) if charts else None),
    )
    conn.commit()
    conn.close()


create_table()
