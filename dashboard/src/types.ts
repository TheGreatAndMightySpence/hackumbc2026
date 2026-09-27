export interface SalaryByYear {
  year: number;
  avg_salary: number | null;
  graduates?: number;
}

export interface InternshipSalary {
  internships: number;
  avg_salary: number;
  alumni: number;
}

export interface Major {
  major: string;
}

export type CourseType = "Core" | "Elective" | "General Education" | "Capstone";

export type CourseNodeInfo = {
  id: string;
  title: string;
  credits: number;
  type: CourseType;
  terms: string[];
  semester: number; // earliest semester you could take it, given prerequisites
  difficulty: number; // 1.0 gentle to 5.0 demanding
};

// GET /api/courses/{id}: one course's catalog entry plus how students have done in it
export interface CourseDetail {
  id: string;
  title: string;
  credits: number;
  level: "Lower" | "Upper";
  type: CourseType;
  difficulty: number;
  skills: string[];
  prerequisites: string[]; // each entry may read "A or B"
  required_for: string[];
  terms: string[];
  attempts: number; // finished attempts in transcripts
  avg_grade_points: number | null; // 4.0 scale, W excluded
  pass_rate: number | null; // 0-1, A through D
  withdraw_rate: number | null; // 0-1
}

export interface PrereqEdge {
  id: string;
  source: string; // prerequisite
  target: string; // course that needs it
  alternative: boolean; // part of an "A or B" requirement
}

export interface CourseMapData {
  nodes: CourseNodeInfo[];
  edges: PrereqEdge[];
}

export type MajorKey = "cs" | "info" | "both";

// A chart the AI assistant built with its make_chart tool
export interface AiChartSpec {
  type: "bar" | "line" | "scatter";
  title: string;
  x_key: string; // column in each data row for the x axis
  x_label: string;
  y_keys: string[]; // one series per column, 1-4 of them
  y_label: string;
  y_format: "dollars" | "number" | "percent";
  data: Record<string, string | number | null>[]; // the query's rows, passed straight to Recharts
  sql: string; // the query that produced data
}

export interface AskResponse {
  answer: string;
  charts: AiChartSpec[];
  cached: boolean;
}

// POST /api/ai/plan-advice: the AI's advice on the student's semester plan
export interface PlanAdviceResponse {
  answer: string;
}

// POST /api/ai/plan-intent: whether a typed question asks for advice or for a recommended schedule
export interface PlanIntentResponse {
  action: "advice" | "schedule";
  preferences: string; // for "schedule", the student's preferences as a short note
}

// POST /api/ai/plan-schedule: the student's plan with the rest of their courses added
export interface PlanScheduleResponse {
  semesters: string[][]; // attempt keys ("CMSC201", "CMSC201#2" for a retake), first to last
  terms: string[]; // each semester's term, e.g. "Fall 2027"
  added: string[]; // the attempt keys the recommendation added
  explanation: string; // markdown
  adjusted: boolean; // some of the AI's picks broke a rule, so the planner moved or replaced them
  unplaced: string[]; // required courses that didn't fit (almost always empty)
}

// POST /api/plan/progress: the planner's course results, totaled up
export interface PlanProgressResponse {
  credits_earned: number; // passed + transferred
  credits_transferred: number;
  credits_failed: number;
  gpa: number | null; // null until a course has a grade (transfer credit doesn't count)
}

// GET /api/explore/datasets: what the data explorer can chart
export interface ExploreField {
  key: string;
  label: string;
  kind: "number" | "category";
  format: "dollars" | "number" | "percent" | "plain" | null; // numbers only; plain has no commas (years)
  order: string[] | null; // categories with a natural order (Freshman, Sophomore, ...)
  description: string;
}

export interface ExploreDataset {
  id: string;
  label: string;
  noun: string; // what one row is, plural: "graduates"
  description: string;
  has_major: boolean; // can be filtered by major
  fields: ExploreField[];
}

// GET /api/explore/{dataset}: one row per graduate/student/job/course with a value for x (and y)
export interface ExploreRow {
  x: number | string;
  y?: number;
  label: string; // what the row is, never a student ID
}

export interface ExploreResponse {
  rows: ExploreRow[];
  count: number;
}

export interface TopQuestion {
  id: number;
  question: string; // as the student typed it
  simplified_question: string; // short normalized form
  major: MajorKey;
  answer: string;
  charts: AiChartSpec[];
  times_asked: number;
}