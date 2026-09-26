import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "../api";
import type { Major, SalaryByYear } from "../types";
import { dollars, dollarsK } from "../format";

export default function SalaryByYearChart() {
  const [major, setMajor] = useState<string>("");

  const majors = useApi<Major[]>("/api/majors");
  const url = major ? `/api/salary-by-year/${encodeURIComponent(major)}` : "/api/salary-by-year";
  const salary = useApi<SalaryByYear[]>(url);

  return (
    <section>
      <h2>Average starting salary by graduation year</h2>

      <select value={major} onChange={e => setMajor(e.target.value)}>
        <option value="">All majors</option>
        {majors.data?.map(m => (
          <option key={m.major} value={m.major}>{m.major}</option>
        ))}
      </select>

      {salary.loading && <p>Loading…</p>}
      {salary.error && <p>Couldn't load data: {salary.error}</p>}
      {salary.data && (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={salary.data} margin={{ top: 16, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="year" />
            <YAxis tickFormatter={dollarsK} />
            <Tooltip formatter={(v) => dollars(Number(v))} />
            <Line type="monotone" dataKey="avg_salary" name="Avg salary" stroke="#2563eb" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}