import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  KeyRound,
  Link2,
  RotateCcw,
  ShieldCheck,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChangeReport } from "../contracts";
import { anchorRef } from "../lib/anchors";
import { FALLBACK_TABLES as FALLBACK } from "../lib/offline";
import { soundFx } from "../lib/sound";
import { detectPkCol, rowKeyOf } from "../lib/tableDiff";
import type { Row, RowMark, WorkspaceState } from "../lib/types";
import { btn, Chip, cx, Panel } from "./ui";

const fmt = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

const AADE_RE = /(aade|mydata|afm|vat|mark|invoice_type)/i;

const BADGE: Record<RowMark["kind"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  inserted: { label: "+ INSERTED", tone: "ok" },
  updated: { label: "~ UPDATED", tone: "warn" },
  deleted: { label: "− DELETED", tone: "danger" },
  restored: { label: "↺ RESTORED", tone: "warn" },
};

interface ParsedColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: string | null;
  notNull: boolean;
  check: string | null;
  isAade: boolean;
}

interface ParsedTableSchema {
  table: string;
  ddl: string;
  synthesized: boolean;
  columns: ParsedColumn[];
  tableChecks: string[];
  isAade: boolean;
}

function AadeBadge({ label = "AADE myDATA", className }: { label?: string; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-ok/45 bg-gradient-to-r from-ok/15 to-signal/15 px-1.5 font-mono text-[9.5px] font-semibold tracking-wide text-ok",
        className
      )}
    >
      {label}
    </span>
  );
}

function dedentSql(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length <= 1) return raw.trim();
  const indents = lines
    .slice(1)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l, idx) => (idx === 0 ? l.trim() : l.slice(Math.min(minIndent, l.match(/^\s*/)?.[0].length ?? 0))))
    .join("\n")
    .trim();
}

function extractBalancedParen(text: string, openIdx: number): string | null {
  if (text[openIdx] !== "(") return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i).trim();
    }
  }
  return null;
}

