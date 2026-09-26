import { useState } from "react";
import "./App.css";

import type { PathId } from "./paths";
import PathPicker from "./components/PathPicker";
import PathPage from "./components/PathPage";

export default function App() {
  // null = nothing chosen yet, so show the picker first
  const [path, setPath] = useState<PathId | null>(null);

  if (path === null) {
    return <PathPicker onPick={setPath} />;
  }

  return <PathPage pathId={path} onChangePath={() => setPath(null)} />;
}
