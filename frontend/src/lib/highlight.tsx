import type { ReactNode } from "react";
import type { CodeLang } from "./types";

const PY_KW =
  /\b(def|return|import|from|if|elif|else|for|while|in|not|and|or|is|None|True|False|lambda|with|as|try|except|raise|class|pass|yield)\b/;
const SQL_KW =
  /\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|ON|CONFLICT|DO|AND|OR|ORDER|BY|LIMIT|RETURNING|NULL|JOIN|AS)\b/i;

function tokenize(line: string, re: RegExp, classify: (m: RegExpExecArray) => string | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let k = 0;
  while ((m = g.exec(line))) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = classify(m);
    out.push(
      cls ? (
        <span key={k++} className={cls}>
          {m[0]}
        </span>
      ) : (
        m[0]
      )
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function highlightLine(line: string, lang: CodeLang): ReactNode {
  if (lang === "python") {
    return tokenize(
      line,
      new RegExp(
        `(#.*$)|('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")|${PY_KW.source}|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b[A-Za-z_]\\w*(?=\\())`
      ),
      (m) =>
        m[1]
          ? "text-ink-3 italic"
          : m[2]
          ? "text-ok"
          : m[3]
          ? "text-forge font-medium"
          : m[4]
          ? "text-warn"
          : m[5]
          ? "text-accent"
          : null
    );
  }
  if (lang === "sql") {
    return tokenize(
      line,
      new RegExp(`('(?:[^']|'')*')|${SQL_KW.source}|(\\b\\d+(?:\\.\\d+)?\\b)|(--.*$)`, "i"),
      (m) => (m[1] ? "text-ok" : m[2] ? "text-accent font-medium" : m[3] ? "text-warn" : m[4] ? "text-ink-3" : null)
    );
  }
  if (lang === "shell") {
    return tokenize(
      line,
      /(^\$)|(--?[a-z][\w-]*)|('(?:[^'])*'|"(?:[^"])*")|(^\s*[\w.]+:)/,
      (m) => (m[1] ? "text-ok font-semibold" : m[2] ? "text-signal" : m[3] ? "text-ok" : m[4] ? "text-ink-2" : null)
    );
  }
  if (lang === "markdown") {
    if (/^#{1,6}\s/.test(line)) return <span className="text-accent font-semibold">{line}</span>;
    return tokenize(line, /(^\s*[-*]\s)|(\*\*[^*]+\*\*)|(`[^`]+`)|(EUR\s[\d,.]+|€[\d,.]+)/, (m) =>
      m[1] ? "text-warn" : m[2] ? "text-ink font-semibold" : m[3] ? "text-signal" : m[4] ? "text-ok" : null
    );
  }
  if (lang === "diff") {
    if (line.startsWith("@@")) return <span className="text-signal">{line}</span>;
    if (line.startsWith("+++") || line.startsWith("---")) return <span className="text-ink-3">{line}</span>;
    if (line.startsWith("+")) return <span className="text-ok">{line}</span>;
    if (line.startsWith("-")) return <span className="text-danger">{line}</span>;
  }
  return line;
}

/** Render `backtick` spans in agent thoughts as inline code. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-sunken px-1 py-px text-[0.92em] text-ink border border-line">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}
