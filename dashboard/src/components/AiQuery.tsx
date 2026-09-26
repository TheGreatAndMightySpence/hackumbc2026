import { useState } from "react";
import { majorKey } from "../paths";
import type { AiChartSpec, AskResponse } from "../types";
import AiChart from "./AiChart";
import MarkdownText from "./MarkdownText";
import "./AiQuery.css";

interface Props {
  majors?: string[]; // the page's major(s); questions that don't name a major are assumed to be about these
}

export default function AiQuery({ majors = [] }: Props) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [charts, setCharts] = useState<AiChartSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    setAsked(q);
    setAnswer(null);
    setCharts([]);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, major: majorKey(majors) }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as AskResponse;
      setAnswer(data.answer);
      setCharts(data.charts ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ai-query">
      <h2>Ask a question</h2>
      <p>Type a question about the program, and we'll try to answer it. We can even provide graphs and visualizations.</p>
      <form
        className="ai-query__form"
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
          placeholder="e.g. Can you show me a graph of earnings per gpa?"
          aria-label="Your question"
        />
        <button type="submit" disabled={!question.trim() || loading}>Ask</button>
      </form>
      {asked && <p className="ai-query__question">You asked: "{asked}"</p>}
      {loading && <p className="ai-query__answer">Thinking…</p>}
      {error && <p className="ai-query__answer">Couldn't get an answer: {error}</p>}
      {answer && <MarkdownText className="ai-query__answer">{answer}</MarkdownText>}
      {charts.map((chart, i) => <AiChart key={i} chart={chart} />)}
    </section>
  );
}
