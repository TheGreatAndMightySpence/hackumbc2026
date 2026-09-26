import type { PathId } from "../paths";

// Simple line icons that follow the text color (so they work in dark mode too)
export default function PathIcon({ id }: { id: PathId }) {
  const common = {
    width: 40, height: 40, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (id === "cs") {
    // code brackets
    return (
      <svg {...common}>
        <polyline points="8 6 2 12 8 18" />
        <polyline points="16 6 22 12 16 18" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    );
  }
  if (id === "it") {
    // stacked servers
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <line x1="7" y1="6.5" x2="7.01" y2="6.5" />
        <line x1="7" y1="17.5" x2="7.01" y2="17.5" />
        <line x1="11" y1="6.5" x2="17" y2="6.5" />
        <line x1="11" y1="17.5" x2="17" y2="17.5" />
      </svg>
    );
  }
  // compass
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5" />
    </svg>
  );
}
