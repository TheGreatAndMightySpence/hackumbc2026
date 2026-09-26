import { useApi } from "../api";
import type { FaqItem } from "../types";
import "./QuickInformation.css";

interface Props {
  majors?: string[]; // only one major -> ask the API for that major's questions; otherwise show all
}

export default function QuickInformation({ majors = [] }: Props) {
  const url = majors.length === 1 ? `/api/faq?major=${encodeURIComponent(majors[0])}` : "/api/faq";
  const { data, loading, error } = useApi<FaqItem[]>(url);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Couldn't load questions: {error}</p>;

  return (
    <section className="quick-info">
      <h2>Common questions</h2>
      {data && data.length > 0 ? (
        <div className="quick-info__list">
          {data.map(item => (
            <details key={item.id} className="quick-info__item">
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      ) : (
        <p>No questions yet.</p>
      )}
    </section>
  );
}
