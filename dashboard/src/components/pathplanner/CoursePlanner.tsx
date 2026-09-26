import { useMemo, useState, type DragEvent } from "react";
import { useApi } from "../../api";
import type { CourseMapData, CourseNodeInfo } from "../../types";
import {
  canPlace, levelOf, moveCourse, prereqsMet, settle, type Semesters,
} from "./planLogic";
import "./CoursePlanner.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
}

const CREDIT_LIMIT = 19; // UMBC's normal per-semester max without an overload

// Where a drag is hovering: a semester index, or the pool
type DropTarget = number | "pool";

// Only leave the hover state when the pointer really exits the zone, not when it crosses a child
const leftZone = (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null);

// ---------- One draggable course ----------
interface CardProps {
  course: CourseNodeInfo;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onRemove?: () => void; // only for courses already in a semester
}

function CourseCard({ course, onDragStart, onDragEnd, onRemove }: CardProps) {
  return (
    <div
      className={`planner__course${onRemove ? " planner__course--placed" : ""}`}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData("text/plain", course.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart(course.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div>
        <strong>{course.id}</strong> · {course.credits} cr
        <p title={course.title}>{course.title}</p>
      </div>
      {onRemove && (
        <button type="button" aria-label={`Remove ${course.id}`} onClick={onRemove}>×</button>
      )}
    </div>
  );
}

// ---------- The planner ----------
export default function CoursePlanner({ major }: Props) {
  const [semesters, setSemesters] = useState<Semesters>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, loading, error } = useApi<CourseMapData>(
    `/api/course-map/${encodeURIComponent(major)}?electives=true`
  );

  const courses = useMemo(
    () => new Map<string, CourseNodeInfo>((data?.nodes ?? []).map(n => [n.id, n])),
    [data]
  );

  // level -> its courses, level 0 first
  const levels = useMemo(() => {
    const byLevel: CourseNodeInfo[][] = [];
    for (const n of data?.nodes ?? []) (byLevel[levelOf(n)] ??= []).push(n);
    return Array.from(byLevel, list => list ?? []);
  }, [data]);

  if (loading) return <p>Loading courses…</p>;
  if (error || !data) return <p>Couldn't load courses: {error}</p>;

  const placed = new Set(semesters.flat());
  const credits = (ids: string[]) => ids.reduce((sum, id) => sum + (courses.get(id)?.credits ?? 0), 0);

  // Every change goes through here so courses that lost a prereq fall back to the pool
  const apply = (next: Semesters) => {
    const { semesters: settled, bumped } = settle(next, data);
    setSemesters(settled);
    setNotice(bumped.length
      ? `${bumped.join(", ")} went back to the pool because a prerequisite is no longer in an earlier semester.`
      : null);
  };

  const startDrag = (id: string) => { setDragging(id); setNotice(null); };
  const endDrag = () => { setDragging(null); setOver(null); };

  // Semesters accept a course whose prereqs are placed before them; the pool accepts placed courses
  const accepts = (target: DropTarget) =>
    dragging !== null && (target === "pool"
      ? placed.has(dragging)
      : canPlace(dragging, target, semesters, data));

  // Props shared by every drop zone
  const dropZone = (target: DropTarget) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts(target)) return; // not calling preventDefault = drop not allowed
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(target);
    },
    onDragLeave: (e: DragEvent) => { if (leftZone(e)) setOver(null); },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      if (courses.has(id)) apply(moveCourse(semesters, id, target === "pool" ? null : target));
      endDrag();
    },
  });

  // How a zone looks mid-drag: highlighted if it'll take the course, faded if not
  // (the pool never fades, since that's usually where the drag started)
  const zoneState = (target: DropTarget) => {
    if (dragging === null) return "";
    if (accepts(target)) return over === target ? " is-over" : " is-open";
    return target === "pool" ? "" : " is-closed";
  };

  return (
    <section className="planner">
      {/* ---------- Pool: unlocked courses, by level ---------- */}
      <div className="planner__summary">
        <h2>Pick your courses</h2>
        <span>{placed.size} courses · {credits([...placed])} credits planned</span>
        <button type="button" onClick={() => apply([])} disabled={semesters.length === 0}>
          Start over
        </button>
      </div>
      <p className="planner__hint">
        Drag a course into a semester. Courses on the next level unlock once their prerequisites are in a semester,
        and can only go in a semester after them.
      </p>

      <div className={`planner__pool${zoneState("pool")}`} {...dropZone("pool")}>
        {levels.map((list, level) => {
          // Show what the student has unlocked and not yet placed
          const unlocked = list.filter(n => !placed.has(n.id) && prereqsMet(n.id, data, placed));
          const locked = list.filter(n => !placed.has(n.id)).length - unlocked.length;

          return (
            <div key={level} className="planner__level">
              <header className="planner__level-head">
                <strong>Level {level}</strong>
                <span>{level === 0 ? "No prerequisites" : `Builds on level ${level - 1}`}</span>
              </header>

              {unlocked.map(n => (
                <CourseCard key={n.id} course={n} onDragStart={startDrag} onDragEnd={endDrag} />
              ))}

              {unlocked.length === 0 && locked > 0 && (
                <p className="planner__muted">Place a level {level - 1} course to unlock these.</p>
              )}
              {unlocked.length > 0 && locked > 0 && <p className="planner__muted">🔒 {locked} more locked</p>}
              {unlocked.length === 0 && locked === 0 && <p className="planner__muted">All placed ✓</p>}
            </div>
          );
        })}
      </div>

      {notice && <p className="planner__notice" role="status">{notice}</p>}

      {/* ---------- Semesters: drop zones, first to last ---------- */}
      <div className="planner__semesters">
        {semesters.map((ids, index) => {
          const total = credits(ids);
          return (
            <div key={index} className={`planner__semester${zoneState(index)}`} {...dropZone(index)}>
              <header className="planner__semester-head">
                <strong>Semester {index + 1}</strong>
                <span className={total > CREDIT_LIMIT ? "planner__over" : undefined}>{total} cr</span>
                <button
                  type="button"
                  aria-label={`Remove semester ${index + 1}`}
                  onClick={() => apply(semesters.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </header>

              <div className="planner__drop">
                {ids.map(id => (
                  <CourseCard
                    key={id}
                    course={courses.get(id)!}
                    onDragStart={startDrag}
                    onDragEnd={endDrag}
                    onRemove={() => apply(moveCourse(semesters, id, null))}
                  />
                ))}
                {ids.length === 0 && <p className="planner__muted">Drag courses here</p>}
                {dragging && !accepts(index) && !ids.includes(dragging) && (
                  <p className="planner__muted">Needs its prerequisites in an earlier semester</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button type="button" className="planner__add" onClick={() => setSemesters(s => [...s, []])}>
        + Add semester
      </button>

      {/* TODO: list required courses that still aren't placed, and check Fall/Spring availability */}
    </section>
  );
}
