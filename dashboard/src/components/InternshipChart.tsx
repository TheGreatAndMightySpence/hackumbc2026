import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "../api";
import type { InternshipSalary } from "../types";
import { dollars, dollarsK } from "../format";

export default function InternshipChart() {
  const { data, loading, error } = useApi<InternshipSalary[]>("/api/internships-vs-salary");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Couldn't load data: {error}</p>;

  return (
    <section>
      <h2>Do internships pay off?</h2>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data ?? []} margin={{ top: 16, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="internships" label={{ value: "Internships completed", position: "insideBottom", offset: -16 }} />
          <YAxis tickFormatter={dollarsK} />
          <Tooltip formatter={(v) => dollars(Number(v))} labelFormatter={(l) => `${l} internship(s)`} />
          <Bar dataKey="avg_salary" name="Avg starting salary" fill="#2563eb" />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}