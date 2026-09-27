import { useEffect, useRef } from "react";
import { useApi } from "../../api";
import type { CourseDetail } from "../../types";

// 1.0 gentle to 5.0 demanding; the catalog's courses run 1.6-4.4, centered near 3
const difficultyLabel = (d: number) => (d < 2.5 ? "Gentle" : d < 3.5 ? "Moderate" : "Demanding");

export function Difficulty({ value }: { value: number }) {
  const label = difficultyLabel(value);
  return (
    <div className={`planner__difficulty planner__difficulty--${label.toLowerCase()}`}>
      <span className="planner__meter" aria-hidden="true">
        <span style={{ width: `${(value / 5) * 100}%` }} />
      </span>
      <span>Difficulty {value.toFixed(1)}/5 · {label}</span>
    </div>
  );
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

// The catalog has no description text, so this describes the course from its catalog
// entry and from how past students did in it
function Description({ course }: { course: CourseDetail }) {
  const division = course.level === "Upper" ? "upper-division" : "lower-division";
  const kind = course.type === "General Education" ? "general education" : course.type.toLowerCase();

  return (
    <>
      <p>
        A {course.credits}-credit {division} {kind} course
        {course.skills.length > 0 && <> covering {course.skills.join(", ")}</>}.
        {course.required_for.length > 0 && <> Required for {course.required_for.join(" and ")}.</>}
      </p>

      <dl className="planner__facts">
        <dt>Prerequisites</dt>
        {/* Every group is required; "A or B" inside a group means either one */}
        <dd>
          {course.prerequisites.length === 0 ? "None" : course.prerequisites.map(group => (
            <span key={group} className="planner__tag">{group}</span>
          ))}
        </dd>
        <dt>Offered</dt>
        <dd>{course.terms.join(", ")}</dd>
        <dt>Difficulty</dt>
        <dd><Difficulty value={course.difficulty} /></dd>
      </dl>

      <h3>How students have done</h3>
      {course.attempts === 0 ? (
        <p className="planner__muted">No finished attempts on record yet.</p>
      ) : (
        <dl className="planner__facts">
          <dt>Average grade</dt>
          <dd>{course.avg_grade_points?.toFixed(2) ?? "—"} / 4.0</dd>
          <dt>Passed</dt>
          <dd>{percent(course.pass_rate ?? 0)}</dd>
          <dt>Withdrew</dt>
          <dd>{percent(course.withdraw_rate ?? 0)}</dd>
          <dt>Attempts</dt>
          <dd>{course.attempts.toLocaleString()}</dd>
        </dl>
      )}
    </>
  );
}

interface Props {
  courseId: string;
  onClose: () => void;
}

// Modal popup for one course. <dialog> handles Escape, focus and the backdrop for us.
export default function CourseDetails({ courseId, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data, loading, error } = useApi<CourseDetail>(`/api/courses/${encodeURIComponent(courseId)}`);

  useEffect(() => {
    // StrictMode runs this twice in dev; showModal() on an open dialog throws in some browsers
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="planner__dialog"
      aria-labelledby="course-details-title"
      onClose={onClose}
      // The dialog has no padding (the inner div does), so a click that lands on the
      // <dialog> itself was on the backdrop
      onClick={e => { if (e.target === e.currentTarget) ref.current?.close(); }}
    >
      <div className="planner__dialog-body">
        <header>
          <h2 id="course-details-title">
            {courseId}{data && <span>{data.title}</span>}
          </h2>
          <button type="button" aria-label="Close" onClick={() => ref.current?.close()}>×</button>
        </header>

        {loading && <p>Loading…</p>}
        {error && <p>Couldn't load this course: {error}</p>}
        {data && <Description course={data} />}
      </div>
    </dialog>
  );
}
