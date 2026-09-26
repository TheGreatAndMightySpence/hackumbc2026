import type { MajorKey } from "./types";

// The three ways into the app. `majors` is the value(s) the API uses for this path.
export type PathId = "cs" | "it" | "both";

export interface PathOption {
  id: PathId;
  title: string;
  tagline: string;
  description: string;
  majors: string[];
}

export const PATHS: PathOption[] = [
  {
    id: "cs",
    title: "Computer Science",
    tagline: "Build the software",
    description: "Programming, algorithms, systems and AI. See the course map, where CS grads land, and what they earn.",
    majors: ["Computer Science"],
  },
  {
    id: "it",
    title: "InfoTech",
    tagline: "Run the technology",
    description: "Information Systems: databases, business analytics, security management and IT strategy.",
    majors: ["Information Systems"],
  },
  {
    id: "both",
    title: "Explore both",
    tagline: "Compare side by side",
    description: "Not sure yet? Put the two majors next to each other: courses, careers and outcomes.",
    majors: ["Computer Science", "Information Systems"],
  },
];

export const getPath = (id: PathId): PathOption => PATHS.find(p => p.id === id)!;

const MAJOR_KEYS: Record<string, MajorKey> = {
  "Computer Science": "cs",
  "Information Systems": "info",
};

// The key the AI endpoints use for a page: one major -> that major, several (or none) -> "both"
export const majorKey = (majors: string[] = []): MajorKey =>
  majors.length === 1 ? MAJOR_KEYS[majors[0]] ?? "both" : "both";
