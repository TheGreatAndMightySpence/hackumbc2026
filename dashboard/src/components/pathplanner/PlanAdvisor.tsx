import { useState } from "react";
import type { PlanAdviceResponse, PlanScheduleResponse } from "../../types";
import MarkdownText from "../MarkdownText";
import { courseOf, parseTerm, resultList, type Results, type Semesters, type Term } from "./planLogic";
import "./PlanAdvisor.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
  semesters: Semesters; // sent as course ids (a retake repeats its id); the server looks each up in the catalog
  terms: string[]; // each semester's term, e.g. "Fall 2027"
  results: Results; // courses already passed / transferred / failed
  onSchedule: (semesters: Semesters, terms: Term[]) => void; // put a recommended schedule in the planner
  onUndo?: () => void; // set while the recommended schedule can still be taken back
}

// Asks the AI about the plan as it stands: an empty question gets a general review.
// It can also fill in the rest of the plan; whatever is typed in the box is sent as preferences.
export default function PlanAdvisor({ major, semesters, terms, results, onSchedule, onUndo }: Props) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null); // what the answer is responding to
  const [answer, setAnswer] = useState<string | null>(null);
  const [askedPlan, setAskedPlan] = useState<string | null>(null); // the plan the answer is about
  const [loading, setLoading] = useState<"advice" | "schedule" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = JSON.stringify({ semesters, terms, results });
  const stale = answer !== null && askedPlan !== plan;
  const body = (extra: object) => JSON.stringify({
    major,
    semesters: semesters.map(keys => keys.map(courseOf)),
    terms,
    results: resultList(results),
    ...extra,
  });

  async function post<T>(url: string, extra: object): Promise<T> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(extra) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  async function ask(q: string) {
    setAsked(q ? `You asked: "${q}"` : null);
    setAnswer(null);
    setError(null);
    setLoading("advice");
    setAskedPlan(plan);
    try {
      const data = await post<PlanAdviceResponse>("/api/ai/plan-advice", { question: q });
      setAnswer(data.answer);
    } catch (err) {
      setError(`Couldn't get advice: ${(err as Error).message}`);
    } finally {
      setLoading(null);
    }
  }

  async function recommend(note: string) {
    setAsked(note ? `Recommended schedule for: "${note}"` : "Recommended schedule");
    setAnswer(null);
    setError(null);
    setLoading("schedule");
    try {
      const data = await post<PlanScheduleResponse>("/api/ai/plan-schedule", { note });
      const nextTerms = data.terms.map(parseTerm);
      if (nextTerms.some(t => t === null)) throw new Error("the schedule came back with a term the planner can't read");
      onSchedule(data.semesters, nextTerms as Term[]);
      // The explanation is about the plan as recommended, so it only goes stale once the student changes that
      setAskedPlan(JSON.stringify({ semesters: data.semesters, terms: data.terms, results }));
      const notes = [
        data.adjusted && "_A few of the AI's picks broke a planner rule, so the planner moved or replaced them; the semesters below may differ slightly from this explanation._",
        data.unplaced.length > 0 && `_Couldn't fit ${data.unplaced.join(", ")}; add ${data.unplaced.length > 1 ? "them" : "it"} by hand._`,
      ].filter(Boolean);
      setAnswer([data.explanation, ...notes].join("\n\n"));
    } catch (err) {
      setError(`Couldn't build a schedule: ${(err as Error).message}`);
    } finally {
      setLoading(null);
    }
  }

  return (
    <section className="plan-advisor">
      <div className="plan-advisor__head">
        <h2>Ask the advisor</h2>
        <div className="plan-advisor__actions">
          <button type="button" onClick={() => ask("")} disabled={loading !== null}>
            Review my plan
          </button>
          <button
            type="button"
            onClick={() => {
              const note = question.trim();
              setQuestion("");
              recommend(note);
            }}
            disabled={loading !== null}
            title="Keeps your courses where they are and adds the rest. Anything in the box below is sent as your preferences."
          >
            Make me a recommended schedule
          </button>
        </div>
      </div>
      <p className="plan-advisor__hint">
        The advisor sees the courses you've put in each semester. Ask about your plan, or get a quick review.
        For a recommended schedule, type your preferences first (e.g. "I'm into AI, keep semesters light").
      </p>
      <form
        className="plan-advisor__form"
        onSubmit={e => {
          e.preventDefault(); // stop the browser from reloading the page
          const trimmed = question.trim();
          if (!trimmed || loading) return;
          setQuestion("");
          ask(trimmed);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="e.g. Is semester 3 too hard? What should I take next?"
          aria-label="Your question about your plan"
        />
        <button type="submit" disabled={!question.trim() || loading !== null}>Ask</button>
      </form>

      {asked && <p className="plan-advisor__question">{asked}</p>}
      {loading === "advice" && <p className="plan-advisor__answer">Looking over your plan…</p>}
      {loading === "schedule" && (
        <p className="plan-advisor__answer">Building your schedule… this can take a minute or two.</p>
      )}
      {error && <p className="plan-advisor__answer">{error}</p>}
      {answer && <MarkdownText className="plan-advisor__answer">{answer}</MarkdownText>}
      {onUndo && (
        <p className="plan-advisor__undo">
          The recommended schedule is in your planner below.{" "}
          <button type="button" onClick={onUndo}>Undo</button>
        </p>
      )}
      {stale && (
        <p className="plan-advisor__stale">
          Your plan has changed since you asked. Ask again for advice on the new plan.
        </p>
      )}
    </section>
  );
}
