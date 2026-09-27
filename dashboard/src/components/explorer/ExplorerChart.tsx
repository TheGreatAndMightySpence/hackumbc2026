import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type { ExploreField, ExploreRow } from "../../types";
import { AGGREGATES, type Aggregate } from "./stats";
import { formatFor, inSentence, type Group, type View } from "./view";

interface Props {
  view: View;
  x: ExploreField;
  y: ExploreField | null; // null charts the count of rows
  agg: Aggregate;
  noun: string; // "graduates"
  showTrend: boolean;
}

// Colors live in Explorer.css (--viz-*) so dark mode gets its own validated steps
const DATA = "var(--viz-data)";
const OUTLIER = "var(--viz-outlier)";
const INK = "var(--text-h)";
const GRID = "var(--border)";
const TICK = { fill: "var(--text)", fontSize: 13 };
const MARGIN = { top: 16, right: 24, bottom: 32, left: 16 };

// Long category names ("Consulting & Professional Services") would crowd the axis
const shorten = (s: string) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);

export default function ExplorerChart({ view, x, y, agg, noun, showTrend }: Props) {
  const fx = formatFor(x);
  const fy = formatFor(y);
  const yName = y ? (view.type === "scatter" ? y.label : `${AGGREGATES[agg]} ${inSentence(y.label)}`)
    : `Number of ${noun}`;
  const xAxisLabel = { value: x.label, position: "insideBottom" as const, offset: -20, fill: "var(--text)" };
  const yAxisLabel = { value: yName, angle: -90, position: "insideLeft" as const, offset: 0,
    style: { textAnchor: "middle" as const }, fill: "var(--text)" };

  if (view.rows.length === 0) {
    return <p className="explorer__empty">No {noun} have values for both of these.</p>;
  }

  if (view.type === "scatter") {
    const fit = view.fit;
    const xMin = view.xSummary!.min;
    const xMax = view.xSummary!.max;
    return (
      <>
        <ResponsiveContainer width="100%" height={420}>
          <ScatterChart margin={MARGIN}>
            <CartesianGrid stroke={GRID} />
            <XAxis type="number" dataKey="x" name={x.label} domain={["auto", "auto"]}
              tickFormatter={fx.tick} tick={TICK} stroke={GRID} label={xAxisLabel} />
            <YAxis type="number" dataKey="y" name={y!.label} domain={["auto", "auto"]}
              tickFormatter={fy.tick} tick={TICK} stroke={GRID} label={yAxisLabel} width={84} />
            <Tooltip cursor={{ stroke: GRID }} content={({ active, payload }) => {
              const row = payload?.[0]?.payload as ExploreRow | undefined;
              return active && row ? (
                <div className="explorer__tip">
                  <strong>{row.label}</strong>
                  <span>{x.label}: {fx.full(row.x as number)}</span>
                  <span>{y!.label}: {fy.full(row.y!)}</span>
                </div>
              ) : null;
            }} />
            <Scatter name={noun} data={view.points} fill={DATA} fillOpacity={0.55}
              stroke="var(--bg)" strokeWidth={1} isAnimationActive={false} />
            {view.outlierPoints.length > 0 && (
              <Scatter name="Outliers" data={view.outlierPoints} fill={OUTLIER} shape="diamond"
                stroke="var(--bg)" strokeWidth={1} isAnimationActive={false} />
            )}
            {showTrend && fit && (
              <ReferenceLine ifOverflow="hidden" stroke={INK} strokeWidth={2}
                segment={[
                  { x: xMin, y: fit.intercept + fit.slope * xMin },
                  { x: xMax, y: fit.intercept + fit.slope * xMax },
                ]} />
            )}
          </ScatterChart>
        </ResponsiveContainer>
        <ul className="explorer__legend">
          <li><span className="explorer__key explorer__key--dot" />{noun[0].toUpperCase() + noun.slice(1)}</li>
          {view.outlierPoints.length > 0 && (
            <li><span className="explorer__key explorer__key--diamond" />Outliers</li>
          )}
          {showTrend && fit && <li><span className="explorer__key explorer__key--line" />Trend line</li>}
        </ul>
      </>
    );
  }

  // Bar and line charts plot one value per group
  // Category names get angled once they'd crowd; numbers and ranges are short enough to stay flat
  const angled = x.kind === "category" && view.groups.length > 6;
  const xAxis = (
    <XAxis dataKey="name" tick={TICK} stroke={GRID} interval={angled ? 0 : "preserveStartEnd"}
      tickFormatter={shorten} angle={angled ? -35 : 0} textAnchor={angled ? "end" : "middle"}
      height={angled ? 110 : 40} label={angled ? undefined : xAxisLabel} />
  );
  const yAxis = <YAxis tickFormatter={fy.tick} tick={TICK} stroke={GRID} label={yAxisLabel} width={84} />;
  const tooltip = (
    <Tooltip cursor={{ fill: "color-mix(in srgb, var(--text) 8%, transparent)" }}
      content={({ active, payload }) => {
        const g = payload?.[0]?.payload as Group | undefined;
        return active && g ? (
          <div className="explorer__tip">
            <strong>{g.name}</strong>
            <span>{yName}: {y ? fy.full(g.value) : g.value.toLocaleString()}</span>
            {y && <span>{g.n.toLocaleString()} {noun}</span>}
          </div>
        ) : null;
      }} />
  );

  return (
    <>
      <ResponsiveContainer width="100%" height={angled ? 460 : 400}>
        {view.type === "line" ? (
          <LineChart data={view.groups} margin={MARGIN}>
            <CartesianGrid stroke={GRID} vertical={false} />
            {xAxis}
            {yAxis}
            {tooltip}
            <Line dataKey="value" name={yName} stroke={DATA} strokeWidth={2} isAnimationActive={false}
              dot={{ r: 4, fill: DATA, stroke: "var(--bg)", strokeWidth: 2 }}
              activeDot={{ r: 6, fill: DATA, stroke: "var(--bg)", strokeWidth: 2 }} />
          </LineChart>
        ) : (
          <BarChart data={view.groups} margin={MARGIN}>
            <CartesianGrid stroke={GRID} vertical={false} />
            {xAxis}
            {yAxis}
            {tooltip}
            <Bar dataKey="value" name={yName} fill={DATA} maxBarSize={24} radius={[4, 4, 0, 0]}
              isAnimationActive={false} />
          </BarChart>
        )}
      </ResponsiveContainer>
      {angled && <p className="explorer__axis-note">{x.label}</p>}
    </>
  );
}
