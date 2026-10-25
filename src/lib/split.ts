export interface Clause {
  id: number;
  /** Section number as written in the lease ("5", "4.2"), or null for the preamble. */
  number: string | null;
  heading: string;
  text: string;
  /** Character offsets into the original lease text, for highlighting in the UI. */
  start: number;
  end: number;
}

// "5. CLEANING FEE." / "4.2 Deposit" / "Section 7 - Utilities" / "ARTICLE III."
// Bare numbers need a trailing "." or ")" so sentences like "I agree..." aren't headings.
const NUMBERED =
  /^[ \t]*(?:(?:section|article)\s+([0-9]+(?:\.[0-9]+)*|[IVXLC]+)[.:)\-]?|([0-9]+\.[0-9]+(?:\.[0-9]+)*[.)]?|[0-9]+[.)]|[IVXLC]+[.)]))\s+(.*)$/i;
// Stand-alone ALL CAPS heading line, e.g. "SECURITY DEPOSIT"
const CAPS_HEADING = /^[ \t]*([A-Z][A-Z0-9 ,&'/\-]{3,60})[.:]?[ \t]*$/;

export function splitClauses(lease: string): Clause[] {
  const text = lease.replace(/\r\n/g, "\n");
  const starts: { at: number; number: string | null; rest: string }[] = [];

  let offset = 0;
  for (const line of text.split("\n")) {
    const m = line.match(NUMBERED);
    if (m && /[A-Za-z]/.test(m[3])) {
      starts.push({ at: offset, number: (m[1] ?? m[2]).replace(/[.)]$/, ""), rest: m[3] });
    } else if (CAPS_HEADING.test(line) && starts.length > 0) {
      // Only treat caps lines as headings after the first numbered/caps section, so the title stays in the preamble.
      starts.push({ at: offset, number: null, rest: line.trim() });
    }
    offset += line.length + 1;
  }

  const clauses: Clause[] = [];
  const push = (start: number, end: number, number: string | null, rest: string) => {
    const body = text.slice(start, end).trim();
    if (!body) return;
    clauses.push({ id: clauses.length, number, heading: headingOf(rest), text: body, start, end });
  };

  if (starts.length === 0) {
    // Unstructured text: fall back to paragraphs.
    let pos = 0;
    for (const para of text.split(/\n\s*\n/)) {
      const start = text.indexOf(para, pos);
      pos = start + para.length;
      push(start, pos, null, para);
    }
    return clauses;
  }

  if (starts[0].at > 0) push(0, starts[0].at, null, "Preamble");
  starts.forEach((s, i) => push(s.at, starts[i + 1]?.at ?? text.length, s.number, s.rest));
  return clauses;
}

// "CLEANING FEE. In addition to..." -> "Cleaning Fee"
function headingOf(rest: string): string {
  const caps = rest.match(/^([A-Z][A-Z0-9 ,&'/\-]{2,60}?)[.:]/);
  const raw = caps ? caps[1] : rest.split(/[.:]/)[0].split(/\s+/).slice(0, 6).join(" ");
  return raw.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_, sep, c) => sep + c.toUpperCase()).trim();
}
