import { useState } from "react";
import type { PlanAdviceResponse } from "../../types";
import MarkdownText from "../MarkdownText";
import type { Semesters } from "./planLogic";
import "./PlanAdvisor.css";

interface Props {
  major: string; // "Computer Science" | "Information Systems"
  semesters: Semesters; // sent as-is; the server looks each course up in the catalog
}

// Asks the AI about the plan as it stands: an empty question gets a general review
export default function PlanAdvisor({ major, semesters }: Props) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [askedPlan, setAskedPlan] = useState<string | null>(null); // the plan the answer is about
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = JSON.stringify(semesters);
  const stale = answer !== null && askedPlan !== plan;

  async function ask(q: string) {
    setAsked(q || null);
    setAnswer(null);
    setError(null);
    setLoading(true);
    setAskedPlan(plan);
    try {
      const res = await fetch("/api/ai/plan-advice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ major, semesters, question: q }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as PlanAdviceResponse;
      setAnswer(data.answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="plan-advisor">
      <div className="plan-advisor__head">
        <h2>Ask the advisor</h2>
        <button type="button" onClick={() => ask("")} disabled={loading}>
          Review my plan
        </button>
      </div>
      <p className="plan-advisor__hint">
        The advisor sees the courses you've put in each semester. Ask about your plan, or get a quick review.
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
        <button type="submit" disabled={!question.trim() || loading}>Ask</button>
      </form>

      {asked && <p className="plan-advisor__question">You asked: "{asked}"</p>}
      {loading && <p className="plan-advisor__answer">Looking over your plan…</p>}
      {error && <p className="plan-advisor__answer">Couldn't get advice: {error}</p>}
      {answer && <MarkdownText className="plan-advisor__answer">{answer}</MarkdownText>}
      {stale && (
        <p className="plan-advisor__stale">
          Your plan has changed since you asked. Ask again for advice on the new plan.
        </p>
      )}
    </section>
  );
}
