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