import { useState } from "react";
import type { CourseNodeInfo, PlanAdviceResponse } from "../../types";
import { attemptName, courseOf, gpaOf, resultLabel, resultList, type Results, type Semesters } from "./planLogic";
import type { PdfSemester } from "./planPdf";
import "./PlanExport.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
  semesters: Semesters;
  terms: string[]; // each semester's term, e.g. "Fall 2027"
  results: Results;
  courses: Map<string, CourseNodeInfo>; // course id -> catalog info, for titles and credits
}

// Downloads the plan as a PDF, semester by semester with credits and GPA.
// Can add the advisor's review of the plan (the same one "Review my plan" gives), fetched fresh at export.
export default function PlanExport({ major, semesters, terms, results, courses }: Props) {
  const [withSummary, setWithSummary] = useState(false);
  const [busy, setBusy] = useState<"summary" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const creditsOf = (key: string) => courses.get(courseOf(key))?.credits ?? 0;
  const creditsIn = (keys: string[]) => keys.reduce((sum, key) => sum + creditsOf(key), 0);
  const earnedIn = (keys: string[]) =>
    creditsIn(keys.filter(key => results[key] && results[key].status !== "failed"));

  async function fetchSummary(): Promise<string> {
    const res = await fetch("/api/ai/plan-advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        major,
        semesters: semesters.map(keys => keys.map(courseOf)),
        terms,
        results: resultList(results),
        question: "",
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return ((await res.json()) as PlanAdviceResponse).answer;
  }

  async function exportPdf() {
    setError(null);
    let summary: string | null = null;
    if (withSummary) {
      setBusy("summary");
      try {
        summary = await fetchSummary();
      } catch (err) {
        setError(`Couldn't get the summary: ${(err as Error).message}. Uncheck it to export without one.`);
        setBusy(null);
        return;
      }
    }

    setBusy("pdf");
    try {
      const pdfSemesters: PdfSemester[] = semesters.map((keys, index) => ({
        heading: `Semester ${index + 1} · ${terms[index]}`,
        courses: keys.map(key => ({
          name: attemptName(key),
          title: courses.get(courseOf(key))?.title ?? "",
          credits: creditsOf(key),
          result: resultLabel(results[key]),
        })),
        credits: creditsIn(keys),
        earned: earnedIn(keys),
        termGpa: gpaOf(keys, results, creditsOf),
        cumulativeGpa: gpaOf(semesters.slice(0, index + 1).flat(), results, creditsOf),
      }));
      const all = semesters.flat();
      // Loaded on first export, so the PDF library stays out of the page's main bundle
      const { downloadPlanPdf } = await import("./planPdf");
      downloadPlanPdf(
        {
          major,
          semesters: pdfSemesters,
          credits: creditsIn(all),
          earned: earnedIn(all),
          gpa: gpaOf(all, results, creditsOf),
          summary,
        },
        `${major.toLowerCase().replace(/\s+/g, "-")}-course-plan.pdf`,
      );
    } catch (err) {
      setError(`Couldn't make the PDF: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const empty = semesters.length === 0;

  return (
    <section className="plan-export">
      <div className="plan-export__text">
        <h2>Export your plan</h2>
        <p>
          {empty
            ? "Add a semester to export your plan."
            : "A PDF of every semester's courses, with credits taken and GPA."}
        </p>
      </div>
      <label className="plan-export__option" title='The same review "Review my plan" gives, added at the end'>
        <input
          type="checkbox"
          checked={withSummary}
          onChange={e => setWithSummary(e.target.checked)}
          disabled={busy !== null}
        />
        Include an advisor summary
      </label>
      <button type="button" onClick={exportPdf} disabled={empty || busy !== null}>
        {busy === "summary" ? "Writing summary…" : busy === "pdf" ? "Making PDF…" : "Download PDF"}
      </button>
      {error && <p className="plan-export__error" role="alert">{error}</p>}
    </section>
  );
}
