import type { CourseMapData, CourseNodeInfo } from "../../types";

// semester index -> course ids placed in it
export type Semesters = string[][];

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

// Everything placed in semesters before `index`
export const doneBefore = (semesters: Semesters, index: number) =>
  new Set(semesters.slice(0, index).flat());

// A course can go in a semester once its prereqs sit in an earlier semester
export const canPlace = (id: string, index: number, semesters: Semesters, data: CourseMapData) =>
  prereqsMet(id, data, doneBefore(semesters, index));

// Take `id` out of wherever it is and put it in semester `to` (null = back to the pool)
export function moveCourse(semesters: Semesters, id: string, to: number | null): Semesters {
  const next = semesters.map(ids => ids.filter(c => c !== id));
  if (to !== null) next[to] = [...next[to], id];
  return next;
}

// Send back to the pool any course whose prereqs are no longer in an earlier semester.
// Prereqs only point backwards, so one pass from the first semester onward catches
// chains (dropping CMSC201 bumps CMSC202, which then bumps CMSC341, ...)
export function settle(semesters: Semesters, data: CourseMapData) {
  const done = new Set<string>();
  const bumped: string[] = [];
  const kept = semesters.map(ids => {
    const stay: string[] = [];
    for (const id of ids) {
      if (prereqsMet(id, data, done)) stay.push(id);
      else bumped.push(id);
    }
    stay.forEach(id => done.add(id)); // only unlocks later semesters, not this one
    return stay;
  });
  return { semesters: kept, bumped };
}
