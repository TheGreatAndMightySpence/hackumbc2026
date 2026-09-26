import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type { AiChartSpec } from "../types";
import { dollars, dollarsK } from "../format";
import "./AiChart.css";

// Categorical hues in fixed order (series 1 is always blue), never cycled; the API caps charts at 4 series
const SERIES_COLORS = ["#2563eb", "#eb6834", "#1baf7a", "#eda100"];

const FORMATS = {
  dollars: { tick: dollarsK, full: dollars },
  number: { tick: (v: number) => v.toLocaleString(), full: (v: number) => v.toLocaleString() },
  percent: { tick: (v: number) => `${Math.round(v)}%`, full: (v: number) => `${v.toFixed(1)}%` },
};

// "avg_salary" -> "Avg salary"
const pretty = (key: string) => {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export default function AiChart({ chart }: { chart: AiChartSpec }) {
  const fmt = FORMATS[chart.y_format] ?? FORMATS.number;
  const margin = { top: 16, right: 16, bottom: 24, left: 8 };
  const xAxisLabel = { value: chart.x_label, position: "insideBottom" as const, offset: -16 };
  const yAxisLabel = { value: chart.y_label, angle: -90, position: "insideLeft" as const, offset: 0 };
  const tooltipValue = (v: unknown) => fmt.full(Number(v));
  const legend = chart.y_keys.length > 1 && <Legend verticalAlign="top" height={32} />;

  let plot;
  if (chart.type === "line") {
    plot = (
      <LineChart data={chart.data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={chart.x_key} label={xAxisLabel} />
        <YAxis tickFormatter={fmt.tick} label={yAxisLabel} width={72} />
        <Tooltip formatter={tooltipValue} labelFormatter={l => `${chart.x_label}: ${l}`} />
        {legend}
        {chart.y_keys.map((key, i) => (
          <Line key={key} type="monotone" dataKey={key} name={pretty(key)}
            stroke={SERIES_COLORS[i]} strokeWidth={2} dot={{ r: 4 }} />
        ))}
      </LineChart>
    );
  } else if (chart.type === "scatter") {
    const y = chart.y_keys[0];
    plot = (
      <ScatterChart margin={margin}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" dataKey={chart.x_key} name={chart.x_label} label={xAxisLabel}
          domain={["auto", "auto"]} />
        <YAxis type="number" dataKey={y} name={pretty(y)} tickFormatter={fmt.tick}
          label={yAxisLabel} width={72} domain={["auto", "auto"]} />
        <Tooltip formatter={(v, name) => (name === pretty(y) ? tooltipValue(v) : String(v))} />
        <Scatter data={chart.data} fill={SERIES_COLORS[0]} fillOpacity={0.6} />
      </ScatterChart>
    );
  } else {
    plot = (
      <BarChart data={chart.data} margin={margin}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={chart.x_key} label={xAxisLabel} />
        <YAxis tickFormatter={fmt.tick} label={yAxisLabel} width={72} />
        <Tooltip formatter={tooltipValue} labelFormatter={l => `${chart.x_label}: ${l}`} />
        {legend}
        {chart.y_keys.map((key, i) => (
          <Bar key={key} dataKey={key} name={pretty(key)} fill={SERIES_COLORS[i]}
            radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    );
  }

  return (
    <figure className="ai-chart">
      <figcaption>{chart.title}</figcaption>
      <ResponsiveContainer width="100%" height={300}>
        {plot}
      </ResponsiveContainer>
      <details className="ai-chart__data">
        <summary>Show data</summary>
        <div className="ai-chart__table">
          <table>
            <thead>
              <tr>{Object.keys(chart.data[0] ?? {}).map(c => <th key={c}>{pretty(c)}</th>)}</tr>
            </thead>
            <tbody>
              {chart.data.map((row, i) => (
                <tr key={i}>{Object.values(row).map((v, j) => <td key={j}>{v ?? "—"}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
