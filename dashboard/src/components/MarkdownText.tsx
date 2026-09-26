import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./MarkdownText.css";

interface Props {
  children: string;
  className?: string;
}

// Renders AI answers, which come back as markdown. Raw HTML in the text is not rendered.
export default function MarkdownText({ children, className = "" }: Props) {
  return (
    <div className={`markdown ${className}`.trim()}>
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}
