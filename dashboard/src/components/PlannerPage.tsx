import { useState } from "react";
import CoursePlanner from "./pathplanner/CoursePlanner";
import "./PathPage.css";

interface Props {
  onBack: () => void;
}

// major -> the page theme it switches to (blue for CS, green for IS)
const MAJORS: Record<string, string> = {
  "Computer Science": "cs",
  "Information Systems": "it",
};

export default function PlannerPage({ onBack }: Props) {
  const [major, setMajor] = useState("");
  const theme = MAJORS[major] ?? "plan";

  return (
    <div className={`path-page path-page--${theme}`}>
      <header className="path-page__bar">
        <div className="path-page__title">
          <div>
            <p className="path-page__tagline">Your four years</p>
            <h1>Plan your time at UMBC</h1>
          </div>
        </div>
        <button type="button" className="path-page__change" onClick={onBack}>
          ← Back to paths
        </button>
      </header>

      <main className="path-page__content">
        <label className="path-page__select">
          <span>Your major</span>
          <div className="path-page__select-box">
            <select value={major} onChange={e => setMajor(e.target.value)}>
              <option value="" disabled>Choose a major…</option>
              {Object.keys(MAJORS).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </label>
        {/* key resets the picks when the major changes */}
        {major
          ? <CoursePlanner key={major} major={major} />
          : <p>Pick a major to start planning your semesters.</p>}
      </main>
    </div>
  );
}
