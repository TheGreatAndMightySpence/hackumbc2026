import type { CourseMapData, CourseNodeInfo } from "../../types";

// semester index -> course ids placed in it
export type Semesters = string[][];

// ---------- Terms ----------
// Seasons in calendar order, so Spring 2027 < Summer 2027 < Fall 2027
export const SEASONS = ["Spring", "Summer", "Fall"] as const;
export type Season = (typeof SEASONS)[number];

export interface Term {
  season: Season;
  year: number;
}

export const termLabel = (t: Term) => `${t.season} ${t.year}`;
const termOrder = (t: Term) => t.year * SEASONS.length + SEASONS.indexOf(t.season);

// The term to plan first: the coming Fall until August, then the coming Spring
export function firstTerm(today = new Date()): Term {
  return today.getMonth() < 7
    ? { season: "Fall", year: today.getFullYear() }
    : { season: "Spring", year: today.getFullYear() + 1 };
}

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

// Everything placed in semesters before `index`
export const doneBefore = (semesters: Semesters, index: number) =>
  new Set(semesters.slice(0, index).flat());

// Is `id` normally offered in `term`'s season? The catalog lists seasons ("Fall", "Spring", "Summer");
// a course with none listed is treated as offered every term
export function offeredIn(id: string, term: Term, data: CourseMapData): boolean {
  const seasons = data.nodes.find(n => n.id === id)?.terms ?? [];
  return seasons.length === 0 || seasons.includes(term.season);
}

// A course can go in a semester once its prereqs sit in an earlier semester
// and it's offered in that semester's season
export const canPlace = (id: string, index: number, semesters: Semesters, terms: Term[], data: CourseMapData) =>
  prereqsMet(id, data, doneBefore(semesters, index)) && offeredIn(id, terms[index], data);

// ---------- Course results ----------
// What happened to a placed course. A course with no result is just planned.
export const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];

export type CourseResult =
  | { status: "passed"; grade: Grade }
  | { status: "transferred" }
  | { status: "failed" };

// course id -> its result; sent to the API as-is
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

export function nextResult(current: CourseResult | undefined): CourseResult | null {
  const index = RESULT_CYCLE.findIndex(r => resultLabel(r ?? undefined) === resultLabel(current));
  return RESULT_CYCLE[(index + 1) % RESULT_CYCLE.length];
}

// Only keep results for courses still in a semester
export const pruneResults = (results: Results, semesters: Semesters): Results => {
  const placed = new Set(semesters.flat());
  return Object.fromEntries(Object.entries(results).filter(([id]) => placed.has(id)));
};

// Take `id` out of wherever it is and put it in semester `to` (null = back to the pool)
export function moveCourse(semesters: Semesters, id: string, to: number | null): Semesters {
  const next = semesters.map(ids => ids.filter(c => c !== id));
  if (to !== null) next[to] = [...next[to], id];
  return next;
}

// Send back to the pool any course that's no longer offered in its semester's season
// (`unoffered`), or whose prereqs are no longer in an earlier semester (`bumped`).
// Prereqs only point backwards, so one pass from the first semester onward catches
// chains (dropping CMSC201 bumps CMSC202, which then bumps CMSC341, ...)
export function settle(semesters: Semesters, terms: Term[], data: CourseMapData) {
  const done = new Set<string>();
  const bumped: string[] = [];
  const unoffered: string[] = [];
  const kept = semesters.map((ids, index) => {
    const stay: string[] = [];
    for (const id of ids) {
      if (!offeredIn(id, terms[index], data)) unoffered.push(id);
      else if (!prereqsMet(id, data, done)) bumped.push(id);
      else stay.push(id);
    }
    stay.forEach(id => done.add(id)); // only unlocks later semesters, not this one
    return stay;
  });
  return { semesters: kept, bumped, unoffered };
}
