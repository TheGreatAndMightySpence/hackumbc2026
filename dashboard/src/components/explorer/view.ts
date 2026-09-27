// Turns the rows the API sent into what the explorer draws: scatter points or bar/line groups,
// outliers, summaries and a trend line. Pure functions, no React.

import { dollars, dollarsK } from "../../format";
import type { ExploreField, ExploreRow } from "../../types";
import {
  aggregate, binIndex, makeBins, outlierFences, regression, summarize,
  type Aggregate, type OutlierMethod, type Regression, type Summary,
} from "./stats";

export type ChartType = "scatter" | "bar" | "line";

export interface Format {
  full: (v: number) => string; // tooltips and tables
  tick: (v: number) => string; // axis ticks
}

const plain = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

// A null field is a count of rows
export function formatFor(field: ExploreField | null): Format {
  switch (field?.format) {
    case "dollars": return { full: dollars, tick: dollarsK };
    case "percent": return { full: v => `${v.toFixed(1)}%`, tick: v => `${Number(v.toFixed(1))}%` };
    case "plain": return { full: v => String(Math.round(v * 100) / 100), tick: v => String(v) };
    default: return { full: plain, tick: plain };
  }
}

// A label mid-sentence: "Final GPA" -> "final GPA", but "GPA" and "IQR" stay as they are
export const inSentence = (label: string) =>
  /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);

// A scatter plot needs numbers on both axes; anything else falls back to bars
export function chartTypeFor(wanted: ChartType, x: ExploreField, y: ExploreField | null): ChartType {
  if (wanted !== "scatter") return wanted;
  return x.kind === "number" && y?.kind === "number" ? "scatter" : "bar";
}

export interface Group {
  name: string;
  value: number; // the aggregate of y, or the count when charting counts
  n: number;
  summary: Summary | null; // of y; null when charting counts
  outliers: number | null; // within this group, by the same rule; null when charting counts
}

export interface Outlier {
  row: ExploreRow;
  value: number; // the measured value
  z: number; // standard deviations from the mean
}

export interface View {
  type: ChartType;
  total: number; // rows the API sent
  rows: ExploreRow[]; // rows charted: all of them, or all but the outliers when hidden
  points: ExploreRow[]; // scatter: the rows that aren't outliers
  outlierPoints: ExploreRow[]; // scatter: the outliers, unless hidden
  groups: Group[]; // bar and line
  measure: ExploreField | null; // what outliers are measured on: y, or x when charting counts
  measureSummary: Summary | null; // of the measure over every row, before any are hidden
  fences: { low: number; high: number } | null;
  outliers: Outlier[]; // most extreme first
  xSummary: Summary | null; // of the charted rows, when x is a number
  ySummary: Summary | null;
  fit: Regression | null; // when both axes are numbers
}

export interface ViewOptions {
  x: ExploreField;
  y: ExploreField | null; // null charts the count of rows
  type: ChartType;
  agg: Aggregate;
  method: OutlierMethod;
  hideOutliers: boolean;
}

// Integers with this many distinct values or fewer get a bar each (years, internship counts);
// anything else is split into ranges
const MAX_DISTINCT_BARS = 30;

export function buildView(all: ExploreRow[], opts: ViewOptions): View {
  const { x, y, method } = opts;
  const type = chartTypeFor(opts.type, x, y);
  const xNum = x.kind === "number";

  // Outliers are measured on y, or on x when counting rows by a number
  const measure = y ?? (xNum ? x : null);
  const measureOf = (r: ExploreRow) => (y ? r.y! : (r.x as number));
  const measureSummary = measure ? summarize(all.map(measureOf)) : null;
  const fences = measureSummary ? outlierFences(measureSummary, method) : null;
  const isOutlier = (r: ExploreRow) =>
    fences !== null && (measureOf(r) < fences.low || measureOf(r) > fences.high);

  const outliers: Outlier[] = fences
    ? all.filter(isOutlier)
      .map(row => ({
        row,
        value: measureOf(row),
        z: measureSummary!.std ? (measureOf(row) - measureSummary!.mean) / measureSummary!.std : 0,
      }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    : [];

  const rows = opts.hideOutliers ? all.filter(r => !isOutlier(r)) : all;
  const xs = xNum ? rows.map(r => r.x as number) : [];
  const ys = y ? rows.map(r => r.y!) : [];

  return {
    type,
    total: all.length,
    rows,
    points: type === "scatter" ? rows.filter(r => !isOutlier(r)) : [],
    outlierPoints: type === "scatter" ? rows.filter(isOutlier) : [],
    groups: type === "scatter" ? [] : groupRows(rows, opts, type),
    measure,
    measureSummary,
    fences,
    outliers,
    xSummary: xNum ? summarize(xs) : null,
    ySummary: y ? summarize(ys) : null,
    fit: xNum && y ? regression(xs, ys) : null,
  };
}

function groupRows(rows: ExploreRow[], opts: ViewOptions, type: ChartType): Group[] {
  const { x, y } = opts;
  const buckets = new Map<string, { sort: number; ys: number[]; n: number }>();
  const put = (name: string, sort: number, r: ExploreRow) => {
    const b = buckets.get(name) ?? { sort, ys: [], n: 0 };
    b.n += 1;
    if (y) b.ys.push(r.y!);
    buckets.set(name, b);
  };

  if (x.kind === "category") {
    for (const r of rows) put(String(r.x), 0, r);
  } else if (rows.length) {
    const xs = rows.map(r => r.x as number);
    const distinct = new Set(xs);
    const fmt = formatFor(x);
    if (distinct.size <= MAX_DISTINCT_BARS && xs.every(Number.isInteger)) {
      for (const r of rows) put(fmt.full(r.x as number), r.x as number, r);
    } else {
      const bins = makeBins(Math.min(...xs), Math.max(...xs));
      for (const r of rows) {
        const b = bins[binIndex(bins, r.x as number)];
        put(`${fmt.tick(b.start)}–${fmt.tick(b.end)}`, b.start, r);
      }
    }
  }

  const sortKey = new Map([...buckets].map(([name, b]) => [name, b.sort]));
  const groups: Group[] = [...buckets].map(([name, b]) => {
    const summary = y ? summarize(b.ys) : null;
    let outliers: number | null = null;
    if (summary) {
      const f = outlierFences(summary, opts.method);
      outliers = b.ys.filter(v => v < f.low || v > f.high).length;
    }
    return { name, n: b.n, summary, outliers, value: summary ? aggregate(summary, opts.agg) : b.n };
  });

  if (x.kind === "number") {
    groups.sort((a, b) => sortKey.get(a.name)! - sortKey.get(b.name)!);
  } else if (x.order) {
    // Natural order (Freshman, Sophomore, ...); anything not listed goes last
    const rank = (name: string) => {
      const i = x.order!.indexOf(name);
      return i === -1 ? x.order!.length : i;
    };
    groups.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  } else if (type === "bar") {
    groups.sort((a, b) => b.value - a.value);
  } else {
    groups.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}
