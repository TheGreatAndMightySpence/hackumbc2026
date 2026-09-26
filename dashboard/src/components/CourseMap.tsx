import { useMemo, useState } from "react";
import {
  Background, Controls, Handle, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { useApi } from "../api";
import type { CourseMapData, CourseNodeInfo, CourseType } from "../types";

const NODE_W = 190;
const NODE_H = 78;
const ROW_GAP = 130; // vertical space per semester row

const TYPE_COLORS: Record<CourseType, string> = {
  Core: "#2563eb",
  Capstone: "#dc2626",
  Elective: "#16a34a",
  "General Education": "#9333ea",
};

// ---------- One box in the chart ----------
type CourseNode = Node<CourseNodeInfo & { dimmed: boolean }, "course">;

function CourseBox({ data, selected }: NodeProps<CourseNode>) {
  const color = TYPE_COLORS[data.type];
  return (
    <div
      style={{
        width: NODE_W, height: NODE_H, boxSizing: "border-box", padding: "6px 10px",
        background: "white", borderRadius: 8, fontSize: 12, lineHeight: 1.3,
        border: `2px solid ${color}`, borderLeftWidth: 8,
        boxShadow: selected ? `0 0 0 3px ${color}55` : "none",
        opacity: data.dimmed ? 0.25 : 1, transition: "opacity 150ms",
      }}
    >
      <Handle type="target" position={Position.Top} />
      <strong>{data.id}</strong> · {data.credits} cr
      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={data.title}>
        {data.title}
      </div>
      <div style={{ color: "#6b7280" }}>{data.terms.join(" / ")}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { course: CourseBox };

// ---------- Layout: dagre picks left/right order, semester picks the row ----------
function layout(data: CourseMapData): { nodes: CourseNode[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));
  data.nodes.forEach(n => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  data.edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const nodes: CourseNode[] = data.nodes.map(n => ({
    id: n.id,
    type: "course",
    position: { x: g.node(n.id).x - NODE_W / 2, y: (n.semester - 1) * ROW_GAP },
    data: { ...n, dimmed: false },
  }));

  // Forcing rows by semester can stack two boxes on top of each other,
  // so within each row keep dagre's left-to-right order but push overlaps apart
  const rows = new Map<number, CourseNode[]>();
  nodes.forEach(n => rows.set(n.position.y, [...(rows.get(n.position.y) ?? []), n]));
  rows.forEach(row => {
    row.sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < row.length; i++) {
      const minX = row[i - 1].position.x + NODE_W + 30;
      if (row[i].position.x < minX) row[i].position.x = minX;
    }
  });

  const edges: Edge[] = data.edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    style: e.alternative ? { strokeDasharray: "6 4" } : undefined,
    label: e.alternative ? "or" : undefined,
  }));

  return { nodes, edges };
}

// Every course you must take before `id` (walks prerequisite edges backwards)
function prerequisitesOf(id: string, edges: Edge[]): Set<string> {
  const found = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges) {
      if (e.target === cur && !found.has(e.source)) {
        found.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return found;
}

// ---------- The page section ----------
export default function CourseMap() {
  const [major, setMajor] = useState("Computer Science");
  const [electives, setElectives] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

  const { data, loading, error } = useApi<CourseMapData>(
    `/api/course-map/${encodeURIComponent(major)}?electives=${electives}`
  );

  const graph = useMemo(() => (data ? layout(data) : null), [data]);

  // Clicking a course highlights it and its whole prerequisite chain
  const view = useMemo(() => {
    if (!graph) return null;
    if (!focus) return graph;
    const keep = prerequisitesOf(focus, graph.edges);
    return {
      nodes: graph.nodes.map(n => ({ ...n, data: { ...n.data, dimmed: !keep.has(n.id) } })),
      edges: graph.edges.map(e => ({
        ...e,
        animated: keep.has(e.source) && keep.has(e.target),
        style: { ...e.style, opacity: keep.has(e.source) && keep.has(e.target) ? 1 : 0.15 },
      })),
    };
  }, [graph, focus]);

  const totalCredits = data?.nodes.reduce((sum, n) => sum + n.credits, 0) ?? 0;

  return (
    <section>
      <h2>Course map</h2>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <select value={major} onChange={e => { setMajor(e.target.value); setFocus(null); }}>
          <option>Computer Science</option>
          <option>Information Systems</option>
        </select>
        <label>
          <input type="checkbox" checked={electives} onChange={e => { setElectives(e.target.checked); setFocus(null); }} />{" "}
          Show electives
        </label>
        <span>{data?.nodes.length ?? 0} courses · {totalCredits} credits</span>
        {(Object.keys(TYPE_COLORS) as CourseType[]).map(t => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: TYPE_COLORS[t] }} /> {t}
          </span>
        ))}
      </div>
      <p style={{ margin: "0 0 8px", color: "#6b7280" }}>
        Each row is the earliest semester you could take a course. Click a course to trace its prerequisites.
      </p>

      {loading && <p>Loading…</p>}
      {error && <p>Couldn't load course map: {error}</p>}
      {/* Hide the chart while loading so it remounts and re-fits to the new graph */}
      {view && !loading && (
        <div style={{ height: 650, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <ReactFlow
            nodes={view.nodes}
            edges={view.edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_, n) => setFocus(f => (f === n.id ? null : n.id))}
            onPaneClick={() => setFocus(null)}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}