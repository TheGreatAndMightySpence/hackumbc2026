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
};

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

export interface TopQuestion {
  id: number;
  question: string; // as the student typed it
  simplified_question: string; // short normalized form
  major: MajorKey;
  answer: string;
  charts: AiChartSpec[];
  times_asked: number;
}