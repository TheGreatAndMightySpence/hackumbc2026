import { PATHS, type PathId } from "../paths";
import PathIcon from "./PathIcon";
import "./PathPicker.css";

interface Props {
  onPick: (id: PathId) => void;
}

export default function PathPicker({ onPick }: Props) {
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
    </div>
  );
}
