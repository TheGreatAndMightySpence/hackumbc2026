import "./PathPage.css";

interface Props {
  onBack: () => void;
}

// TODO: the actual planner (semesters, courses per term, credit totals)
export default function PlannerPage({ onBack }: Props) {
  return (
    <div className="path-page path-page--plan">
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
        <p>Semester planning is coming soon.</p>
      </main>
    </div>
  );
}