function extractCheckExpr(clause: string): string | null {
  const m = /\bCHECK\s*\(/i.exec(clause);
  if (!m) return null;
  const openIdx = clause.indexOf("(", m.index);
  return openIdx >= 0 ? extractBalancedParen(clause, openIdx) : null;
}

function splitTopLevelClauses(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      const piece = body.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

const CONSTRAINT_HEAD_RE = /^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i;
const COL_STOP_KW = new Set([
  "PRIMARY",
  "NOT",
  "NULL",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "REFERENCES",
  "COLLATE",
  "GENERATED",
  "CONSTRAINT",
]);

function parseCreateTable(tableName: string, rawSql: string, synthesized = false): ParsedTableSchema {
  const ddl = dedentSql(rawSql);
  const cleaned = ddl
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const openIdx = cleaned.indexOf("(");
  const body = openIdx >= 0 ? extractBalancedParen(cleaned, openIdx) : null;
  if (!body) {
    return {
      table: tableName,
      ddl,
      synthesized,
      columns: [],
      tableChecks: [],
      isAade: AADE_RE.test(tableName) || AADE_RE.test(ddl),
    };
  }

  const clauses = splitTopLevelClauses(body);
  const columns: ParsedColumn[] = [];
  const tableChecks: string[] = [];
  const tablePks = new Set<string>();
  const tableFks = new Map<string, string>();

  for (const rawClause of clauses) {
    const clause = rawClause.replace(/\s+/g, " ").trim();
    if (!clause) continue;

    if (CONSTRAINT_HEAD_RE.test(clause)) {
      const pkMatch = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(clause);
      if (pkMatch) {
        pkMatch[1]
          .split(",")
          .map((s) => s.replace(/["`[\]]/g, "").trim())
          .filter(Boolean)
          .forEach((c) => tablePks.add(c));
        continue;
      }
      const fkMatch =
        /^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([A-Za-z0-9_"`]+(?:\s*\([^)]+\))?)/i.exec(clause);
      if (fkMatch) {
        const srcCols = fkMatch[1]
          .split(",")
          .map((s) => s.replace(/["`[\]]/g, "").trim())
          .filter(Boolean);
        const target = fkMatch[2].replace(/["`]/g, "").replace(/\s+/g, "");
        srcCols.forEach((c) => tableFks.set(c, target));
        continue;
      }
      const chk = extractCheckExpr(clause);
      if (chk) tableChecks.push(chk);
      continue;
    }

    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*|"[^"]+"|`[^`]+`|\[[^\]]+\])\s*(.*)$/.exec(clause);
    if (!nameMatch) continue;
    const colName = nameMatch[1].replace(/^["`[]|["`\]]$/g, "");
    const rest = nameMatch[2].trim();

    // Extract SQL type tokens prior to any column constraint keyword
    const typeTokens: string[] = [];
    const tokens = rest.match(/[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?|\S+/g) ?? [];
    for (const tok of tokens) {
      const head = tok.split("(")[0].toUpperCase();
      if (COL_STOP_KW.has(head)) break;
      typeTokens.push(tok.toUpperCase());
    }
    const colType = typeTokens.join(" ") || "TEXT";

    const pk = /\bPRIMARY\s+KEY\b/i.test(rest);
    const notNull = /\bNOT\s+NULL\b/i.test(rest);
    const refMatch = /\bREFERENCES\s+([A-Za-z0-9_"`]+(?:\s*\([^)]+\))?)/i.exec(rest);
    const fk = refMatch ? refMatch[1].replace(/["`]/g, "").replace(/\s+/g, "") : null;
    const check = extractCheckExpr(rest);

    columns.push({
      name: colName,
      type: colType,
      pk,
      fk,
      notNull,
      check,
      isAade: AADE_RE.test(colName) || Boolean(check && AADE_RE.test(check)),
    });
  }

  for (const col of columns) {
    if (tablePks.has(col.name)) col.pk = true;
    if (!col.fk && tableFks.has(col.name)) col.fk = tableFks.get(col.name)!;
  }

  const isAade =
    AADE_RE.test(tableName) ||
    columns.some((c) => c.isAade) ||
    tableChecks.some((chk) => AADE_RE.test(chk));

  return { table: tableName, ddl, synthesized, columns, tableChecks, isAade };
}

function inferSqliteType(values: unknown[]): string {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return "TEXT";
  if (present.every((v) => typeof v === "number")) {
    return present.every((v) => Number.isInteger(v as number)) ? "INTEGER" : "REAL";
  }
  if (present.every((v) => typeof v === "boolean")) return "INTEGER";
  return "TEXT";
}

function synthesizeTableSql(tableName: string, rows: Row[], allTableNames: string[]): string {
  const colSet = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => colSet.add(k)));
  const cols = [...colSet];
  if (!cols.length) {
    return `CREATE TABLE ${tableName} (\n  id TEXT PRIMARY KEY\n);`;
  }
  const pk = detectPkCol(rows);
  const lines = cols.map((c, idx) => {
    const vals = rows.map((r) => r[c]);
    const sqlType = inferSqliteType(vals);
    const isPk = pk === c || (!pk && idx === 0 && c === "id");
    const nonNull = rows.length > 0 && vals.every((v) => v !== null && v !== undefined);
    let fkClause = "";
    if (!isPk && c.endsWith("_id")) {
      const stem = c.slice(0, -3);
      const refTable = allTableNames.find((t) => t === `${stem}s` || t === `${stem.slice(0, -1)}ies` || t === stem);
      if (refTable && refTable !== tableName) fkClause = ` REFERENCES ${refTable}(id)`;
    }
    return `  ${c} ${sqlType}${isPk ? " PRIMARY KEY" : nonNull ? " NOT NULL" : ""}${fkClause}`;
  });
  return `CREATE TABLE ${tableName} (\n${lines.join(",\n")}\n);`;
}

const DDL_KW_RE =
  /(--.*$)|('(?:[^']|'')*')|\b(CREATE|TABLE|IF|NOT|EXISTS|PRIMARY|KEY|FOREIGN|REFERENCES|CHECK|UNIQUE|DEFAULT|NULL|CONSTRAINT|ON|DELETE|CASCADE|IN|AND|OR)\b|\b(INTEGER|TEXT|REAL|NUMERIC|BLOB|BOOLEAN|VARCHAR)\b|(\b\d+(?:\.\d+)?\b)/gi;

function renderDdlLine(line: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  DDL_KW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DDL_KW_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1]
      ? "text-ink-3 italic"
      : m[2]
      ? "text-ok"
      : m[3]
      ? "text-accent font-semibold"
      : m[4]
      ? "text-signal font-medium"
      : m[5]
      ? "text-warn"
      : "";
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

const XML_TOKEN_RE = /(<!--[\s\S]*?-->)|(<\?[\s\S]*?\?>)|(<\/?[A-Za-z0-9_:-]+)|(\s+[A-Za-z0-9_:-]+(?==))|(="[^"]*"|='[^']*')|(\/?>)/g;

function renderXmlLine(line: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  XML_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1]
      ? "text-ink-3 italic"
      : m[2]
      ? "text-forge"
      : m[3]
      ? "text-signal font-semibold"
      : m[4]
      ? "text-accent"
      : m[5]
      ? "text-ok"
      : m[6]
      ? "text-signal font-semibold"
      : "";
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

function reconstructFromDiff(diff: string): string {
  const lines = diff.split("\n");
  const hasUnifiedHeaders = lines.some((l) => l.startsWith("@@") || l.startsWith("+++"));
  if (!hasUnifiedHeaders) return diff;
  return lines
    .filter((l) => !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("@@") && !l.startsWith("-"))
    .map((l) => (l.startsWith("+") ? l.slice(1) : l))
    .join("\n");
}

export function DatabaseStudio({
  ws,
  report,
  rowMarks,
  ghostRows,
  fileMarks,
  rewinding,
  committed = false,
  pulseKey,
  onOpenFile,
  focusTable,
}: {
  ws: WorkspaceState | null;
  report: ChangeReport | null;
  rowMarks: Record<string, RowMark>;
  ghostRows: Record<string, Row[]>;
  fileMarks: Record<string, "new" | "changed" | "removed">;
  rewinding: boolean;
  committed?: boolean;
  pulseKey: number;
  onOpenFile: (path: string, content: string) => void;
  focusTable?: { table: string; seq: number } | null;
}) {
  const tables = ws?.tables && Object.keys(ws.tables).length ? ws.tables : FALLBACK;
  const schemaMap = ws?.schema_sql ?? {};

  const names = useMemo(() => {
    const s = new Set<string>(Object.keys(tables));
    Object.keys(schemaMap).forEach((t) => s.add(t));
    return [...s];
  }, [tables, schemaMap]);

  const parsedSchemas = useMemo(() => {
    const map: Record<string, ParsedTableSchema> = {};
    for (const t of names) {
      const liveSql = schemaMap[t];
      if (liveSql && liveSql.trim()) {
        map[t] = parseCreateTable(t, liveSql, false);
      } else {
        const tableRows = [...(tables[t] ?? []), ...(ghostRows[t] ?? [])];
        map[t] = parseCreateTable(t, synthesizeTableSql(t, tableRows, names), true);
      }
    }
    return map;
  }, [names, schemaMap, tables, ghostRows]);

  const anySchemaAade = useMemo(() => Object.values(parsedSchemas).some((s) => s.isAade), [parsedSchemas]);

  const mergedFiles = useMemo(() => {
    const out: Record<string, { content: string; stagedOnly: boolean }> = {};
    for (const [path, content] of Object.entries(ws?.files ?? {})) {
      out[path] = { content, stagedOnly: false };
    }
    for (const mod of report?.files_modified ?? []) {
      if (mod.path.endsWith(".db") || mod.path.endsWith(".sqlite")) continue;
      if (!out[mod.path]) {
        out[mod.path] = { content: reconstructFromDiff(mod.diff), stagedOnly: true };
      }
    }
    return out;
  }, [ws?.files, report?.files_modified]);

  const fileEntries = useMemo(() => Object.entries(mergedFiles), [mergedFiles]);
  const anyFileAade = useMemo(
    () => fileEntries.some(([p, f]) => AADE_RE.test(p) || p.toLowerCase().endsWith(".xml") || AADE_RE.test(f.content)),
    [fileEntries]
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDdl, setCollapsedDdl] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (focusTable?.seq && focusTable.table) {
      setSelected(focusTable.table);
    }
  }, [focusTable?.seq, focusTable?.table]);

  const active =
    selected === "__files"
      ? "__files"
      : selected === "__schema"
      ? "__schema"
      : selected && (tables[selected] !== undefined || parsedSchemas[selected] !== undefined)
      ? selected
      : ws?.domain?.primary_table && tables[ws.domain.primary_table] !== undefined
      ? ws.domain.primary_table
      : names[0];

  const activeFilePath = useMemo(() => {
    if (selectedFile && mergedFiles[selectedFile]) return selectedFile;
    const xmlEntry = fileEntries.find(([p]) => p.toLowerCase().endsWith(".xml"));
    if (xmlEntry) return xmlEntry[0];
    const stagedEntry = fileEntries.find(([p, f]) => f.stagedOnly || Boolean(fileMarks[p]));
    if (stagedEntry) return stagedEntry[0];
    return fileEntries[0]?.[0] ?? null;
  }, [selectedFile, mergedFiles, fileEntries, fileMarks]);

  const rows = active === "__files" || active === "__schema" ? [] : tables[active] ?? [];
  const ghosts = active === "__files" || active === "__schema" ? [] : ghostRows[active] ?? [];
  const pkCol = useMemo(() => detectPkCol(rows.length ? rows : ghosts), [rows, ghosts]);
  const cols = useMemo(() => {
    const s = new Set<string>();
    [...rows, ...ghosts].forEach((r) => Object.keys(r).forEach((k) => s.add(k)));
    if (s.size === 0 && active !== "__files" && active !== "__schema") {
      parsedSchemas[active]?.columns.forEach((c) => s.add(c.name));
    }
    return [...s];
  }, [rows, ghosts, active, parsedSchemas]);

  const marksFor = (t: string) => Object.keys(rowMarks).filter((k) => k.startsWith(`${t}:`)).length;
  const staged = (t: string) => report?.db_summary?.[t];

  const allExpanded = names.every((t) => !collapsedDdl[t]);
  const toggleAllDdl = () => {
    soundFx.playUiClick();
    if (allExpanded) {
      setCollapsedDdl(Object.fromEntries(names.map((t) => [t, true])));
    } else {
      setCollapsedDdl({});
    }
  };

  return (
    <Panel
      title="SQLite & Schema Studio"
      icon={<Database />}
      meta={
        <span className="flex items-center gap-1.5">
          {rewinding ? (
            <Chip tone="warn">
              <RotateCcw className="h-2.5 w-2.5 animate-spin [animation-direction:reverse]" /> rewinding
            </Chip>
          ) : (
            <Chip tone="ok">live · verified</Chip>
          )}
          {(anySchemaAade || anyFileAade) && <AadeBadge />}
        </span>
      }
      actions={<span className="font-mono text-[10.5px] text-ink-3">sha256 {ws?.fingerprint ?? "offline"}</span>}
      anchor={anchorRef("db")}
      pulseKey={pulseKey}
      pulseTone={rewinding ? "warn" : "signal"}
      className="min-h-[280px] flex-[1.15]"
      bodyClassName="flex flex-col"
    >
      <div className="scroll-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
        {names.map((t) => {
          const s = staged(t);
          const n = marksFor(t);
          const isAade = parsedSchemas[t]?.isAade;
          return (
            <button
              key={t}
              type="button"
              onClick={() => {
                soundFx.playUiClick();
                setSelected(t);
              }}
              className={cx(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
                active === t ? "bg-sunken font-semibold text-ink" : "text-ink-3 hover:text-ink-2"
              )}
            >
              <Table2 className="h-3.5 w-3.5" />
              <span className="font-mono">{t}</span>
              <span className="font-mono text-[10px] text-ink-3 tabular">{tables[t]?.length ?? 0}</span>
              {isAade && <AadeBadge className="h-4 px-1 text-[8.5px]" />}
              {s && (s.inserted || s.updated || s.deleted) ? (
                <Chip tone={committed ? "ok" : "warn"} className="h-4 px-1 text-[9px]">
                  {committed ? "live " : "staged "}
                  {s.inserted ? `+${s.inserted}` : ""}
                  {s.updated ? `~${s.updated}` : ""}
                  {s.deleted ? `−${s.deleted}` : ""}
                </Chip>
              ) : null}
              {n > 0 && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
            </button>
          );
        })}

        <span className="mx-1 h-4 w-px shrink-0 bg-line" />

        <button
          type="button"
          onClick={() => {
            soundFx.playUiClick();
            setSelected("__schema");
          }}
          className={cx(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
            active === "__schema" ? "bg-sunken font-semibold text-ink" : "text-ink-3 hover:text-ink-2"
          )}
        >
          <Code2 className="h-3.5 w-3.5 text-signal" />
          <span>Schema DDL</span>
          <span className="font-mono text-[10px] text-ink-3 tabular">{names.length}</span>
          {anySchemaAade && <AadeBadge className="h-4 px-1 text-[8.5px]" />}
        </button>

        <button
          type="button"
          ref={anchorRef("anchor:files")}
          onClick={() => {
            soundFx.playUiClick();
            setSelected("__files");
          }}
          className={cx(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
            active === "__files" ? "bg-sunken font-semibold text-ink" : "text-ink-3 hover:text-ink-2"
          )}
        >
          <FileText className="h-3.5 w-3.5" />
          <span>Files</span>
          <span className="font-mono text-[10px] text-ink-3 tabular">{fileEntries.length}</span>
          {anyFileAade && <AadeBadge className="h-4 px-1 text-[8.5px]" />}
          {(Object.keys(fileMarks).length > 0 || fileEntries.some(([, f]) => f.stagedOnly)) && (
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
          )}
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {active === "__schema" ? (
          <div className="space-y-3 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-sunken/50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-2">
                <ShieldCheck className="h-3.5 w-3.5 text-ok" />
                <span className="font-medium text-ink">Dynamic SQLite Schema Inspector</span>
                <span className="font-mono text-[10.5px] text-ink-3">
                  · {Object.keys(schemaMap).length ? "sqlite_master live DDL" : "live row schema synthesis"}
                </span>
              </div>
              <button type="button" onClick={toggleAllDdl} className={cx(btn("outline", "sm"), "h-6 px-2 text-[11px]")}>
                {allExpanded ? "Collapse SQL" : "Expand all SQL"}
              </button>
            </div>

            {names.map((t) => {
              const schema = parsedSchemas[t];
              const rowCount = tables[t]?.length ?? 0;
              const s = staged(t);
              const ddlOpen = !collapsedDdl[t];
              return (
                <section key={t} className="overflow-hidden rounded-xl border border-line bg-raised/70 shadow-card">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/80 px-3.5 py-2.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Table2 className="h-4 w-4 shrink-0 text-signal" />
                      <span className="font-mono text-[13.5px] font-semibold text-ink">{t}</span>
                      <Chip tone="neutral" className="h-[18px] text-[9.5px]">
                        {rowCount} row{rowCount === 1 ? "" : "s"}
                      </Chip>
                      {schema.isAade && <AadeBadge />}
                      {s && (s.inserted || s.updated || s.deleted) ? (
                        <Chip tone={committed ? "ok" : "warn"} className="h-[18px] text-[9.5px]">
                          {committed ? "live " : "staged "}
                          {s.inserted ? `+${s.inserted}` : ""}
                          {s.updated ? `~${s.updated}` : ""}
                          {s.deleted ? `−${s.deleted}` : ""}
                        </Chip>
                      ) : null}
                      <span className="font-mono text-[10px] text-ink-3">
                        {schema.synthesized ? "inferred DDL" : "sqlite_master"}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          soundFx.playUiClick();
                          setSelected(t);
                        }}
                        className={cx(btn("ghost", "sm"), "h-6 px-2 text-[11px]")}
                      >
                        Rows →
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          soundFx.playUiClick();
                          setCollapsedDdl((m) => ({ ...m, [t]: !m[t] }));
                        }}
                        aria-expanded={ddlOpen}
                        className={cx(btn("outline", "sm"), "h-6 gap-1 px-2 font-mono text-[10.5px]")}
                      >
                        DDL
                        <ChevronDown className={cx("h-3 w-3 transition-transform", ddlOpen && "rotate-180")} />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2.5 p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {schema.columns.map((col) => (
                        <div
                          key={col.name}
                          className={cx(
                            "inline-flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px]",
                            col.isAade
                              ? "border-ok/40 bg-ok/[0.06]"
                              : col.pk
                              ? "border-warn/35 bg-warn/[0.05]"
                              : "border-line bg-surface"
                          )}
                        >
                          <span className="font-mono text-[12px] font-semibold text-ink">{col.name}</span>
                          <span className="font-mono text-[10px] font-medium uppercase text-ink-3">{col.type}</span>
                          {col.pk && (
                            <Chip tone="warn" className="h-4 px-1 text-[9px]">
                              <KeyRound className="h-2.5 w-2.5" /> PK
                            </Chip>
                          )}
                          {col.fk && (
                            <Chip tone="signal" className="h-4 px-1 text-[9px]">
                              <Link2 className="h-2.5 w-2.5" /> FK → {col.fk}
                            </Chip>
                          )}
                          {col.notNull && (
                            <span className="rounded border border-line-strong bg-sunken px-1 py-px font-mono text-[8.5px] font-semibold uppercase text-ink-2">
                              NOT NULL
                            </span>
                          )}
                          {col.check && (
                            <span
                              title={`CHECK (${col.check})`}
                              className="inline-flex h-4 max-w-[190px] items-center truncate rounded border border-forge/40 bg-forge/12 px-1 font-mono text-[9px] font-semibold text-forge"
                            >
                              CHECK ({col.check})
                            </span>
                          )}
                          {col.isAade && <AadeBadge className="h-4 px-1 text-[8.5px]" />}
                        </div>
                      ))}
                    </div>

                    {schema.tableChecks.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {schema.tableChecks.map((chk, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1 rounded-md border border-forge/35 bg-forge/10 px-2 py-0.5 font-mono text-[10px] font-medium text-forge"
                          >
                            TABLE CHECK ({chk})
                          </span>
                        ))}
                      </div>
                    )}

                    <AnimatePresence initial={false}>
                      {ddlOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="overflow-hidden"
                        >
                          <pre className="scroll-thin overflow-x-auto rounded-lg border border-line bg-code p-2.5 font-mono text-[11px] leading-[1.6] text-ink-2">
                            {schema.ddl.split("\n").map((line, i) => (
                              <div key={i}>{renderDdlLine(line)}</div>
                            ))}
                          </pre>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </section>
              );
            })}
          </div>
        ) : active === "__files" ? (
          <div className="flex flex-col divide-y divide-line">
            <ul className="divide-y divide-line">
              {fileEntries.map(([path, entry]) => {
                const m = fileMarks[path];
                const isXml = path.toLowerCase().endsWith(".xml");
                const isAade = isXml || AADE_RE.test(path) || AADE_RE.test(entry.content);
                const isSelected = activeFilePath === path;
                return (
                  <motion.li
                    key={path}
                    layout
                    initial={m || entry.stagedOnly ? { backgroundColor: "color-mix(in oklab, var(--ok) 14%, transparent)" } : false}
                    animate={{ backgroundColor: "rgba(0,0,0,0)" }}
                    transition={{ duration: 3 }}
                  >
                    <div
                      className={cx(
                        "flex w-full items-center gap-2 px-3.5 py-2 transition-colors",
                        isSelected ? "bg-sunken/85" : "hover:bg-sunken/50"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          soundFx.playUiClick();
                          setSelectedFile(path);
                        }}
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                      >
                        {isXml ? (
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ok" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                        )}
                        <span className="truncate font-mono text-[12px] font-medium text-ink">{path}</span>
                        {isXml ? (
                          <AadeBadge label="AADE myDATA XML Filing · Staged & Reversible" />
                        ) : isAade ? (
                          <AadeBadge />
                        ) : null}
                        {entry.stagedOnly && <Chip tone="warn">staged preview</Chip>}
                        {m && (
                          <Chip tone={m === "removed" ? "warn" : "ok"}>
                            {m === "new" ? "+ new" : m === "changed" ? "~ changed" : "↺ removed"}
                          </Chip>
                        )}
                      </button>
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-3 tabular">
                        {entry.content.split("\n").length} ln
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          soundFx.playUiClick();
                          onOpenFile(path, entry.content);
                        }}
                        title={`Open ${path} in floating inspector`}
                        aria-label={`Open ${path} in floating inspector`}
                        className={cx(btn("ghost", "sm"), "h-6 w-6 shrink-0 px-0")}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </motion.li>
                );
              })}
              {fileEntries.length === 0 && (
                <li className="px-3.5 py-6 text-center text-[12px] text-ink-3">No workspace files.</li>
              )}
            </ul>

            {activeFilePath && mergedFiles[activeFilePath] && (
              <div className="space-y-2 bg-surface/60 p-3">
                {activeFilePath.toLowerCase().endsWith(".xml") ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ok/45 bg-gradient-to-r from-ok/12 via-signal/10 to-transparent px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
                      <span className="font-mono text-[12px] font-semibold text-ok">
                        AADE myDATA XML Filing · Staged &amp; Reversible
                      </span>
                      <span className="font-mono text-[11px] text-ink-2">({activeFilePath})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playUiClick();
                        onOpenFile(activeFilePath, mergedFiles[activeFilePath].content);
                      }}
                      className={cx(btn("outline", "sm"), "h-6 gap-1 px-2 text-[11px]")}
                    >
                      <ExternalLink className="h-3 w-3" /> Pop out
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2 px-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-[11.5px] font-semibold text-ink">{activeFilePath}</span>
                      {AADE_RE.test(activeFilePath) && <AadeBadge />}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        soundFx.playUiClick();
                        onOpenFile(activeFilePath, mergedFiles[activeFilePath].content);
                      }}
                      className={cx(btn("outline", "sm"), "h-6 gap-1 px-2 text-[11px]")}
                    >
                      <ExternalLink className="h-3 w-3" /> Pop out
                    </button>
                  </div>
                )}

                <pre className="scroll-thin max-h-64 overflow-auto rounded-lg border border-line bg-code p-3 font-mono text-[11.5px] leading-[1.6] text-ink-2">
                  {mergedFiles[activeFilePath].content.split("\n").map((line, idx) => (
                    <div key={idx}>
                      {activeFilePath.toLowerCase().endsWith(".xml") ? renderXmlLine(line) : line}
                    </div>
                  ))}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ perspective: 800 }}>
            <thead>
              <tr>
                <th className="sticky top-0 z-10 w-[92px] border-b border-line-strong/60 bg-sunken/90 backdrop-blur-sm px-3 py-2 text-left font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                  Δ
                </th>
                {cols.map((c) => {
                  const isColAade = AADE_RE.test(c);
                  return (
                    <th
                      key={c}
                      className="sticky top-0 z-10 whitespace-nowrap border-b border-line-strong/60 bg-sunken/90 backdrop-blur-sm px-3 py-2 text-left font-mono text-[10.5px] font-semibold tracking-wider text-ink-2"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span className="uppercase">{c}</span>
                        {isColAade && <AadeBadge className="h-4 px-1 text-[8.5px] normal-case" />}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {rows.map((row, i) => {
                  const key = rowKeyOf(row, i, pkCol);
                  const mark = rowMarks[`${active}:${key}`];
                  const b = mark ? BADGE[mark.kind] : null;
                  return (
                    <motion.tr
                      key={`${key}-${mark?.at ?? 0}`}
                      initial={
                        mark
                          ? mark.kind === "restored"
                            ? { rotateX: -90, opacity: 0.2 }
                            : { opacity: 0, y: -6 }
                          : false
                      }
                      animate={{ rotateX: 0, opacity: 1, y: 0 }}
                      transition={{ duration: mark?.kind === "restored" ? 0.7 : 0.4, delay: i * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
                      style={{ transformOrigin: "center top" }}
                      className={cx("group", b && (b.tone === "ok" ? "bg-ok/[0.07]" : "bg-warn/[0.08]"))}
                    >
                      <td className="border-b border-line px-3 py-1.5">
                        {b ? (
                          <motion.span
                            initial={{ scale: 0.6, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: "spring", stiffness: 500, damping: 20 }}
                          >
                            <Chip tone={b.tone} className="h-[18px] px-1 text-[9px]">
                              {b.label}
                            </Chip>
                          </motion.span>
                        ) : (
                          <span className="font-mono text-[10px] text-ink-3">·</span>
                        )}
                      </td>
                      {cols.map((c) => {
                        const v = row[c];
                        const changed = mark && mark.cols.includes(c) && mark.kind !== "inserted";
                        const num = typeof v === "number";
                        const negative = num && (v as number) < 0;
                        return (
                          <td
                            key={c}
                            title={changed && mark?.prev ? `was ${fmt(mark.prev[c])}` : undefined}
                            className={cx(
                              "whitespace-nowrap border-b border-line px-3 py-1.5 font-mono tabular group-hover:bg-sunken/60",
                              num && "text-right",
                              changed ? "text-warn" : negative ? "text-danger" : "text-ink"
                            )}
                          >
                            {changed && mark?.prev && (
                              <span className="mr-1.5 text-ink-3 line-through decoration-warn/60">{fmt(mark.prev[c])}</span>
                            )}
                            {fmt(v)}
                          </td>
                        );
                      })}
                    </motion.tr>
                  );
                })}
                {ghosts.map((row, i) => (
                  <motion.tr
                    key={`ghost-${rowKeyOf(row, i, pkCol)}`}
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0.55 }}
                    exit={{ opacity: 0, height: 0 }}
                    className="bg-danger/[0.06]"
                  >
                    <td className="border-b border-line px-3 py-1.5">
                      <Chip tone={rewinding ? "warn" : "danger"} className="h-[18px] px-1 text-[9px]">
                        {rewinding ? "↺ REVERTED" : "− DELETED"}
                      </Chip>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className="whitespace-nowrap border-b border-line px-3 py-1.5 font-mono text-ink-3 line-through">
                        {fmt(row[c])}
                      </td>
                    ))}
                  </motion.tr>
                ))}
                {rows.length === 0 && ghosts.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(2, cols.length + 1)} className="px-3.5 py-6 text-center text-[12px] text-ink-3">
                      0 live rows in <span className="font-mono text-ink-2">{active}</span> — inspect{" "}
                      <button
                        type="button"
                        onClick={() => setSelected("__schema")}
                        className="font-mono font-medium text-signal hover:underline"
                      >
                        Schema DDL
                      </button>{" "}
                      for table constraints.
                    </td>
                  </tr>
                )}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
