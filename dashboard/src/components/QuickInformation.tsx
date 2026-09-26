import { useApi } from "../api";
import { majorKey } from "../paths";
import type { TopQuestion } from "../types";
import AiChart from "./AiChart";
import MarkdownText from "./MarkdownText";
import "./QuickInformation.css";

interface Props {
  majors?: string[]; // one major -> that major's questions; several (or none) -> questions about both
}

export default function QuickInformation({ majors = [] }: Props) {
  const { data, loading, error } = useApi<TopQuestion[]>(`/api/top-questions/${majorKey(majors)}`);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Couldn't load questions: {error}</p>;

  return (
    <section className="quick-info">
      <h2>Most asked questions</h2>
      {data && data.length > 0 ? (
        <div className="quick-info__list">
          {data.map(item => (
            <details key={item.id} className="quick-info__item">
              <summary>
                <span>{item.simplified_question}</span>
                <span className="quick-info__count">
                  asked {item.times_asked} {item.times_asked === 1 ? "time" : "times"}
                </span>
              </summary>
              <MarkdownText className="quick-info__answer">{item.answer}</MarkdownText>
              {item.charts?.map((chart, i) => <AiChart key={i} chart={chart} />)}
            </details>
          ))}
        </div>
      ) : (
        <p>No questions asked yet.</p>
      )}
    </section>
  );
}
