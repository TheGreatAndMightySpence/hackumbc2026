import sqlite3
from pathlib import Path
import pandas as pd

DATA_DIR = Path("data")
DB_PATH = Path("umbc.db")

if DB_PATH.exists():
    DB_PATH.unlink()


conn = sqlite3.connect(DB_PATH)


for csv_file in sorted(DATA_DIR.glob("*.csv")):
    table = csv_file.stem        # alumni.csv -> table "alumni"
    df = pd.read_csv(csv_file, na_values=["Not Applicable"])
    df.to_sql(table, conn, index=False, chunksize=10_000)
    print(f"{table}: {len(df):,} rows")

indexes = {
    "students_current":   ["campus_id"],
    "alumni":             ["campus_id"],
    "transcripts":        ["campus_id", "course_id"],
    "employment_history": ["campus_id"],
    "student_experience": ["campus_id"],
    "course_catalog":     ["course_id"],
}

for table, cols in indexes.items():
    for col in cols:
        conn.execute(f"CREATE INDEX idx_{table}_{col} ON {table}({col})")

conn.commit()
conn.close()
print(f"Done -> {DB_PATH}")

# df = pd.read_csv("data\course_catalog.csv")
# conn = sqlite3.connect("my_database.db")
# df.to_sql("my_table", conn, if_exists="replace", index=False)
# conn.close()
# print("CSV successfully converted to database table!")