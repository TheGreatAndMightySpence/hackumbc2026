// Descriptive statistics for the data explorer. Pure functions, no React.

export interface Summary {
  n: number;
  sum: number;
  mean: number;
  median: number;
  std: number; // sample standard deviation (n - 1)
  min: number;
  max: number;
  q1: number;
  q3: number;
  iqr: number;
  skewness: number; // 0 symmetric, > 0 a long tail of high values, < 0 of low values
}

// Linear interpolation between closest ranks (what Excel's QUARTILE.INC and numpy use)
export function quantile(sorted: number[], p: number): number {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function summarize(values: number[]): Summary | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sq = values.reduce((a, v) => a + (v - mean) ** 2, 0);
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  const popStd = Math.sqrt(sq / n);
  const skewness = popStd > 0 ? values.reduce((a, v) => a + ((v - mean) / popStd) ** 3, 0) / n : 0;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return {
    n, sum, mean, std, skewness, q1, q3,
    median: quantile(sorted, 0.5),
    min: sorted[0],
    max: sorted[n - 1],
    iqr: q3 - q1,
  };
}

export type OutlierMethod = "iqr" | "zscore";

export const OUTLIER_METHODS: Record<OutlierMethod, string> = {
  iqr: "IQR rule (1.5 × IQR past the quartiles)",
  zscore: "Z-score (more than 3 std devs from the mean)",
};

// Values outside [low, high] are outliers
export function outlierFences(s: Summary, method: OutlierMethod): { low: number; high: number } {
  if (method === "zscore") return { low: s.mean - 3 * s.std, high: s.mean + 3 * s.std };
  return { low: s.q1 - 1.5 * s.iqr, high: s.q3 + 1.5 * s.iqr };
}

export interface Regression {
  slope: number;
  intercept: number;
  r: number; // Pearson correlation, -1 to 1
  r2: number; // share of y's variation the line explains
}

// Least-squares line y = intercept + slope * x
export function regression(xs: number[], ys: number[]): Regression | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0 || syy === 0) return null; // a flat line in x or y has no correlation
  const slope = sxy / sxx;
  const r = sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: my - slope * mx, r, r2: r * r };
}

// "strong positive", "weak negative", ... for a correlation coefficient
export function correlationWords(r: number): string {
  const a = Math.abs(r);
  const strength = a >= 0.7 ? "strong" : a >= 0.4 ? "moderate" : a >= 0.2 ? "weak" : "little or no";
  if (strength === "little or no") return "little or no";
  return `${strength} ${r > 0 ? "positive" : "negative"}`;
}

export function skewWords(skew: number): string {
  if (Math.abs(skew) < 0.5) return "roughly symmetric";
  return skew > 0 ? "skewed right (a tail of high values)" : "skewed left (a tail of low values)";
}

export type Aggregate = "mean" | "median" | "count" | "sum" | "min" | "max";

export const AGGREGATES: Record<Aggregate, string> = {
  mean: "Average",
  median: "Median",
  count: "Count",
  sum: "Total",
  min: "Minimum",
  max: "Maximum",
};

export function aggregate(s: Summary, agg: Aggregate): number {
  return agg === "count" ? s.n : s[agg];
}

// Rounds a bin width up to 1, 2, 2.5 or 5 times a power of ten, so bin edges read cleanly
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(m => m * pow >= raw)!;
  return step * pow;
}

export interface Bin {
  start: number;
  end: number;
}

// Equal-width bins covering [min, max], about `target` of them
export function makeBins(min: number, max: number, target = 12): Bin[] {
  if (min === max) return [{ start: min, end: max }];
  const step = niceStep((max - min) / target);
  const first = Math.floor(min / step) * step;
  const edge = (i: number) => Number((first + i * step).toPrecision(12)); // no 0.6000000001 edges
  const bins: Bin[] = [];
  // max itself goes in the last bin (see binIndex), so a GPA of 4.0 doesn't get a "4–4.25" bar
  for (let i = 0; i === 0 || edge(i) < max; i++) {
    bins.push({ start: edge(i), end: edge(i + 1) });
  }
  return bins;
}

// Index of the bin a value lands in; the last bin also takes its upper edge
export function binIndex(bins: Bin[], v: number): number {
  const step = bins[0].end - bins[0].start;
  if (step === 0) return 0;
  return Math.min(bins.length - 1, Math.floor((v - bins[0].start) / step));
}
