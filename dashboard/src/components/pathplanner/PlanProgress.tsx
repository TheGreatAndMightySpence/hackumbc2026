import { useEffect, useState } from "react";
import type { PlanProgressResponse } from "../../types";
import type { Results } from "./planLogic";

interface Props {
  results: Results; // sent as-is; the server looks each course's credits up in the catalog
}

// Sends the student's course results to the API whenever they change, and shows the totals it sends back
export default function PlanProgress({ results }: Props) {
  const [progress, setProgress] = useState<PlanProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const body = JSON.stringify({ results });
  const empty = Object.keys(results).length === 0;

  useEffect(() => {
    if (empty) return;
    let cancelled = false;
    fetch("/api/plan/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<PlanProgressResponse>;
      })
      .then(data => { if (!cancelled) { setProgress(data); setError(null); } })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [body, empty]);

  if (empty) return null;
  if (error) return <p className="planner__progress">Couldn't total your results: {error}</p>;
  if (!progress) return null;

  return (
    <p className="planner__progress">
      <span><strong>{progress.credits_earned}</strong> credits earned</span>
      {progress.credits_transferred > 0 && <span>{progress.credits_transferred} transferred</span>}
      {progress.credits_failed > 0 && <span className="planner__over">{progress.credits_failed} failed</span>}
      <span>GPA <strong>{progress.gpa?.toFixed(2) ?? "—"}</strong></span>
    </p>
  );
}
