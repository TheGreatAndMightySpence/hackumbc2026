import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useApi } from "../../api";
import type { CourseMapData, CourseNodeInfo } from "../../types";
import {
  canPlace, levelOf, missingPrereqs, moveCourse, prereqsMet, settle, type Semesters,
} from "./planLogic";
import CourseDetails, { Difficulty } from "./CourseDetails";
import PlanAdvisor from "./PlanAdvisor";
import "./CoursePlanner.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
}

const CREDIT_LIMIT = 19; // UMBC's normal per-semester max without an overload
const FULL_LOAD = 15; // a typical full-time semester; the baseline for semester difficulty

// Where a course can be dropped: a semester index, or back in the pool
type DropTarget = number | "pool";

// What the pool shows: every level side by side, one level, or every unlocked / locked course
type PoolFilter = "all" | "unlocked" | "locked" | number;

// dnd-kit ids are strings, so semesters are "semester-0", "semester-1", ...
const zoneId = (target: DropTarget) => (target === "pool" ? "pool" : `semester-${target}`);
const parseZone = (id: string): DropTarget => (id === "pool" ? "pool" : Number(id.replace("semester-", "")));

// ---------- Course cards ----------
// What a course looks like; shared by the card in place and the copy that follows the pointer.
// Expanded cards (one level shown, so there's room) also show the difficulty.
function CardBody({ course, expanded }: { course: CourseNodeInfo; expanded?: boolean }) {
  return (
    <div className="planner__card-body">
      <strong>{course.id}</strong> · {course.credits} cr
      <p title={course.title}>{course.title}</p>
      {expanded && <Difficulty value={course.difficulty} />}
    </div>
  );
}

interface CardProps {
  course: CourseNodeInfo;
  onRemove?: () => void; // only for courses already in a semester
  onShowMore?: () => void; // only on expanded cards
}

function CourseCard({ course, onRemove, onShowMore }: CardProps) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: course.id });
  const expanded = onShowMore !== undefined;

  let className = "planner__course";
  if (onRemove) className += " planner__course--placed";
  if (expanded) className += " planner__course--expanded";
  if (isDragging) className += " is-dragging";

  return (
    <div ref={setNodeRef} className={className}>
      {/* Drag listeners live on the body only, so the buttons stay plain buttons */}
      <div className="planner__handle" {...listeners} {...attributes}>
        <CardBody course={course} expanded={expanded} />
      </div>
      {onRemove && (
        <button type="button" aria-label={`Remove ${course.id}`} onClick={onRemove}>×</button>
      )}
      {onShowMore && (
        <button type="button" className="planner__more" aria-label={`More about ${course.id}`} onClick={onShowMore}>
          Show more
        </button>
      )}
    </div>
  );
}

// A course whose prerequisites aren't placed yet: shown for browsing, not draggable
interface LockedCardProps {
  course: CourseNodeInfo;
  needs: string[];
  onShowMore: () => void;
}

