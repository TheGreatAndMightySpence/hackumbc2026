import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
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

// Where a course can be dropped: a semester index, or back in the pool
type DropTarget = number | "pool";

// dnd-kit ids are strings, so semesters are "semester-0", "semester-1", ...
const zoneId = (target: DropTarget) => (target === "pool" ? "pool" : `semester-${target}`);
const parseZone = (id: string): DropTarget => (id === "pool" ? "pool" : Number(id.replace("semester-", "")));

// ---------- Course cards ----------
// What a course looks like; shared by the card in place and the copy that follows the pointer
function CardBody({ course }: { course: CourseNodeInfo }) {
  return (
    <div className="planner__card-body">
      <strong>{course.id}</strong> · {course.credits} cr
      <p title={course.title}>{course.title}</p>
    </div>
  );
}

interface CardProps {
  course: CourseNodeInfo;
  onRemove?: () => void; // only for courses already in a semester
}

function CourseCard({ course, onRemove }: CardProps) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: course.id });

  return (
    <div
      ref={setNodeRef}
      className={`planner__course${onRemove ? " planner__course--placed" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      {/* Drag listeners live on the body only, so the × button stays a plain button */}
      <div className="planner__handle" {...listeners} {...attributes}>
        <CardBody course={course} />
      </div>
      {onRemove && (
        <button type="button" aria-label={`Remove ${course.id}`} onClick={onRemove}>×</button>
      )}
    </div>
  );
}

// ---------- Drop zones ----------
interface ZoneProps {
  target: DropTarget;
  accepts: boolean; // can the course being dragged land here?
  dragging: boolean;
  className: string;
  children: ReactNode;
}

function DropZone({ target, accepts, dragging, className, children }: ZoneProps) {
  // Disabled zones never report as `over`, so dnd-kit won't drop a course where it can't go
  const { setNodeRef, isOver } = useDroppable({ id: zoneId(target), disabled: !accepts });

  // Mid-drag: highlight zones that will take the course, fade semesters that won't
  // (the pool never fades, since that's usually where the drag started)
  let state = "";
  if (dragging) {
    if (accepts) state = isOver ? " is-over" : " is-open";
    else if (target !== "pool") state = " is-closed";
  }

  return <div ref={setNodeRef} className={className + state}>{children}</div>;
}

// ---------- The planner ----------
export default function CoursePlanner({ major }: Props) {
  const [semesters, setSemesters] = useState<Semesters>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Mouse: drag after moving 5px, so clicks still work.
  // Touch: press and hold, so a normal swipe still scrolls the page.
  // Keyboard: focus a course, Space to pick up, arrows to move, Space to drop.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

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

  // Semesters accept a course whose prereqs are placed before them; the pool accepts placed courses
  const accepts = (target: DropTarget) =>
    dragging !== null && (target === "pool"
      ? placed.has(dragging)
      : canPlace(dragging, target, semesters, data));

  const onDragStart = ({ active }: DragStartEvent) => {
    setDragging(String(active.id));
    setNotice(null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return; // dropped somewhere that doesn't take it
    const target = parseZone(String(over.id));
    apply(moveCourse(semesters, String(active.id), target === "pool" ? null : target));
  };

  const draggedCourse = dragging ? courses.get(dragging) : undefined;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
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

        <DropZone target="pool" accepts={accepts("pool")} dragging={dragging !== null} className="planner__pool">
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

                {unlocked.map(n => <CourseCard key={n.id} course={n} />)}

                {unlocked.length === 0 && locked > 0 && (
                  <p className="planner__muted">Place a level {level - 1} course to unlock these.</p>
                )}
                {unlocked.length > 0 && locked > 0 && <p className="planner__muted">🔒 {locked} more locked</p>}
                {unlocked.length === 0 && locked === 0 && <p className="planner__muted">All placed ✓</p>}
              </div>
            );
          })}
        </DropZone>

        {notice && <p className="planner__notice" role="status">{notice}</p>}

        {/* ---------- Semesters: drop zones, first to last ---------- */}
        <div className="planner__semesters">
          {semesters.map((ids, index) => {
            const total = credits(ids);
            return (
              <DropZone
                key={index}
                target={index}
                accepts={accepts(index)}
                dragging={dragging !== null}
                className="planner__semester"
              >
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
                      onRemove={() => apply(moveCourse(semesters, id, null))}
                    />
                  ))}
                  {ids.length === 0 && <p className="planner__muted">Drag courses here</p>}
                  {dragging && !accepts(index) && !ids.includes(dragging) && (
                    <p className="planner__muted">Needs its prerequisites in an earlier semester</p>
                  )}
                </div>
              </DropZone>
            );
          })}
        </div>

        <button type="button" className="planner__add" onClick={() => setSemesters(s => [...s, []])}>
          + Add semester
        </button>

        {/* TODO: list required courses that still aren't placed, and check Fall/Spring availability */}
      </section>

      {/* The card that follows the pointer; rendered on top so the pool's scroll box can't clip it */}
      <DragOverlay dropAnimation={null}>
        {draggedCourse && (
          <div className="planner__course planner__course--overlay">
            <CardBody course={draggedCourse} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
