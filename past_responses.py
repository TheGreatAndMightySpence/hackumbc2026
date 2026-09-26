import os
import re
import sqlite3
import numpy as np
from pathlib import Path
from google.genai import types


# Semantic cache for the AI assistant
#   Every answered question is stored with its embedding. A new question whose embedding
#   is close enough (cosine similarity) to a past one reuses that answer instead of calling Gemini.

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
            answer TEXT NOT NULL,
            embedding BLOB NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


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


def key_terms(question: str) -> set:
    """Details embeddings blur together but that change the answer:
    numbers (years, course numbers), acronyms (CS vs IS, CMSC) and which statistic is asked for."""
    terms = set(re.findall(r"\d+", question))
    terms |= set(re.findall(r"\b[A-Z]{2,}\b", question))
    terms |= {STAT_WORDS[w] for w in re.findall(r"[a-z]+", question.lower()) if w in STAT_WORDS}
    return terms


def find_similar(question: str, embedding: np.ndarray,
                 threshold: float = SIMILARITY_THRESHOLD) -> dict | None:
    """Most similar past question at or above the threshold with the same key terms, or None."""
    conn = connect()
    rows = conn.execute("SELECT question, answer, embedding FROM past_responses").fetchall()
    conn.close()
    # Skip rows from a different embedding model (different vector size), and rows
    # asking about a different year/course/major/statistic however similar they read
    terms = key_terms(question)
    rows = [r for r in rows if len(r[2]) == embedding.nbytes and key_terms(r[0]) == terms]
    if not rows:
        return None

    matrix = np.stack([np.frombuffer(r[2], dtype=np.float32) for r in rows])
    scores = matrix @ embedding
    best = int(np.argmax(scores))
    if scores[best] < threshold:
        return None
    question, answer, _ = rows[best]
    return {"question": question, "answer": answer, "similarity": float(scores[best])}


def save_response(question: str, answer: str, embedding: np.ndarray):
    conn = connect()
    conn.execute(
        "INSERT INTO past_responses (question, answer, embedding) VALUES (?, ?, ?)",
        (question, answer, embedding.astype(np.float32).tobytes()),
    )
    conn.commit()
    conn.close()


create_table()
