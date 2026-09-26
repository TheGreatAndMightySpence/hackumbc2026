import { useState } from "react";
import "./AiQuery.css";

export default function AiQuery() {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  return (
    <section className="ai-query">
      <h2>Ask a question</h2>
      <p>Type a question about the program, and we'll try to answer it.</p>
      <form
        className="ai-query__form"
        onSubmit={e => {
          e.preventDefault(); // stop the browser from reloading the page
          const trimmed = question.trim();
          if (!trimmed) return;
          setAsked(trimmed);
          setQuestion("");
        }}
      >
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="e.g. What is the salary increase per year?"
          aria-label="Your question"
        />
        <button type="submit" disabled={!question.trim()}>Ask</button>
      </form>
      {/* TODO: send the question to a natural-language endpoint once one exists */}
      {asked && <p className="ai-query__answer">You asked: "{asked}". Answers aren't hooked up yet.</p>}
    </section>
  );
}
