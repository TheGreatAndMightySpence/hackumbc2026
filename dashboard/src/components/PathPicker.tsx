import { PATHS, type PathId } from "../paths";
import PathIcon from "./PathIcon";
import "./PathPicker.css";

interface Props {
  onPick: (id: PathId) => void;
  onPlan: () => void;
}

export default function PathPicker({ onPick, onPlan }: Props) {
  return (
    <div className="picker">
      <header className="picker__header">
        <p className="picker__eyebrow">UMBC Tech Pathways</p>
        <h1>See what path is right for you</h1>
        <p className="picker__lede">
          Pick a path to see its courses, careers and outcomes, drawn from real graduate data.
        </p>
      </header>

      <div className="picker__grid">
        {PATHS.map(path => (
          <button
            key={path.id}
            type="button"
            className={`picker__card picker__card--${path.id}`}
            onClick={() => onPick(path.id)}
          >
            <span className="picker__icon"><PathIcon id={path.id} /></span>
            <span className="picker__tagline">{path.tagline}</span>
            <span className="picker__title">{path.title}</span>
            <span className="picker__desc">{path.description}</span>
            <span className="picker__cta">
              {path.id === "both" ? "Compare" : "Start"} <span aria-hidden>→</span>
            </span>
          </button>
        ))}
      </div>

      <button type="button" className="picker__plan" onClick={onPlan}>
        <span className="picker__icon">
          {/* calendar */}
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <line x1="8" y1="3" x2="8" y2="7" />
            <line x1="16" y1="3" x2="16" y2="7" />
          </svg>
        </span>
        <span className="picker__plan-text">
          <span className="picker__tagline">Already know your path?</span>
          <span className="picker__title">Plan your time at UMBC</span>
          <span className="picker__desc">
            Lay out your semesters, map courses to each term and see how your four years fit together.
          </span>
        </span>
        <span className="picker__cta">
          Plan <span aria-hidden>→</span>
        </span>
      </button>
    </div>
  );
}
