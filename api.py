import sqlite3
from fastapi import FastAPI

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