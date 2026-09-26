import { useState } from "react";
import "./AiQuery.css";

export default function AiQuery() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    setAsked(q);
    setAnswer(null);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { answer: string };
      setAnswer(data.answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="ai-query">
      <h2>Ask a question</h2>
      <p>Type a question about the program, and we'll try to answer it.</p>
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
          placeholder="e.g. What is the salary increase per year?"
          aria-label="Your question"
        />
        <button type="submit" disabled={!question.trim() || loading}>Ask</button>
      </form>
      {asked && <p className="ai-query__question">You asked: "{asked}"</p>}
      {loading && <p className="ai-query__answer">Thinking…</p>}
      {error && <p className="ai-query__answer">Couldn't get an answer: {error}</p>}
      {answer && <p className="ai-query__answer">{answer}</p>}
    </section>
  );
}
