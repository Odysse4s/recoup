import { AnimatePresence, motion } from "framer-motion";
import { Database, FileText, RotateCcw, Table2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChangeReport } from "../contracts";
import { anchorRef } from "../lib/anchors";
import { FALLBACK_TABLES as FALLBACK } from "../lib/offline";
import { detectPkCol, rowKeyOf } from "../lib/tableDiff";
import type { Row, RowMark, WorkspaceState } from "../lib/types";
import { Chip, cx, Panel } from "./ui";

const fmt = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

const BADGE: Record<RowMark["kind"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  inserted: { label: "+ INSERTED", tone: "ok" },
  updated: { label: "~ UPDATED", tone: "warn" },
  deleted: { label: "− DELETED", tone: "danger" },
  restored: { label: "↺ RESTORED", tone: "warn" },
};

export function DatabaseStudio({
  ws,
  report,
  rowMarks,
  ghostRows,
  fileMarks,
  rewinding,
  pulseKey,
  onOpenFile,
}: {
  ws: WorkspaceState | null;
  report: ChangeReport | null;
  rowMarks: Record<string, RowMark>;
  ghostRows: Record<string, Row[]>;
  fileMarks: Record<string, "new" | "changed" | "removed">;
  rewinding: boolean;
  pulseKey: number;
  onOpenFile: (path: string, content: string) => void;
}) {
  const tables = ws?.tables && Object.keys(ws.tables).length ? ws.tables : FALLBACK;
  const names = Object.keys(tables);
  const [selected, setSelected] = useState<string | null>(null);
  const active =
    selected === "__files"
      ? "__files"
      : selected && tables[selected]
      ? selected
      : ws?.domain?.primary_table && tables[ws.domain.primary_table]
      ? ws.domain.primary_table
      : names[0];
  const files = ws?.files ?? {};

  const rows = active === "__files" ? [] : tables[active] ?? [];
  const ghosts = active === "__files" ? [] : ghostRows[active] ?? [];
  const pkCol = useMemo(() => detectPkCol(rows.length ? rows : ghosts), [rows, ghosts]);
  const cols = useMemo(() => {
    const s = new Set<string>();
    [...rows, ...ghosts].forEach((r) => Object.keys(r).forEach((k) => s.add(k)));
    return [...s];
  }, [rows, ghosts]);

  const marksFor = (t: string) => Object.keys(rowMarks).filter((k) => k.startsWith(`${t}:`)).length;
  const staged = (t: string) => report?.db_summary?.[t];

  return (
    <Panel
      title="SQLite Studio"
      icon={<Database />}
      meta={
        rewinding ? (
          <Chip tone="warn">
            <RotateCcw className="h-2.5 w-2.5 animate-spin [animation-direction:reverse]" /> rewinding
          </Chip>
        ) : (
          <Chip tone="ok">live · verified</Chip>
        )
      }
      actions={<span className="font-mono text-[10.5px] text-ink-3">sha256 {ws?.fingerprint ?? "offline"}</span>}
      anchor={anchorRef("db")}
      pulseKey={pulseKey}
      pulseTone={rewinding ? "warn" : "signal"}
      className="min-h-[260px] flex-[1.15]"
      bodyClassName="flex flex-col"
    >
      <div className="scroll-thin flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
        {names.map((t) => {
          const s = staged(t);
          const n = marksFor(t);
          return (
            <button
              key={t}
              onClick={() => setSelected(t)}
              className={cx(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
                active === t ? "bg-sunken font-medium text-ink" : "text-ink-3 hover:text-ink-2"
              )}
            >
              <Table2 className="h-3.5 w-3.5" />
              <span className="font-mono">{t}</span>
              <span className="font-mono text-[10px] text-ink-3 tabular">{tables[t]?.length ?? 0}</span>
              {s && (s.inserted || s.updated || s.deleted) ? (
                <Chip tone="warn" className="h-4 px-1 text-[9px]">
                  staged {s.inserted ? `+${s.inserted}` : ""}
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
          ref={anchorRef("anchor:files")}
          onClick={() => setSelected("__files")}
          className={cx(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors",
            active === "__files" ? "bg-sunken font-medium text-ink" : "text-ink-3 hover:text-ink-2"
          )}
        >
          <FileText className="h-3.5 w-3.5" />
          workspace
          <span className="font-mono text-[10px] text-ink-3 tabular">{Object.keys(files).length}</span>
          {Object.keys(fileMarks).length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {active === "__files" ? (
          <ul className="divide-y divide-line">
            {Object.entries(files).map(([path, content]) => {
              const m = fileMarks[path];
              return (
                <motion.li
                  key={path}
                  layout
                  initial={m ? { backgroundColor: "color-mix(in oklab, var(--ok) 14%, transparent)" } : false}
                  animate={{ backgroundColor: "rgba(0,0,0,0)" }}
                  transition={{ duration: 3 }}
                >
                  <button
                    onClick={() => onOpenFile(path, content)}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-sunken"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    <span className="flex-1 truncate font-mono text-[12px] text-ink">{path}</span>
                    {m && <Chip tone={m === "removed" ? "warn" : "ok"}>{m === "new" ? "+ new" : m === "changed" ? "~ changed" : "↺ removed"}</Chip>}
                    <span className="font-mono text-[10.5px] text-ink-3 tabular">{content.split("\n").length} ln</span>
                  </button>
                </motion.li>
              );
            })}
            {Object.keys(files).length === 0 && <li className="px-3.5 py-6 text-center text-[12px] text-ink-3">No workspace files.</li>}
          </ul>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ perspective: 800 }}>
            <thead>
              <tr>
                <th className="sticky top-0 z-10 w-[92px] border-b border-line bg-surface px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-ink-3">
                  Δ
                </th>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-ink-3"
                  >
                    {c}
                  </th>
                ))}
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
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
