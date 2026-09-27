import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useApi } from "../../api";
import type { CourseMapData, CourseNodeInfo } from "../../types";
import {
  afterPreviousAttempt, attemptName, attemptOf, canPlace, chronological, courseOf, firstTerm, levelOf,
  missingPrereqs, moveCourse, needsPermission, nextResult, nextTerm, offeredIn, pendingRetakes, PERMISSION_ATTEMPT,
  prereqsMet, pruneAttempts, resultLabel, SEASONS, settle, termLabel,
  type CourseResult, type Results, type Season, type Semesters, type Term,
} from "./planLogic";
import PlanProgress from "./PlanProgress";
import CourseDetails, { Difficulty } from "./CourseDetails";
import PlanAdvisor from "./PlanAdvisor";
import "./CoursePlanner.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
}

const CREDIT_LIMIT = 19; // UMBC's normal per-semester max without an overload
const FULL_LOAD = 15; // a typical full-time semester; the baseline for semester difficulty

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

// Where a course can be dropped: a semester index, or back in the pool
type DropTarget = number | "pool";

// A semester's term, plus a key that stays with it when the semesters get re-sorted
type PlanTerm = Term & { key: number };

// What the pool shows: every level side by side, one level, or every unlocked / locked course
type PoolFilter = "all" | "unlocked" | "locked" | number;

// dnd-kit ids are strings, so semesters are "semester-0", "semester-1", ...
const zoneId = (target: DropTarget) => (target === "pool" ? "pool" : `semester-${target}`);
const parseZone = (id: string): DropTarget => (id === "pool" ? "pool" : Number(id.replace("semester-", "")));

// ---------- Course cards ----------
// What a course looks like; shared by the card in place and the copy that follows the pointer.
// Expanded cards (one level shown, so there's room) also show the difficulty.
// Retakes say so, and warn once the course has been failed twice.
interface CardBodyProps {
  course: CourseNodeInfo;
  attempt: number;
  expanded?: boolean;
}

function CardBody({ course, attempt, expanded }: CardBodyProps) {
  return (
    <div className="planner__card-body">
      <strong>{course.id}</strong> · {course.credits} cr
      {attempt > 1 && <span className="planner__attempt"> · {attempt === 2 ? "Retake" : `Attempt ${attempt}`}</span>}
      <p title={course.title}>{course.title}</p>
      {attempt >= PERMISSION_ATTEMPT && (
        <p className="planner__permission">⚠ Failed {attempt - 1} times: needs permission to retake</p>
      )}
      {expanded && <Difficulty value={course.difficulty} />}
    </div>
  );
}

interface CardProps {
  attemptKey: string; // what gets dragged: the course id, or "CMSC201#2" for a retake
  course: CourseNodeInfo;
  onRemove?: () => void; // only for courses already in a semester
  onShowMore?: () => void; // only on expanded cards
  result?: CourseResult; // placed courses: what happened in it, if anything yet
  onCycleResult?: () => void; // placed courses: step to the next result
}

