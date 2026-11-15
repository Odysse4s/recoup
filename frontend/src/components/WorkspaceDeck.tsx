import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit, Database, FileCode2, Rows2 } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { RecoupRuntime } from "../hooks/useRecoup";
import { soundFx } from "../lib/sound";
import { usePersistentState } from "../lib/usePersistentState";
import { DatabaseStudio } from "./DatabaseStudio";
import { NeuralGraph } from "./NeuralGraph";
import { cx, Segmented } from "./ui";

type DeckView = "graph" | "db" | "split";

const defaultView = (): DeckView =>
  typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches ? "graph" : "db";

function normalizeView(v: string): DeckView {
  if (v === "graph" || v === "split" || v === "db") return v;
  if (v === "studio") return "db";
  return defaultView();
}

function CountPill({ n, active, tone = "accent" }: { n: number; active: boolean; tone?: "accent" | "warn" }) {
  const activeCls = tone === "warn" ? "bg-warn/18 text-warn" : "bg-accent/15 text-accent";
  const idleCls = tone === "warn" ? "bg-warn/14 text-warn" : "bg-line text-ink-3";
  return (
    <span
      className={cx(
        "relative inline-flex h-4 min-w-4 items-center justify-center overflow-hidden rounded-[5px] px-1 font-mono text-[9.5px] font-semibold tabular",
        active ? activeCls : idleCls
      )}
      aria-label={`${n} items`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={n}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 32 }}
        >
          {n}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Centre-column deck: Decision & Thought Graph (default on desktop), SQLite Ledger / Schema / Files, or Split View. */
export function WorkspaceDeck({ r }: { r: RecoupRuntime }) {
  const [rawView, setView] = usePersistentState<DeckView>("recoup.workspaceView.v2", defaultView());
  const view = normalizeView(rawView);
  const nodes = r.graph.nodes.length;

  useEffect(() => {
    if (r.requestedDeckView?.seq) {
      setView(normalizeView(r.requestedDeckView.view));
      soundFx.playStageTick(2);
    }
  }, [r.requestedDeckView?.seq, r.requestedDeckView?.view, setView]);

  const dbSummaryCount = Object.values(r.report?.db_summary ?? {}).reduce(
    (acc, s) => acc + (s.inserted || 0) + (s.updated || 0) + (s.deleted || 0),
    0
  );
  const stagedFiles = (r.report?.files_modified ?? []).filter((f) => !f.path.endsWith(".db") && !f.path.endsWith(".sqlite"));
  const liveChangeCount =
    dbSummaryCount + stagedFiles.length ||
    Object.keys(r.rowMarks).length + Object.keys(r.fileMarks).length;

  const latestStagedFile = stagedFiles[stagedFiles.length - 1];

  const label = (icon: ReactNode, text: string, extra?: ReactNode) => (
    <span className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3">
      {icon}
      {text}
      {extra}
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="hidden min-w-0 items-center gap-2 xl:flex">
          <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">
            Workspace
            <span className="font-mono normal-case tracking-normal">· {r.mode === "demo" ? "offline replay" : "live"}</span>
          </span>
          {view === "graph" && latestStagedFile && (
            <button
              type="button"
              onClick={() => {
                soundFx.playUiClick();
                r.openDiff(
                  latestStagedFile.path,
                  latestStagedFile.diff,
                  (r.report?.files_created ?? []).includes(latestStagedFile.path)
                );
              }}
              className="inline-flex h-5 max-w-[220px] items-center gap-1 truncate rounded-md border border-ok/35 bg-ok/10 px-1.5 font-mono text-[10px] font-medium text-ok hover:bg-ok/18"
              title={`Inspect staged diff: ${latestStagedFile.path}`}
            >
              <FileCode2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{latestStagedFile.path.split("/").pop()}</span>
            </button>
          )}
        </div>
        <Segmented<DeckView>
          ariaLabel="Workspace view"
          size="xs"
          value={view}
          onChange={setView}
          options={[
            {
              value: "graph",
              label: label(<BrainCircuit />, "Thought Graph", <CountPill n={nodes} active={view !== "db"} />),
              title: "Live reasoning DAG: plan branches, forge sandbox, rehearsal, risk gate, commit, anticipate",
            },
            {
              value: "db",
              label: label(
                <Database />,
                "Ledger & Schema",
                liveChangeCount > 0 ? (
                  <CountPill n={liveChangeCount} active={view === "db"} tone={r.runStatus === "committed" ? "accent" : "warn"} />
                ) : undefined
              ),
              title: "Live ERP tables, SQLite Schema DDL & staged workspace files",
            },
            { value: "split", label: label(<Rows2 />, "Split View"), title: "Thought Graph above SQLite & Schema Studio" },
          ]}
        />
      </div>

      {view !== "db" && (
        <NeuralGraph
          graph={r.graph}
          onDecide={r.decide}
          onAcceptOffer={r.acceptOffer}
          onDismissOffer={r.dismissOffer}
          onSwitchToStudio={() => setView("db")}
          dockAnchor={view === "graph"}
          className={view === "split" ? "h-[320px] shrink-0" : "min-h-0 flex-1"}
        />
      )}
      {view !== "graph" && (
        <DatabaseStudio
          ws={r.wsState}
          report={r.report}
          rowMarks={r.rowMarks}
          ghostRows={r.ghostRows}
          fileMarks={r.fileMarks}
          rewinding={!!r.rewind}
          committed={r.runStatus === "committed"}
          pulseKey={r.pulses.db}
          onOpenFile={r.openFile}
          focusTable={r.requestedDbTable}
        />
      )}
    </div>
  );
}
