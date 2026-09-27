import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// One semester of the plan, already totalled by the caller
export interface PdfSemester {
  heading: string; // "Semester 1 · Fall 2027"
  courses: { name: string; title: string; credits: number; result: string }[];
  credits: number; // every course in the semester
  earned: number; // passed + transferred
  termGpa: number | null;
  cumulativeGpa: number | null; // this semester and every one before it
}

export interface PdfPlan {
  major: string;
  semesters: PdfSemester[];
  credits: number;
  earned: number;
  gpa: number | null;
  summary: string | null; // the advisor's review, as markdown
}

// Letter paper, in points
const MARGIN = 48;
const INK: [number, number, number] = [30, 30, 30];
const MUTED: [number, number, number] = [110, 110, 110];
const HEAD_FILL: [number, number, number] = [45, 45, 45];

const gpaText = (gpa: number | null) => (gpa === null ? "—" : gpa.toFixed(2));

// jsPDF's built-in fonts only cover Windows-1252, so swap or drop anything else (arrows, emoji, ...)
const WIN_ANSI_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function printable(text: string): string {
  return text
    .replace(/[→⇒]/g, "->")
    .replace(/[←⇐]/g, "<-")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[^\n\x20-\xff]/g, ch => (WIN_ANSI_EXTRAS.includes(ch) ? ch : ""));
}

// Inline markdown the PDF can't style: keep the words, drop the markup
const plain = (text: string) =>
  printable(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/(^|\s)_(\S[^_]*)_(?=\s|$|[.,;:!?])/g, "$1$2")
    .trim();

// Starts a new page when `height` more points won't fit; returns where to write next
function room(doc: jsPDF, y: number, height: number): number {
  if (y + height <= doc.internal.pageSize.getHeight() - MARGIN) return y;
  doc.addPage();
  return MARGIN;
}

// Headings, bullets, numbered lists, tables and paragraphs; enough for the advisor's answers
function writeMarkdown(doc: jsPDF, markdown: string, y: number): number {
  const width = doc.internal.pageSize.getWidth() - MARGIN * 2;
  const write = (text: string, opts: { size?: number; bold?: boolean; indent?: number; marker?: string } = {}) => {
    const { size = 10.5, bold = false, indent = 0, marker } = opts;
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size).setTextColor(...INK);
    const lineHeight = size * 1.4;
    const lines: string[] = doc.splitTextToSize(text, width - indent);
    lines.forEach((line, i) => {
      y = room(doc, y, lineHeight);
      if (marker && i === 0) doc.text(marker, MARGIN + indent - 12, y);
      doc.text(line, MARGIN + indent, y);
      y += lineHeight;
    });
  };

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) y += 5;
    else if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // a table's header rule
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { y += 4; write(plain(m[1]), { size: 12, bold: true }); }
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)/))) write(plain(m[2]), { indent: 14 + m[1].length * 4, marker: "•" });
    else if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)/))) write(plain(m[3]), { indent: 18 + m[1].length * 4, marker: `${m[2]}.` });
    else if (line.trim().startsWith("|")) write(line.split("|").slice(1, -1).map(plain).join("   |   "));
    else write(plain(line));
  }
  return y;
}

// Builds the plan's PDF and starts the download
export function downloadPlanPdf(plan: PdfPlan, filename: string) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const width = doc.internal.pageSize.getWidth();
  let y = MARGIN;

  // ---------- Title and totals ----------
  doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(...INK);
  doc.text(printable(`${plan.major} Course Plan`), MARGIN, y + 8);
  y += 28;
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...MUTED);
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  doc.text(`Exported ${date}`, MARGIN, y);
  y += 18;
  doc.setFontSize(11).setTextColor(...INK);
  doc.text(
    `${plan.semesters.length} semesters  ·  ${plan.credits} credits taken  ·  ${plan.earned} earned  ·  GPA ${gpaText(plan.gpa)}`,
    MARGIN,
    y,
  );
  y += 10;
  doc.setDrawColor(...MUTED).setLineWidth(0.5).line(MARGIN, y, width - MARGIN, y);
  y += 26;

  // ---------- Semesters ----------
  for (const s of plan.semesters) {
    y = room(doc, y, 80); // keep a heading with the start of its table
    doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...INK);
    doc.text(printable(s.heading), MARGIN, y);
    y += 15;
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...MUTED);
    doc.text(
      `${s.credits} credits taken  ·  ${s.earned} earned  ·  Term GPA ${gpaText(s.termGpa)}  ·  Cumulative GPA ${gpaText(s.cumulativeGpa)}`,
      MARGIN,
      y,
    );
    y += 8;

    if (s.courses.length === 0) {
      y += 14;
      doc.setFont("helvetica", "italic").text("No courses planned", MARGIN, y);
      y += 26;
      continue;
    }

    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [["Course", "Title", "Credits", "Result"]],
      body: s.courses.map(c => [printable(c.name), printable(c.title), String(c.credits), printable(c.result)]),
      styles: { font: "helvetica", fontSize: 9.5, textColor: INK, cellPadding: 5 },
      headStyles: { fillColor: HEAD_FILL, textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        0: { cellWidth: 90, fontStyle: "bold" },
        2: { cellWidth: 50, halign: "right" },
        3: { cellWidth: 90 },
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 28;
  }

  // ---------- Advisor summary ----------
  if (plan.summary) {
    y = room(doc, y, 60);
    doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(...INK);
    doc.text("Advisor summary", MARGIN, y);
    y += 14;
    doc.setFont("helvetica", "italic").setFontSize(9).setTextColor(...MUTED);
    doc.text("AI-generated review of this plan. Check it with your academic advisor before registering.", MARGIN, y);
    y += 20;
    writeMarkdown(doc, plan.summary, y);
  }

  // ---------- Page numbers ----------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(...MUTED);
    doc.text(`Page ${i} of ${pages}`, width - MARGIN, doc.internal.pageSize.getHeight() - 24, { align: "right" });
  }

  doc.save(filename);
}
