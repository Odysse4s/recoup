import type { Row, RowMark } from "./types";

const KNOWN_PK_NAMES = ["id", "sku", "code", "uuid", "key"];

export function detectPkCol(rows: Row[]): string | undefined {
  if (!rows.length) return undefined;
  const cols = Object.keys(rows[0] ?? {});
  for (const name of KNOWN_PK_NAMES) {
    if (cols.includes(name)) return name;
  }
  const suffix = cols.find((c) => c.endsWith("_id") || c.endsWith("_no") || c.endsWith("_code") || c.endsWith("_key"));
  if (suffix) return suffix;
  if (rows.length > 1) {
    const uniqueCol = cols.find((c) => {
      const seen = new Set(rows.map((r) => String(r[c] ?? "")));
      return seen.size === rows.length;
    });
    if (uniqueCol) return uniqueCol;
  }
  return cols[0];
}

export const rowKeyOf = (row: Row, idx: number, pkCol?: string) => {
  const k = (pkCol ? row[pkCol] : undefined) ?? row.id ?? row.sku ?? Object.values(row)[0];
  return k === undefined || k === null ? `#${idx}` : String(k);
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Row-level diff between two table snapshots. In rewind mode every change is
 * presented as a restoration of the pre-image.
 */
export function diffTables(
  prev: Record<string, Row[]>,
  next: Record<string, Row[]>,
  rewinding: boolean
): { marks: Record<string, RowMark>; ghosts: Record<string, Row[]> } {
  const marks: Record<string, RowMark> = {};
  const ghosts: Record<string, Row[]> = {};
  const at = Date.now();
  for (const table of Object.keys(next)) {
    const before = prev[table];
    if (!before) continue;
    const pkCol = detectPkCol(next[table].length ? next[table] : before);
    const beforeMap = new Map(before.map((r, i) => [rowKeyOf(r, i, pkCol), r]));
    const afterKeys = new Set<string>();
    next[table].forEach((row, i) => {
      const key = rowKeyOf(row, i, pkCol);
      afterKeys.add(key);
      const old = beforeMap.get(key);
      if (!old) {
        marks[`${table}:${key}`] = { kind: rewinding ? "restored" : "inserted", cols: Object.keys(row), at };
        return;
      }
      const cols = Object.keys(row).filter((c) => !same(row[c], old[c]));
      if (cols.length) marks[`${table}:${key}`] = { kind: rewinding ? "restored" : "updated", cols, prev: old, at };
    });
    before.forEach((row, i) => {
      const key = rowKeyOf(row, i, pkCol);
      if (!afterKeys.has(key)) {
        (ghosts[table] ??= []).push(row);
        marks[`${table}:${key}`] = { kind: "deleted", cols: [], prev: row, at };
      }
    });
  }
  return { marks, ghosts };
}
