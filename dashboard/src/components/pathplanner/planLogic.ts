import type { CourseMapData, CourseNodeInfo } from "../../types";

// semester index -> the attempts placed in it (see attemptKey)
export type Semesters = string[][];

// ---------- Attempts ----------
// A failed course can be taken again, so the same course can sit in more than one semester.
// Each placement is keyed by attempt: the first is the bare course id ("CMSC201"),
// retakes add the attempt number ("CMSC201#2", "CMSC201#3", ...)
export const attemptKey = (id: string, attempt: number) => (attempt === 1 ? id : `${id}#${attempt}`);
export const courseOf = (key: string) => key.split("#")[0];
export const attemptOf = (key: string) => Number(key.split("#")[1] ?? 1);

// Failing a course twice means a third attempt needs permission
export const PERMISSION_ATTEMPT = 3;

// "CMSC201", or "CMSC201 (retake)" for a later attempt; for notices
export const attemptName = (key: string) => (attemptOf(key) === 1 ? key : `${courseOf(key)} (retake)`);

// ---------- Terms ----------
// Seasons in calendar order, so Spring 2027 < Summer 2027 < Fall 2027
export const SEASONS = ["Spring", "Summer", "Fall"] as const;
export type Season = (typeof SEASONS)[number];

export interface Term {
  season: Season;
  year: number;
}

export const termLabel = (t: Term) => `${t.season} ${t.year}`;

// "Fall 2027" -> { season: "Fall", year: 2027 }; null if it isn't a term
export function parseTerm(label: string): Term | null {
  const [season, year] = label.trim().split(/\s+/);
  return SEASONS.includes(season as Season) && /^\d{4}$/.test(year ?? "")
    ? { season: season as Season, year: Number(year) }
    : null;
}
const termOrder = (t: Term) => t.year * SEASONS.length + SEASONS.indexOf(t.season);

// The term to plan first: the coming Fall until August, then the coming Spring
export function firstTerm(today = new Date()): Term {
  return today.getMonth() < 7
    ? { season: "Fall", year: today.getFullYear() }
    : { season: "Spring", year: today.getFullYear() + 1 };
}

// Month each season starts (0 = January), matching firstTerm's "Fall starts in August"
const SEASON_START: Record<Season, number> = { Spring: 0, Summer: 5, Fall: 7 };

// Has `t` not started yet? Courses in a future term can't have a grade yet
export const isFuture = (t: Term, today = new Date()) => new Date(t.year, SEASON_START[t.season], 1) > today;

// The regular term after `t`, skipping Summer: Fall -> Spring -> Fall
export const nextTerm = (t: Term): Term =>
  t.season === "Fall" ? { season: "Spring", year: t.year + 1 } : { season: "Fall", year: t.year };

// Indices of `terms` in chronological order. Stable, so semesters in the same term keep their order.
export const chronological = (terms: Term[]) =>
  terms.map((_, i) => i).sort((a, b) => termOrder(terms[a]) - termOrder(terms[b]));

// The API's `semester` is 1 + the longest prerequisite chain, so level 0 = no prereqs,
// level 1 = needs level 0 courses, and so on
export const levelOf = (course: CourseNodeInfo) => course.semester - 1;

// Has the student finished enough (`done`) to take `id`?
// The API flattens "A or B" groups into edges flagged `alternative`, so this treats
// every plain prereq as required and asks for at least one of the alternatives.
// TODO: have the API return prerequisite groups so mixed "A|(B or C)" rules are exact
export function prereqsMet(id: string, data: CourseMapData, done: Set<string>): boolean {
  const incoming = data.edges.filter(e => e.target === id);
  const required = incoming.filter(e => !e.alternative);
  const options = incoming.filter(e => e.alternative);
  return required.every(e => done.has(e.source))
    && (options.length === 0 || options.some(e => done.has(e.source)));
}

// What still stands between the student and `id`, by the same rules as prereqsMet:
// each unplaced required prereq, plus "A or B" if none of the alternatives is placed
export function missingPrereqs(id: string, data: CourseMapData, done: Set<string>): string[] {
  const incoming = data.edges.filter(e => e.target === id);
  const missing = incoming.filter(e => !e.alternative && !done.has(e.source)).map(e => e.source);
  const options = incoming.filter(e => e.alternative).map(e => e.source);
  if (options.length > 0 && !options.some(o => done.has(o))) missing.push(options.join(" or "));
  return missing;
}

// Every course placed in semesters before `index`
export const doneBefore = (semesters: Semesters, index: number) =>
  new Set(semesters.slice(0, index).flat().map(courseOf));

// A retake has to come after the attempt it retakes; a first attempt always can
export function afterPreviousAttempt(key: string, index: number, semesters: Semesters): boolean {
  const attempt = attemptOf(key);
  if (attempt === 1) return true;
  const previous = attemptKey(courseOf(key), attempt - 1);
  return semesters.slice(0, index).some(ids => ids.includes(previous));
}

// Is `id` normally offered in `term`'s season? The catalog lists seasons ("Fall", "Spring", "Summer");
// a course with none listed is treated as offered every term
export function offeredIn(id: string, term: Term, data: CourseMapData): boolean {
  const seasons = data.nodes.find(n => n.id === id)?.terms ?? [];
  return seasons.length === 0 || seasons.includes(term.season);
}

// An attempt can go in a semester once its course's prereqs sit in an earlier semester,
// it's offered in that semester's season, and (for a retake) the failed attempt is earlier
export const canPlace = (key: string, index: number, semesters: Semesters, terms: Term[], data: CourseMapData) =>
  prereqsMet(courseOf(key), data, doneBefore(semesters, index))
  && offeredIn(courseOf(key), terms[index], data)
  && afterPreviousAttempt(key, index, semesters);

