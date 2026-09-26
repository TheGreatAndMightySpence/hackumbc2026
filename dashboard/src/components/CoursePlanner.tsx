import { useMemo, useState } from "react";
import { useApi } from "../api";
import type { CourseMapData, CourseNodeInfo } from "../types";
import "./CoursePlanner.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
}

// The API's `semester` is 1 + the longest prerequisite chain, so level 0 = no prereqs,
// level 1 = needs level 0 courses, and so on
const levelOf = (course: CourseNodeInfo) => course.semester - 1;

// Has the student picked enough to take `id`?
// The API flattens "A or B" groups into edges flagged `alternative`, so this treats
// every plain prereq as required and asks for at least one of the alternatives.
// TODO: have the API return prerequisite groups so mixed "A|(B or C)" rules are exact
function prereqsMet(id: string, data: CourseMapData, picked: Set<string>): boolean {
  const incoming = data.edges.filter(e => e.target === id);
  const required = incoming.filter(e => !e.alternative);
  const options = incoming.filter(e => e.alternative);
  return required.every(e => picked.has(e.source))
    && (options.length === 0 || options.some(e => picked.has(e.source)));
}

// Un-picking a course also drops anything that needed it, and anything that needed those
function withoutCourse(id: string, picked: Set<string>, data: CourseMapData): Set<string> {
  const next = new Set(picked);
  next.delete(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of next) {
      if (!prereqsMet(c, data, next)) {
        next.delete(c);
        changed = true;
      }
    }
  }
  return next;
}

export default function CoursePlanner({ major }: Props) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  const { data, loading, error } = useApi<CourseMapData>(
    `/api/course-map/${encodeURIComponent(major)}?electives=true`
  );

  // level -> its courses, level 0 first
  const levels = useMemo(() => {
    const byLevel: CourseNodeInfo[][] = [];
    for (const n of data?.nodes ?? []) (byLevel[levelOf(n)] ??= []).push(n);
    return Array.from(byLevel, courses => courses ?? []);
  }, [data]);

  if (loading) return <p>Loading courses…</p>;
  if (error || !data) return <p>Couldn't load courses: {error}</p>;

  const toggle = (id: string) =>
    setPicked(p => (p.has(id) ? withoutCourse(id, p, data) : new Set(p).add(id)));

  const totalCredits = data.nodes
    .filter(n => picked.has(n.id))
    .reduce((sum, n) => sum + n.credits, 0);

  return (
    <section className="planner">
      <div className="planner__summary">
        <h2>Pick your courses</h2>
        <span>{picked.size} courses · {totalCredits} credits</span>
        <button type="button" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
          Clear
        </button>
      </div>
      <p className="planner__hint">
        Start on the left with courses that have no prerequisites. Picking a course unlocks the ones that build on it.
      </p>

      <div className="planner__flow">
        {levels.map((courses, level) => {
          // Only show what the student has unlocked so far
          const unlocked = courses.filter(n => picked.has(n.id) || prereqsMet(n.id, data, picked));
          const locked = courses.length - unlocked.length;

          return (
            <div key={level} className="planner__column">
              <header className="planner__column-head">
                <strong>Level {level}</strong>
                <span>{level === 0 ? "No prerequisites" : `Builds on level ${level - 1}`}</span>
              </header>

              {unlocked.length === 0 && (
                <p className="planner__empty">Pick a level {level - 1} course to unlock these.</p>
              )}

              <ul className="planner__courses">
                {unlocked.map(n => {
                  const on = picked.has(n.id);
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={`planner__course${on ? " planner__course--picked" : ""}`}
                        aria-pressed={on}
                        onClick={() => toggle(n.id)}
                      >
                        <span>
                          <strong>{n.id}</strong> · {n.credits} cr · {n.type}
                        </span>
                        <span className="planner__title" title={n.title}>{n.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {locked > 0 && <p className="planner__locked">🔒 {locked} more locked</p>}
            </div>
          );
        })}
      </div>

      {/* TODO: list required courses that still aren't picked, then split the picks into semesters */}
    </section>
  );
}
