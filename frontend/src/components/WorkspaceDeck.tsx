import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit, Database, Rows2 } from "lucide-react";
import type { ReactNode } from "react";
import type { RecoupRuntime } from "../hooks/useRecoup";
import { usePersistentState } from "../lib/usePersistentState";
import { DatabaseStudio } from "./DatabaseStudio";
import { NeuralGraph } from "./NeuralGraph";
import { cx, Segmented } from "./ui";

type DeckView = "studio" | "graph" | "split";

const defaultView = (): DeckView =>
  typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches ? "split" : "studio";

function NodeCount({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={cx(
        "relative inline-flex h-4 min-w-4 items-center justify-center overflow-hidden rounded-[5px] px-1 font-mono text-[9.5px] font-semibold tabular",
        active ? "bg-accent/15 text-accent" : "bg-line text-ink-3"
      )}
      aria-label={`${n} nodes`}
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

/** Centre-column deck: SQLite Studio, the Execution Thought Graph, or both stacked (default on desktop). */
export function WorkspaceDeck({ r }: { r: RecoupRuntime }) {
  const [view, setView] = usePersistentState<DeckView>("recoup.workspaceView", defaultView());
  const nodes = r.graph.nodes.length;
  const label = (icon: ReactNode, text: string, extra?: ReactNode) => (
    <span className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3">
      {icon}
      {text}
      {extra}
    </span>
  );

  return (
    <div className={cx("flex flex-col gap-2", view === "graph" ? "flex-[1.4_0_auto]" : "flex-[1.15_0_auto]")}>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="hidden items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3 xl:flex">
          Workspace
          <span className="font-mono normal-case tracking-normal">· {r.mode === "demo" ? "offline replay" : "live"}</span>
        </span>
        <Segmented<DeckView>
          ariaLabel="Workspace view"
          size="xs"
          value={view}
          onChange={setView}
          options={[
            { value: "studio", label: label(<Database />, "SQLite Studio"), title: "Live ERP tables & workspace files" },
            {
              value: "graph",
              label: label(<BrainCircuit />, "Thought Graph", <NodeCount n={nodes} active={view !== "studio"} />),
              title: "Live reasoning DAG: plan branches, forge, rehearsal, risk gate, commit, anticipate",
            },
            { value: "split", label: label(<Rows2 />, "Split View"), title: "Thought Graph above SQLite Studio" },
          ]}
        />
      </div>

      {view !== "studio" && (
        <NeuralGraph
          graph={r.graph}
          onDecide={r.decide}
          onAcceptOffer={r.acceptOffer}
          onDismissOffer={r.dismissOffer}
          dockAnchor={view === "graph"}
          className={view === "split" ? "h-[330px] shrink-0" : "min-h-[520px] flex-1"}
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
          pulseKey={r.pulses.db}
          onOpenFile={r.openFile}
        />
      )}
    </div>
  );
}
