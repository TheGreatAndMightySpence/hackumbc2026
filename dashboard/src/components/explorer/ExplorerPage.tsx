import { useEffect, useMemo, useState } from "react";
import { useApi } from "../../api";
import type { ExploreDataset, ExploreField, ExploreResponse, ExploreRow } from "../../types";
import ExplorerChart from "./ExplorerChart";
import ExplorerStats from "./ExplorerStats";
import { AGGREGATES, OUTLIER_METHODS, type Aggregate, type OutlierMethod } from "./stats";
import { buildView, chartTypeFor, inSentence, type ChartType } from "./view";
import "../PathPage.css";
import "./Explorer.css";

interface Props {
  onBack: () => void;
}

const MAJORS = ["Computer Science", "Information Systems"];
const COUNT = ""; // the y option that charts how many rows fall at each x

// Rows from the API, with the choices that asked for them
interface Result {
  url: string;
  dataset: ExploreDataset;
  x: ExploreField;
  y: ExploreField | null;
  major: string;
  rows: ExploreRow[];
}

interface Setup {
  dataset: string;
  x: string;
  y: string; // COUNT for a count of rows
  type: ChartType;
}

// Where each dataset starts, and the questions offered as one-click starting points
const DEFAULTS: Record<string, Setup> = {
  alumni: { dataset: "alumni", x: "final_gpa", y: "first_job_annual_salary_usd", type: "scatter" },
  students: { dataset: "students", x: "class_level", y: "cumulative_gpa", type: "bar" },
  jobs: { dataset: "jobs", x: "seniority_level", y: "annual_salary_usd", type: "bar" },
  courses: { dataset: "courses", x: "difficulty_index", y: "pass_rate", type: "scatter" },
};

const PRESETS: { label: string; setup: Setup }[] = [
  { label: "Does GPA affect starting salary?", setup: DEFAULTS.alumni },
  { label: "Do internships pay off?",
    setup: { dataset: "alumni", x: "internship_count", y: "first_job_annual_salary_usd", type: "bar" } },
  { label: "Salary by job field",
    setup: { dataset: "jobs", x: "job_family", y: "annual_salary_usd", type: "bar" } },
  { label: "Starting salary over the years",
    setup: { dataset: "alumni", x: "graduation_year", y: "first_job_annual_salary_usd", type: "line" } },
  { label: "Are harder courses failed more?", setup: DEFAULTS.courses },
  { label: "How are GPAs spread out?",
    setup: { dataset: "students", x: "cumulative_gpa", y: COUNT, type: "bar" } },
];

