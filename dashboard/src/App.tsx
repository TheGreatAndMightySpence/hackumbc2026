import { useState } from "react";
import "./App.css";

import type { PathId } from "./paths";
import PathPicker from "./components/PathPicker";
import PathPage from "./components/PathPage";
import PlannerPage from "./components/PlannerPage";
import ExplorerPage from "./components/explorer/ExplorerPage";

export default function App() {
  // null = nothing chosen yet, so show the picker first
  const [path, setPath] = useState<PathId | null>(null);
  const [planning, setPlanning] = useState(false);
  const [exploring, setExploring] = useState(false);

  if (planning) {
    return <PlannerPage onBack={() => setPlanning(false)} />;
  }

  if (exploring) {
    return <ExplorerPage onBack={() => setExploring(false)} />;
  }

  if (path === null) {
    return <PathPicker onPick={setPath} onPlan={() => setPlanning(true)} onExplore={() => setExploring(true)} />;
  }

  return <PathPage pathId={path} onChangePath={() => setPath(null)} />;
}
