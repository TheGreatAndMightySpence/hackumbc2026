import type { ExploreField } from "../../types";
import {
  AGGREGATES, OUTLIER_METHODS, correlationWords, skewWords,
  type Aggregate, type OutlierMethod, type Summary,
} from "./stats";
import { formatFor, inSentence, type View } from "./view";

interface Props {
  view: View;
  x: ExploreField;
  y: ExploreField | null;
  agg: Aggregate;
  method: OutlierMethod;
  noun: string;
  hideOutliers: boolean;
}

const MAX_OUTLIERS_LISTED = 25;
const MAX_ROWS_LISTED = 200;

const pct = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)}%`;

// Statistic name, how to read it, and how to pull it from a summary. Spreads (std dev, IQR)
// print in the field's own units, so they use the same formatter as the values.
const SUMMARY_ROWS: [string, string, (s: Summary) => number, boolean][] = [
  ["Count", "How many values", s => s.n, false],
  ["Mean", "The average", s => s.mean, true],
  ["Median", "The middle value: half are below, half above", s => s.median, true],
  ["Std deviation", "How far values typically sit from the mean", s => s.std, true],
  ["Minimum", "", s => s.min, true],
  ["1st quartile (Q1)", "25% of values are below this", s => s.q1, true],
  ["3rd quartile (Q3)", "75% of values are below this", s => s.q3, true],
  ["Maximum", "", s => s.max, true],
  ["IQR", "Q3 − Q1: the spread of the middle half", s => s.iqr, true],
  ["Skewness", "0 is symmetric; positive has a tail of high values", s => s.skewness, false],
];

export default function ExplorerStats({ view, x, y, agg, method, noun, hideOutliers }: Props) {
  const fx = formatFor(x);
  const fy = formatFor(y);
  const measure = view.measure;
  const fm = formatFor(measure);
  const ms = view.measureSummary;
  const n = view.rows.length;
  const outlierCount = view.outliers.length;

  // Plain-language findings, most useful first
  const findings: string[] = [];
  if (view.fit && y) {
    const { r, r2, slope } = view.fit;
    findings.push(
      `There is a ${correlationWords(r)} relationship between ${inSentence(x.label)} and `
      + `${inSentence(y.label)} (r = ${r.toFixed(2)}). The trend line explains `
      + `${(r2 * 100).toFixed(1)}% of the variation in ${inSentence(y.label)}.`,
    );
    findings.push(
      `On the trend line, each 1-point increase in ${inSentence(x.label)} goes with a change of `
      + `${slope < 0 ? "−" : "+"}${fy.full(Math.abs(slope))} in ${inSentence(y.label)}. `
      + "A relationship like this doesn't prove one causes the other.",
    );
  }
  const best = view.groups.length > 1
    ? view.groups.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const worst = view.groups.length > 1
    ? view.groups.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  if (best && worst) {
    const what = y ? `${AGGREGATES[agg].toLowerCase()} ${inSentence(y.label)}` : `number of ${noun}`;
    const val = (v: number) => (y ? fy.full(v) : v.toLocaleString());
    findings.push(`Highest ${what}: ${best.name} (${val(best.value)}). Lowest: ${worst.name} (${val(worst.value)}).`);
  }
  if (measure && ms) {
    findings.push(
      `${measure.label} is ${skewWords(ms.skewness)}: the mean is ${fm.full(ms.mean)} and the median is `
      + `${fm.full(ms.median)}.`,
    );
    const fences = view.fences!;
    findings.push(outlierCount
      ? `${outlierCount.toLocaleString()} of ${view.total.toLocaleString()} ${noun} (${pct(outlierCount, view.total)}) `
        + `are outliers: ${inSentence(measure.label)} below ${fm.full(fences.low)} or above ${fm.full(fences.high)}.`
        + (hideOutliers ? " They're left out of the chart and the statistics." : "")
      : `No ${noun} are outliers in ${inSentence(measure.label)} by the ${OUTLIER_METHODS[method]}.`);
  }

  const columns = [
    ...(view.xSummary ? [{ field: x, s: view.xSummary, f: fx }] : []),
    ...(view.ySummary ? [{ field: y!, s: view.ySummary, f: fy }] : []),
  ];

  return (
    <section className="explorer__stats" aria-label="Statistics">
      <div className="explorer__tiles">
        <div className="explorer__tile">
          <span className="explorer__tile-label">{noun[0].toUpperCase() + noun.slice(1)} charted</span>
          <span className="explorer__tile-value">{n.toLocaleString()}</span>
          {n !== view.total && <span className="explorer__tile-note">of {view.total.toLocaleString()}</span>}
        </div>
        {view.fit && (
          <div className="explorer__tile">
            <span className="explorer__tile-label">Correlation (r)</span>
            <span className="explorer__tile-value">{view.fit.r.toFixed(2)}</span>
            <span className="explorer__tile-note">{correlationWords(view.fit.r)}</span>
          </div>
        )}
        {view.fit && (
          <div className="explorer__tile">
            <span className="explorer__tile-label">R²</span>
            <span className="explorer__tile-value">{view.fit.r2.toFixed(3)}</span>
            <span className="explorer__tile-note">variation explained</span>
          </div>
        )}
        {view.ySummary && (
          <div className="explorer__tile">
            <span className="explorer__tile-label">Median {inSentence(y!.label)}</span>
            <span className="explorer__tile-value">{fy.full(view.ySummary.median)}</span>
            <span className="explorer__tile-note">mean {fy.full(view.ySummary.mean)}</span>
          </div>
        )}
        {measure && (
          <div className="explorer__tile">
            <span className="explorer__tile-label">Outliers</span>
            <span className="explorer__tile-value">{outlierCount.toLocaleString()}</span>
            <span className="explorer__tile-note">{pct(outlierCount, view.total)} of {noun}</span>
          </div>
        )}
      </div>

      {findings.length > 0 && (
        <div className="explorer__card">
          <h2>What the data shows</h2>
          <ul className="explorer__findings">
            {findings.map(f => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      {view.fit && y && (
        <p className="explorer__equation">
          Trend line: {y.label} = {fy.full(view.fit.intercept)} {view.fit.slope < 0 ? "−" : "+"}{" "}
          {fy.full(Math.abs(view.fit.slope))} × {x.label}
        </p>
      )}

      {columns.length > 0 && (
        <div className="explorer__card">
          <h2>Summary statistics</h2>
          <div className="explorer__table explorer__table--full">
            <table>
              <thead>
                <tr>
                  <th>Statistic</th>
                  {columns.map(c => <th key={c.field.key} className="num">{c.field.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {SUMMARY_ROWS.map(([name, help, get, inUnits]) => (
                  <tr key={name}>
                    <td>
                      {name}
                      {help && <span className="explorer__help">{help}</span>}
                    </td>
                    {columns.map(c => (
                      <td key={c.field.key} className="num">
                        {inUnits ? c.f.full(get(c.s)) : get(c.s).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {measure && ms && (
        <div className="explorer__card">
          <h2>Outliers in {inSentence(measure.label)}</h2>
          <p className="explorer__note">
            Using the {OUTLIER_METHODS[method]}, anything below {fm.full(view.fences!.low)} or
            above {fm.full(view.fences!.high)} is an outlier.
          </p>
          {outlierCount > 0 && (
            <div className="explorer__table">
              <table>
                <thead>
                  <tr>
                    <th>{noun[0].toUpperCase() + noun.slice(1, -1)}</th>
                    <th className="num">{x.label}</th>
                    {y && <th className="num">{y.label}</th>}
                    <th className="num">Z-score</th>
                  </tr>
                </thead>
                <tbody>
                  {view.outliers.slice(0, MAX_OUTLIERS_LISTED).map((o, i) => (
                    <tr key={i}>
                      <td>{o.row.label}</td>
                      <td className="num">{typeof o.row.x === "number" ? fx.full(o.row.x) : o.row.x}</td>
                      {y && <td className="num">{fy.full(o.row.y!)}</td>}
                      <td className="num">{o.z > 0 ? "+" : ""}{o.z.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {outlierCount > MAX_OUTLIERS_LISTED && (
                <p className="explorer__note">
                  Showing the {MAX_OUTLIERS_LISTED} most extreme of {outlierCount.toLocaleString()}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {view.groups.length > 0 && (
        <div className="explorer__card">
          <h2>By {inSentence(x.label)}</h2>
          <div className="explorer__table">
            <table>
              <thead>
                <tr>
                  <th>{x.label}</th>
                  <th className="num">{noun[0].toUpperCase() + noun.slice(1)}</th>
                  {y && (
                    <>
                      <th className="num">Mean</th>
                      <th className="num">Median</th>
                      <th className="num">Std dev</th>
                      <th className="num">Min</th>
                      <th className="num">Max</th>
                      <th className="num">Outliers</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {view.groups.map(g => (
                  <tr key={g.name}>
                    <td>{g.name}</td>
                    <td className="num">{g.n.toLocaleString()}</td>
                    {g.summary && (
                      <>
                        <td className="num">{fy.full(g.summary.mean)}</td>
                        <td className="num">{fy.full(g.summary.median)}</td>
                        <td className="num">{fy.full(g.summary.std)}</td>
                        <td className="num">{fy.full(g.summary.min)}</td>
                        <td className="num">{fy.full(g.summary.max)}</td>
                        <td className="num">{g.outliers}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {y && <p className="explorer__note">Outliers here are within each group, by the same rule.</p>}
        </div>
      )}

      {view.type === "scatter" && (
        <details className="explorer__card explorer__raw">
          <summary>Show the data</summary>
          <div className="explorer__table">
            <table>
              <thead>
                <tr>
                  <th>{noun[0].toUpperCase() + noun.slice(1, -1)}</th>
                  <th className="num">{x.label}</th>
                  <th className="num">{y!.label}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.slice(0, MAX_ROWS_LISTED).map((r, i) => (
                  <tr key={i}>
                    <td>{r.label}</td>
                    <td className="num">{fx.full(r.x as number)}</td>
                    <td className="num">{fy.full(r.y!)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {n > MAX_ROWS_LISTED && (
            <p className="explorer__note">Showing the first {MAX_ROWS_LISTED} of {n.toLocaleString()}.</p>
          )}
        </details>
      )}
    </section>
  );
}
