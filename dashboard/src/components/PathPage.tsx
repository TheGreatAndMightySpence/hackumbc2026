import { getPath, type PathId } from "../paths";
import PathIcon from "./PathIcon";
import SalaryByYearChart from "./SalaryByYearChart";
import InternshipChart from "./InternshipChart";
import CourseMap from "./CourseMap";
import QuickInformation from "./QuickInformation";
import AiQuery from "./AiQuery";
import "./PathPage.css";

interface Props {
  pathId: PathId;
  onChangePath: () => void;
}

export default function PathPage({ pathId, onChangePath }: Props) {
  const path = getPath(pathId);

  return (
    <div className={`path-page path-page--${path.id}`}>
      <header className="path-page__bar">
        <div className="path-page__title">
          <span className="path-page__icon"><PathIcon id={path.id} /></span>
          <div>
            <p className="path-page__tagline">{path.tagline}</p>
            <h1>{path.title}</h1>
          </div>
        </div>
        <button type="button" className="path-page__change" onClick={onChangePath}>
          ← Change path
        </button>
      </header>

      {/* TODO: pass path.majors into these so they only show the chosen major(s),
          and for "both" render CS and Information Systems side by side */}
      <main className="path-page__content">
        <h1>What would you like to know?</h1>
        <QuickInformation majors={path.majors} />
        <AiQuery majors={path.majors} />
        <CourseMap />
        <SalaryByYearChart />
        <InternshipChart />
      </main>
    </div>
  );
}