function CourseCard({ attemptKey, course, onRemove, onShowMore, result, onCycleResult }: CardProps) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: attemptKey });
  const expanded = onShowMore !== undefined;
  const attempt = attemptOf(attemptKey);

  let className = "planner__course";
  if (onRemove) className += " planner__course--placed";
  if (expanded) className += " planner__course--expanded";
  if (isDragging) className += " is-dragging";

  return (
    <div ref={setNodeRef} className={className}>
      {/* Drag listeners live on the body only, so the buttons stay plain buttons */}
      <div className="planner__handle" {...listeners} {...attributes}>
        <CardBody course={course} attempt={attempt} expanded={expanded} />
      </div>
      {onRemove && (
        <button type="button" aria-label={`Remove ${course.id}`} onClick={onRemove}>×</button>
      )}
      {onCycleResult && (
        <button
          type="button"
          className={`planner__result planner__result--${result?.status ?? "planned"}`}
          aria-label={`${course.id}: ${resultLabel(result)}. Change result`}
          title="Click to change: Planned, Passed (A–D), Transferred, Failed"
          onClick={onCycleResult}
        >
          {resultLabel(result)}
        </button>
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
        <CardBody course={course} attempt={1} expanded />
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

// ---------- Term picker ----------
// Season changes apply right away; the year applies on blur or Enter, so typing "2027"
// doesn't re-sort the semesters at "2", "20", "202" along the way
interface TermPickerProps {
  term: Term;
  onChange: (term: Term) => void;
}

function TermPicker({ term, onChange }: TermPickerProps) {
  const [year, setYear] = useState(String(term.year));

  const commitYear = () => {
    const value = Number(year);
    if (Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR) {
      if (value !== term.year) onChange({ ...term, year: value });
    } else {
      setYear(String(term.year)); // not a usable year: put the old one back
    }
  };

  return (
    <span className="planner__term">
      <select
        aria-label="Season"
        value={term.season}
        onChange={e => onChange({ ...term, season: e.target.value as Season })}
      >
        {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <input
        type="number"
        aria-label="Year"
        min={MIN_YEAR}
        max={MAX_YEAR}
        value={year}
        onChange={e => setYear(e.target.value)}
        onBlur={commitYear}
        onKeyDown={e => { if (e.key === "Enter") commitYear(); }}
      />
    </span>
  );
}

// ---------- The planner ----------
export default function CoursePlanner({ major }: Props) {
  const [semesters, setSemesters] = useState<Semesters>([]);
  const [terms, setTerms] = useState<PlanTerm[]>([]); // terms[i] is semesters[i]'s term
  const [nextKey, setNextKey] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<PoolFilter>("unlocked");
  const [detailsFor, setDetailsFor] = useState<string | null>(null); // course id in the popup
  const [results, setResults] = useState<Results>({}); // placed course id -> passed / transferred / failed

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

  const placed = new Set(semesters.flat()); // attempts
  const placedCourses = new Set(semesters.flat().map(courseOf)); // for prereqs
  const courseFor = (key: string) => courses.get(courseOf(key));
  const credits = (keys: string[]) => keys.reduce((sum, key) => sum + (courseFor(key)?.credits ?? 0), 0);
  // Each course's difficulty weighted by its credits, scaled so a full load of courses
  // at difficulty d scores d; heavier loads score higher, capped at 5
  const semesterDifficulty = (keys: string[]) => {
    const weighted = keys.reduce((sum, key) => {
      const c = courseFor(key);
      return sum + (c ? c.difficulty * c.credits : 0);
    }, 0);
    return Math.min(5, weighted / FULL_LOAD);
  };

  // Per level: the courses not yet placed, split by whether their prereqs are placed
  const pool = levels.map(list => {
    const unplaced = list.filter(n => !placedCourses.has(n.id));
    return {
      unlocked: unplaced.filter(n => prereqsMet(n.id, data, placedCourses)),
      locked: unplaced.filter(n => !prereqsMet(n.id, data, placedCourses)),
    };
  });
  const allUnlocked = pool.flatMap(p => p.unlocked);
  const allLocked = pool.flatMap(p => p.locked);
  // Failed courses come back to the pool as a retake; failed twice, and the next one needs permission
  const retakes = pendingRetakes(semesters, results);
  const permissionNeeded = needsPermission(results);

  // Falls back to all levels if the major changed and the picked level no longer exists
  const shown: PoolFilter = typeof filter === "number" && filter >= levels.length ? "all" : filter;
  // Anything but the side-by-side view has the full width, so its cards are expanded
  const expanded = shown !== "all";
  const shownLevels = shown === "all" ? pool.map((_, level) => level) : typeof shown === "number" ? [shown] : [];

  const onFilterChange = (value: string) =>
    setFilter(value === "all" || value === "unlocked" || value === "locked" ? value : Number(value));

  // Every change goes through here so semesters stay in term order, and courses that
  // lost a prereq (say, their semester's term moved earlier) or whose semester moved to a
  // season they aren't offered in fall back to the pool. A course back in the pool loses its
  // result, and a retake disappears once the attempt before it is no longer failed.
  const apply = (next: Semesters, nextTerms: PlanTerm[] = terms, nextResults: Results = results) => {
    const order = chronological(nextTerms);
    const sortedTerms = order.map(i => nextTerms[i]);
    const settled = settle(order.map(i => next[i]), sortedTerms, data);
    const pruned = pruneAttempts(settled.semesters, nextResults);
    setSemesters(pruned.semesters);
    setTerms(sortedTerms);
    setResults(pruned.results);

    // Don't report a retake as back in the pool if it's gone altogether
    const pending = new Set(pendingRetakes(pruned.semesters, pruned.results));
    const inPool = (keys: string[]) => keys.filter(k => attemptOf(k) === 1 || pending.has(k)).map(attemptName);
    const [unoffered, bumped, early] = [inPool(settled.unoffered), inPool(settled.bumped), inPool(settled.early)];
    const dropped = pruned.dropped.map(attemptName);
    const notices = [
      unoffered.length && `${unoffered.join(", ")} went back to the pool because ${unoffered.length > 1 ? "they aren't" : "it isn't"} offered in that semester's season.`,
      bumped.length && `${bumped.join(", ")} went back to the pool because a prerequisite is no longer in an earlier semester.`,
      early.length && `${early.join(", ")} went back to the pool because a retake has to come after the semester it was failed in.`,
      dropped.length && `${dropped.join(", ")} ${dropped.length > 1 ? "were" : "was"} removed because the earlier attempt is no longer marked failed.`,
    ].filter(Boolean);
    setNotice(notices.length ? notices.join(" ") : null);
  };

  // New semesters default to the regular term after the latest one
  const addSemester = () => {
    const last = terms[terms.length - 1];
    apply([...semesters, []], [...terms, { ...(last ? nextTerm(last) : firstTerm()), key: nextKey }]);
    setNextKey(k => k + 1);
  };

  // Planned -> Passed A..D -> Transferred -> Failed -> Planned.
  // Goes through apply, since marking a course failed adds a retake and un-failing it removes one.
  const cycleResult = (key: string) => {
    const { [key]: current, ...rest } = results;
    const next = nextResult(current);
    apply(semesters, terms, next ? { ...rest, [key]: next } : rest);
  };

  const changeTerm = (index: number, term: Term) =>
    apply(semesters, terms.map((t, i) => (i === index ? { ...term, key: t.key } : t)));

  // Two semesters in the same term are almost certainly a typo
  const termCounts = new Map<string, number>();
  for (const t of terms) termCounts.set(termLabel(t), (termCounts.get(termLabel(t)) ?? 0) + 1);

  // Semesters accept a course whose prereqs are placed before them and that's offered in
  // their season (and a retake only after its failed attempt); the pool accepts placed courses
  const accepts = (target: DropTarget) =>
    dragging !== null && (target === "pool"
      ? placed.has(dragging)
      : canPlace(dragging, target, semesters, terms, data));

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

  const draggedCourse = dragging ? courseFor(dragging) : undefined;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <section className="planner">
        {/* ---------- AI advisor: sees the plan as it stands ---------- */}
        <PlanAdvisor major={major} semesters={semesters} terms={terms.map(termLabel)} results={results} />

        {/* ---------- Pool: unlocked courses, by level ---------- */}
        <div className="planner__summary">
          <h2>Pick your courses</h2>
          <span>{placed.size} courses · {credits([...placed])} credits planned</span>
          <button type="button" onClick={() => apply([], [])} disabled={semesters.length === 0}>
            Start over
          </button>
        </div>
        <PlanProgress results={results} />
        <p className="planner__hint">
          Drag a course into a semester. Courses on the next level unlock once their prerequisites are in a semester,
          and can only go in a semester after them. Courses only go in seasons they're usually offered.
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
          {/* Failed courses, ready to take again; first so they're easy to find */}
          {shown !== "locked" && retakes.length > 0 && (
            <div className="planner__level planner__level--retakes">
              <header className="planner__level-head">
                <strong>Retakes</strong>
                <span>Failed courses · drag into a semester after the one you failed it in</span>
              </header>
              <div className="planner__cards">
                {retakes.map(key => (
                  <CourseCard
                    key={key}
                    attemptKey={key}
                    course={courseFor(key)!}
                    onShowMore={expanded ? () => setDetailsFor(courseOf(key)) : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Unlocked courses, grouped by level; levels with nothing unlocked are skipped */}
          {shown === "unlocked" && pool.map(({ unlocked }, level) => unlocked.length > 0 && (
            <div key={level} className="planner__level">
              <header className="planner__level-head">
                <strong>Level {level}</strong>
                <span>{unlocked.length} unlocked · prerequisites placed, ready to drag into a semester</span>
              </header>
              <div className="planner__cards">
                {unlocked.map(n => (
                  <CourseCard key={n.id} attemptKey={n.id} course={n} onShowMore={() => setDetailsFor(n.id)} />
                ))}
              </div>
            </div>
          ))}
          {shown === "unlocked" && allUnlocked.length === 0 && retakes.length === 0 && (
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
                    needs={missingPrereqs(n.id, data, placedCourses)}
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
                      attemptKey={n.id}
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
        {permissionNeeded.length > 0 && (
          <p className="planner__warning" role="alert">
            ⚠ You've failed {permissionNeeded.join(", ")} twice. You'll need permission to
            take {permissionNeeded.length > 1 ? "them" : "it"} again; talk to your advisor before registering.
          </p>
        )}

        {/* ---------- Semesters: drop zones, first to last ---------- */}
        <div className="planner__semesters">
          {semesters.map((ids, index) => {
            const total = credits(ids);
            const term = terms[index];
            return (
              <DropZone
                key={term.key}
                target={index}
                accepts={accepts(index)}
                dragging={dragging !== null}
                className="planner__semester"
              >
                <header className="planner__semester-head">
                  <strong>Semester {index + 1}</strong>
                  <TermPicker term={term} onChange={t => changeTerm(index, t)} />
                  <span className={total > CREDIT_LIMIT ? "planner__over" : undefined}>{total} cr</span>
                  {ids.length > 0 && <Difficulty value={semesterDifficulty(ids)} />}
                  {termCounts.get(termLabel(term))! > 1 && (
                    <span className="planner__over">Another semester is also {termLabel(term)}</span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove semester ${index + 1}`}
                    onClick={() => apply(semesters.filter((_, i) => i !== index), terms.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </header>

                <div className="planner__drop">
                  {ids.map(key => (
                    <CourseCard
                      key={key}
                      attemptKey={key}
                      course={courseFor(key)!}
                      onRemove={() => apply(moveCourse(semesters, key, null))}
                      result={results[key]}
                      onCycleResult={() => cycleResult(key)}
                    />
                  ))}
                  {ids.length === 0 && <p className="planner__muted">Drag courses here</p>}
                  {dragging && !accepts(index) && !ids.includes(dragging) && (
                    <p className="planner__muted">
                      {!offeredIn(courseOf(dragging), term, data)
                        ? `Not offered in ${term.season} (usually ${courseFor(dragging)!.terms.join(", ")})`
                        : !afterPreviousAttempt(dragging, index, semesters)
                          ? "A retake has to come after the semester you failed it"
                          : "Needs its prerequisites in an earlier semester"}
                    </p>
                  )}
                </div>
              </DropZone>
            );
          })}
        </div>

        <button type="button" className="planner__add" onClick={addSemester}>
          + Add semester
        </button>

        {/* TODO: list required courses that still aren't placed */}
      </section>

      {/* The card that follows the pointer; rendered on top so the pool's scroll box can't clip it */}
      <DragOverlay dropAnimation={null}>
        {draggedCourse && (
          <div className="planner__course planner__course--overlay">
            {/* Match the card it was picked up from: pool cards are expanded outside the all-levels view */}
            <CardBody course={draggedCourse} attempt={attemptOf(dragging!)} expanded={expanded && !placed.has(dragging!)} />
          </div>
        )}
      </DragOverlay>

      {detailsFor && <CourseDetails courseId={detailsFor} onClose={() => setDetailsFor(null)} />}
    </DndContext>
  );
}