export default function ExplorerPage({ onBack }: Props) {
  const { data: datasets, loading, error } = useApi<ExploreDataset[]>("/api/explore/datasets");

  return (
    <div className="path-page path-page--explore explorer">
      <header className="path-page__bar">
        <div className="path-page__title">
          <div>
            <p className="path-page__tagline">Real UMBC data</p>
            <h1>Explore the data</h1>
          </div>
        </div>
        <button type="button" className="path-page__change" onClick={onBack}>
          ← Back to paths
        </button>
      </header>

      <main className="path-page__content explorer__content">
        {loading && <p>Loading datasets…</p>}
        {error && <p className="explorer__error">Couldn't load the datasets: {error}</p>}
        {datasets && <Explorer datasets={datasets} />}
      </main>
    </div>
  );
}

function Explorer({ datasets }: { datasets: ExploreDataset[] }) {
  const [setup, setSetup] = useState<Setup>(DEFAULTS.alumni);
  const [agg, setAgg] = useState<Aggregate>("mean");
  const [major, setMajor] = useState("");
  const [method, setMethod] = useState<OutlierMethod>("iqr");
  const [hideOutliers, setHideOutliers] = useState(false);
  const [showTrend, setShowTrend] = useState(true);

  const dataset = datasets.find(d => d.id === setup.dataset) ?? datasets[0];
  const field = (key: string) => dataset.fields.find(f => f.key === key) ?? null;
  const x = field(setup.x) ?? dataset.fields[0];
  const y = setup.y === COUNT ? null : field(setup.y);
  const numbers = dataset.fields.filter(f => f.kind === "number");
  const categories = dataset.fields.filter(f => f.kind === "category");
  const type = chartTypeFor(setup.type, x, y);

  const byMajor = dataset.has_major ? major : "";
  const params = new URLSearchParams({ x: x.key });
  if (y) params.set("y", y.key);
  if (byMajor) params.set("major", byMajor);
  const url = `/api/explore/${dataset.id}?${params}`;

  // The rows on screen and the request they answer. While a new request is out, the old
  // chart stays up (dimmed) rather than flashing empty.
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<ExploreResponse>;
      })
      .then(data => {
        if (!cancelled) setResult({ url, dataset, x, y, major: byMajor, rows: data.rows });
      })
      .catch((err: Error) => { if (!cancelled) setFailure({ url, message: err.message }); });
    return () => { cancelled = true; };
    // dataset, x, y and byMajor come from the same state url is built from,
    // so url alone says when to refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  const failed = failure?.url === url ? failure.message : null;
  const stale = result !== null && result.url !== url && !failed;

  const view = useMemo(() => result && buildView(result.rows, {
    x: result.x, y: result.y, type: setup.type, agg, method, hideOutliers,
  }), [result, setup.type, agg, method, hideOutliers]);

  const pick = (patch: Partial<Setup>) => setSetup(s => ({ ...s, ...patch }));
  const pickDataset = (id: string) => setSetup(DEFAULTS[id] ?? { ...DEFAULTS.alumni, dataset: id });
  const swap = () => {
    if (y) pick({ x: y.key, y: x.kind === "number" ? x.key : COUNT });
  };

  const fieldOptions = (fields: ExploreField[]) =>
    fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>);

  return (
    <>
      <p className="explorer__lede">
        Pick a dataset and choose what goes on each axis. The page charts it, finds outliers and
        works out the statistics for you.
      </p>

      <div className="explorer__presets" role="group" aria-label="Example questions">
        <span className="explorer__label">Try a question</span>
        {PRESETS.map(p => (
          <button key={p.label} type="button" className="explorer__chip" onClick={() => setSetup(p.setup)}
            aria-pressed={JSON.stringify(p.setup) === JSON.stringify(setup)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="explorer__controls">
        <label className="explorer__control">
          <span className="explorer__label">Dataset</span>
          <select value={dataset.id} onChange={e => pickDataset(e.target.value)}>
            {datasets.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <span className="explorer__help">{dataset.description}</span>
        </label>

        <label className="explorer__control">
          <span className="explorer__label">X axis</span>
          <select value={x.key} onChange={e => pick({ x: e.target.value })}>
            <optgroup label="Numbers">{fieldOptions(numbers)}</optgroup>
            <optgroup label="Categories">{fieldOptions(categories)}</optgroup>
          </select>
          {x.description && <span className="explorer__help">{x.description}</span>}
        </label>

        <button type="button" className="explorer__swap" onClick={swap} disabled={!y}
          title="Swap the X and Y axes" aria-label="Swap the X and Y axes">⇄</button>

        <label className="explorer__control">
          <span className="explorer__label">Y axis</span>
          <select value={y ? y.key : COUNT} onChange={e => pick({ y: e.target.value })}>
            <option value={COUNT}>Number of {dataset.noun}</option>
            <optgroup label="Numbers">{fieldOptions(numbers)}</optgroup>
          </select>
          {y?.description && <span className="explorer__help">{y.description}</span>}
        </label>
      </div>

      <div className="explorer__controls explorer__controls--options">
        <div className="explorer__control">
          <span className="explorer__label">Chart</span>
          <div className="explorer__segmented" role="group" aria-label="Chart type">
            {(["scatter", "bar", "line"] as const).map(t => {
              const possible = chartTypeFor(t, x, y) === t;
              return (
                <button key={t} type="button" aria-pressed={type === t} disabled={!possible}
                  title={possible ? undefined : "A scatter plot needs numbers on both axes"}
                  onClick={() => pick({ type: t })}>
                  {t === "scatter" ? "Scatter" : t === "bar" ? "Bar" : "Line"}
                </button>
              );
            })}
          </div>
        </div>

        {type !== "scatter" && y && (
          <label className="explorer__control">
            <span className="explorer__label">Bar height</span>
            <select value={agg} onChange={e => setAgg(e.target.value as Aggregate)}>
              {(Object.keys(AGGREGATES) as Aggregate[]).map(a => (
                <option key={a} value={a}>{AGGREGATES[a]}</option>
              ))}
            </select>
          </label>
        )}

        <label className="explorer__control">
          <span className="explorer__label">Major</span>
          <select value={dataset.has_major ? major : ""} disabled={!dataset.has_major}
            onChange={e => setMajor(e.target.value)}>
            <option value="">{dataset.has_major ? "Both majors" : "Not by major"}</option>
            {MAJORS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <label className="explorer__control">
          <span className="explorer__label">Outliers</span>
          <select value={method} onChange={e => setMethod(e.target.value as OutlierMethod)}>
            {(Object.keys(OUTLIER_METHODS) as OutlierMethod[]).map(m => (
              <option key={m} value={m}>{OUTLIER_METHODS[m]}</option>
            ))}
          </select>
        </label>

        <div className="explorer__checks">
          <label>
            <input type="checkbox" checked={hideOutliers} onChange={e => setHideOutliers(e.target.checked)} />
            Leave out outliers
          </label>
          {type === "scatter" && (
            <label>
              <input type="checkbox" checked={showTrend} onChange={e => setShowTrend(e.target.checked)} />
              Trend line
            </label>
          )}
        </div>
      </div>

      {failed && <p className="explorer__error">Couldn't load the data: {failed}</p>}
      {!view && !failed && <p>Loading data…</p>}
      {view && result && (
        <div className={`explorer__results${stale ? " explorer__results--stale" : ""}`} aria-busy={stale}>
          <figure className="explorer__card explorer__figure">
            <figcaption>
              {result.y ? result.y.label : `Number of ${result.dataset.noun}`} by{" "}
              {inSentence(result.x.label)}
              <span className="explorer__caption-note">
                {result.dataset.label}{result.major ? ` · ${result.major}` : ""}
              </span>
            </figcaption>
            <ExplorerChart view={view} x={result.x} y={result.y} agg={agg} noun={result.dataset.noun}
              showTrend={showTrend} />
          </figure>
          <ExplorerStats view={view} x={result.x} y={result.y} agg={agg} method={method}
            noun={result.dataset.noun} hideOutliers={hideOutliers} />
        </div>
      )}
    </>
  );
}