// ---------- Course results ----------
// What happened to a placed course. A course with no result is just planned.
export const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];

export type CourseResult =
  | { status: "passed"; grade: Grade }
  | { status: "transferred" }
  | { status: "failed" };

// attempt key -> its result
export type Results = Record<string, CourseResult>;

// The order the card's button steps through; null is "planned", and it wraps back around
const RESULT_CYCLE: (CourseResult | null)[] = [
  null,
  ...GRADES.map(grade => ({ status: "passed", grade }) as const),
  { status: "transferred" },
  { status: "failed" },
];

export const resultLabel = (r: CourseResult | undefined) =>
  !r ? "Planned" : r.status === "passed" ? `Passed · ${r.grade}` : r.status === "transferred" ? "Transferred" : "Failed";

// A course in a future term hasn't been taken yet, so it can only be planned or transferred in
const FUTURE_CYCLE: (CourseResult | null)[] = [null, { status: "transferred" }];

export function nextResult(current: CourseResult | undefined, future = false): CourseResult | null {
  const cycle = future ? FUTURE_CYCLE : RESULT_CYCLE;
  const index = cycle.findIndex(r => resultLabel(r ?? undefined) === resultLabel(current));
  return cycle[(index + 1) % cycle.length];
}

// Drop grades and fails from courses sitting in future terms (say, after their semester's
// term moved later or they were dragged into a later semester); transfers stay.
// `cleared` lists the attempts that lost their result.
export function clearFutureResults(semesters: Semesters, terms: Term[], results: Results, today = new Date()) {
  const kept: Results = { ...results };
  const cleared: string[] = [];
  semesters.forEach((keys, index) => {
    if (!isFuture(terms[index], today)) return;
    for (const key of keys) {
      if (kept[key] && kept[key].status !== "transferred") {
        delete kept[key];
        cleared.push(key);
      }
    }
  });
  return { results: kept, cleared };
}

// Keep results only for attempts still in a semester, and a retake only while the attempt
// before it is placed and failed. Dropping one can orphan the next (un-failing attempt 1
// drops retake 2, which drops its result, which drops retake 3), so repeat until nothing changes.
// `dropped` lists the placed retakes that were removed.
export function pruneAttempts(semesters: Semesters, results: Results) {
  const dropped: string[] = [];
  for (;;) {
    const placed = new Set(semesters.flat());
    const kept: Results = Object.fromEntries(Object.entries(results).filter(([key]) => placed.has(key)));
    const valid = (key: string) =>
      attemptOf(key) === 1 || kept[attemptKey(courseOf(key), attemptOf(key) - 1)]?.status === "failed";
    const removed = [...placed].filter(key => !valid(key));
    if (removed.length === 0 && Object.keys(kept).length === Object.keys(results).length) {
      return { semesters, results: kept, dropped };
    }
    dropped.push(...removed);
    semesters = semesters.map(keys => keys.filter(valid));
    results = kept;
  }
}

// Retakes waiting in the pool: the next attempt of every failed attempt that isn't placed yet
export const pendingRetakes = (semesters: Semesters, results: Results): string[] => {
  const placed = new Set(semesters.flat());
  return Object.entries(results)
    .filter(([, r]) => r.status === "failed")
    .map(([key]) => attemptKey(courseOf(key), attemptOf(key) + 1))
    .filter(key => !placed.has(key));
};

// Courses failed often enough that taking them again needs permission
export function needsPermission(results: Results): string[] {
  const fails = new Map<string, number>();
  for (const [key, r] of Object.entries(results)) {
    if (r.status === "failed") fails.set(courseOf(key), (fails.get(courseOf(key)) ?? 0) + 1);
  }
  return [...fails].filter(([, n]) => n >= PERMISSION_ATTEMPT - 1).map(([id]) => id);
}

// What the API takes: one entry per attempt with a result
export const resultList = (results: Results) =>
  Object.entries(results).map(([key, r]) => ({ course_id: courseOf(key), attempt: attemptOf(key), ...r }));

// Take `id` out of wherever it is and put it in semester `to` (null = back to the pool)
export function moveCourse(semesters: Semesters, id: string, to: number | null): Semesters {
  const next = semesters.map(ids => ids.filter(c => c !== id));
  if (to !== null) next[to] = [...next[to], id];
  return next;
}

// Send back to the pool any attempt that's no longer offered in its semester's season
// (`unoffered`), whose prereqs are no longer in an earlier semester (`bumped`), or that's
// a retake no longer after the attempt it retakes (`early`).
// Prereqs only point backwards, so one pass from the first semester onward catches
// chains (dropping CMSC201 bumps CMSC202, which then bumps CMSC341, ...)
export function settle(semesters: Semesters, terms: Term[], data: CourseMapData) {
  const done = new Set<string>(); // course ids, for prereqs
  const earlier = new Set<string>(); // attempts, for retakes
  const bumped: string[] = [];
  const unoffered: string[] = [];
  const early: string[] = [];
  const kept = semesters.map((keys, index) => {
    const stay: string[] = [];
    for (const key of keys) {
      const id = courseOf(key);
      if (!offeredIn(id, terms[index], data)) unoffered.push(key);
      else if (!prereqsMet(id, data, done)) bumped.push(key);
      else if (attemptOf(key) > 1 && !earlier.has(attemptKey(id, attemptOf(key) - 1))) early.push(key);
      else stay.push(key);
    }
    // only unlocks later semesters, not this one
    stay.forEach(key => { done.add(courseOf(key)); earlier.add(key); });
    return stay;
  });
  return { semesters: kept, bumped, unoffered, early };
}