function LockedCard({ course, needs, onShowMore }: LockedCardProps) {
  return (
    <div className="planner__course planner__course--expanded planner__course--locked">
      <div className="planner__locked-body">
        <CardBody course={course} expanded />
        <p className="planner__needs" title={needs.join(", ")}>🔒 Needs {needs.join(", ")}</p>
      </div>
      <button type="button" className="planner__more" aria-label={`More about ${course.id}`} onClick={onShowMore}>
        Show more
      </button>
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
  const [filter, setFilter] = useState<PoolFilter>("unlocked");
  const [detailsFor, setDetailsFor] = useState<string | null>(null); // course id in the popup

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
  // Each course's difficulty weighted by its credits, scaled so a full load of courses
  // at difficulty d scores d; heavier loads score higher, capped at 5
  const semesterDifficulty = (ids: string[]) => {
    const weighted = ids.reduce((sum, id) => {
      const c = courses.get(id);
      return sum + (c ? c.difficulty * c.credits : 0);
    }, 0);
    return Math.min(5, weighted / FULL_LOAD);
  };

  // Per level: the courses not yet placed, split by whether their prereqs are placed
  const pool = levels.map(list => {
    const unplaced = list.filter(n => !placed.has(n.id));
    return {
      unlocked: unplaced.filter(n => prereqsMet(n.id, data, placed)),
      locked: unplaced.filter(n => !prereqsMet(n.id, data, placed)),
    };
  });
  const allUnlocked = pool.flatMap(p => p.unlocked);
  const allLocked = pool.flatMap(p => p.locked);

  // Falls back to all levels if the major changed and the picked level no longer exists
  const shown: PoolFilter = typeof filter === "number" && filter >= levels.length ? "all" : filter;
  // Anything but the side-by-side view has the full width, so its cards are expanded
  const expanded = shown !== "all";
  const shownLevels = shown === "all" ? pool.map((_, level) => level) : typeof shown === "number" ? [shown] : [];

  const onFilterChange = (value: string) =>
    setFilter(value === "all" || value === "unlocked" || value === "locked" ? value : Number(value));

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
        {/* ---------- AI advisor: sees the plan as it stands ---------- */}
        <PlanAdvisor major={major} semesters={semesters} />

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

        <label className="planner__filter">
          Show
          <select value={String(shown)} onChange={e => onFilterChange(e.target.value)}>
            <option value="all">All levels</option>
            <option value="unlocked">Unlocked ({allUnlocked.length})</option>
            <option value="locked">Locked ({allLocked.length})</option>
            <optgroup label="One level">
              {pool.map(({ unlocked }, level) => (
                <option key={level} value={level}>
                  Level {level} ({unlocked.length} unlocked)
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <DropZone
          target="pool"
          accepts={accepts("pool")}
          dragging={dragging !== null}
          className={`planner__pool${expanded ? " planner__pool--single" : ""}${shown === "unlocked" ? " planner__pool--stacked" : ""}`}
        >
          {/* Unlocked courses, grouped by level; levels with nothing unlocked are skipped */}
          {shown === "unlocked" && pool.map(({ unlocked }, level) => unlocked.length > 0 && (
            <div key={level} className="planner__level">
              <header className="planner__level-head">
                <strong>Level {level}</strong>
                <span>{unlocked.length} unlocked · prerequisites placed, ready to drag into a semester</span>
              </header>
              <div className="planner__cards">
                {unlocked.map(n => (
                  <CourseCard key={n.id} course={n} onShowMore={() => setDetailsFor(n.id)} />
                ))}
              </div>
            </div>
          ))}
          {shown === "unlocked" && allUnlocked.length === 0 && (
            <p className="planner__muted">
              {allLocked.length ? "Nothing unlocked right now. Place more courses to unlock others." : "All placed ✓"}
            </p>
          )}

          {shown === "locked" && (
            <div className="planner__level">
              <header className="planner__level-head">
                <strong>Locked</strong>
                <span>Place their prerequisites in a semester to unlock these</span>
              </header>
              <div className="planner__cards">
                {allLocked.map(n => (
                  <LockedCard
                    key={n.id}
                    course={n}
                    needs={missingPrereqs(n.id, data, placed)}
                    onShowMore={() => setDetailsFor(n.id)}
                  />
                ))}
              </div>
              {allLocked.length === 0 && <p className="planner__muted">Everything is unlocked ✓</p>}
            </div>
          )}

          {shownLevels.map(level => {
            const { unlocked, locked } = pool[level];

            return (
              <div key={level} className="planner__level">
                <header className="planner__level-head">
                  <strong>Level {level}</strong>
                  <span>{level === 0 ? "No prerequisites" : `Builds on level ${level - 1}`}</span>
                </header>

                <div className="planner__cards">
                  {unlocked.map(n => (
                    <CourseCard
                      key={n.id}
                      course={n}
                      onShowMore={expanded ? () => setDetailsFor(n.id) : undefined}
                    />
                  ))}
                </div>

                {unlocked.length === 0 && locked.length > 0 && (
                  <p className="planner__muted">Place a level {level - 1} course to unlock these.</p>
                )}
                {unlocked.length > 0 && locked.length > 0 && (
                  <p className="planner__muted">🔒 {locked.length} more locked</p>
                )}
                {unlocked.length === 0 && locked.length === 0 && <p className="planner__muted">All placed ✓</p>}
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
                  {ids.length > 0 && <Difficulty value={semesterDifficulty(ids)} />}
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
            {/* Match the card it was picked up from: pool cards are expanded outside the all-levels view */}
            <CardBody course={draggedCourse} expanded={expanded && !placed.has(draggedCourse.id)} />
          </div>
        )}
      </DragOverlay>

      {detailsFor && <CourseDetails courseId={detailsFor} onClose={() => setDetailsFor(null)} />}
    </DndContext>
  );
}
