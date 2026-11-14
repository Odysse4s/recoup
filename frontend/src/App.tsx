import { AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { CommandBar } from "./components/CommandBar";
import { ForgeVault, PlanPanel } from "./components/LeftRail";
import { LiveWindowLayer } from "./components/LiveWindows";
import { MobileGate } from "./components/MobileGate";
import { PipelineRibbon } from "./components/PipelineRibbon";
import { RewindOverlay } from "./components/RewindOverlay";
import { AnticipateCard, DiffStack, RiskGateCard, StatsStrip } from "./components/RightRail";
import { Telemetry } from "./components/Telemetry";
import { TopBar } from "./components/TopBar";
import { WorkspaceDeck } from "./components/WorkspaceDeck";
import { useRecoup } from "./hooks/useRecoup";
import { useTheme } from "./lib/theme";
import type { Preset } from "./lib/types";
import { FOLLOW_UP_GOAL, HERO_GOAL } from "./mockEvents";

const PRESET_SCENARIOS: Preset[] = [
  {
    title: "Audit IT Shipment Discrepancy, Stage ERP Hold & Gate Vendor Claim",
    badge: "HERO RUN",
    goal: HERO_GOAL,
    desc: "Cross-checks IT receiving log against the master contract, synthesizes a sandboxed SLA calculator, stages the ERP invoice hold + credit claim as a diff, and gates outbound dispatch.",
  },
  {
    title: "Sweep Paid AP Ledger for Unclaimed Vendor SLA Credits",
    badge: "FOLLOW-UP",
    goal: FOLLOW_UP_GOAL,
    desc: "Finds short-shipped and DOA units on already-paid invoices and stages one consolidated claim.",
  },
];

const isMobileRoute = () => window.location.pathname === "/mobile" || window.location.hash === "#mobile";

export default function App() {
  const [mobile, setMobile] = useState(isMobileRoute);
  const r = useRecoup({ liveWindows: !mobile });
  const { theme, toggle } = useTheme();
  const [goal, setGoal] = useState(PRESET_SCENARIOS[0].goal);

  const { brand_name, brand_tagline, primary_color } = r.brand;
  useEffect(() => {
    document.documentElement.dataset.themeAccent = primary_color;
    document.title = `${brand_name} — ${brand_tagline}`;
  }, [brand_name, brand_tagline, primary_color]);

  const syncedGoalRef = useRef(false);
  useEffect(() => {
    if (syncedGoalRef.current) return;
    const defaultGoal = r.wsState?.domain?.default_goal ?? r.wsState?.domain?.presets?.[0]?.goal;
    if (defaultGoal) {
      syncedGoalRef.current = true;
      setGoal(defaultGoal);
    }
  }, [r.wsState?.domain]);

  useEffect(() => {
    const onHash = () => setMobile(isMobileRoute());
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  const openMobile = () => {
    window.history.pushState(null, "", window.location.pathname === "/mobile" ? "/mobile" : "#mobile");
    setMobile(true);
  };
  const openDesktop = () => {
    window.history.pushState(null, "", "/");
    setMobile(false);
  };

  if (mobile) {
    return <MobileGate r={r} theme={theme} onToggleTheme={() => toggle()} onExit={openDesktop} />;
  }

  const run = (g: string) => {
    setGoal(g);
    r.triggerGoal(g);
  };
  const presets = r.wsState?.domain?.presets ?? PRESET_SCENARIOS;
  const rewinding = !!r.rewind;

  return (
    <div className="recoup-canvas flex min-h-screen flex-col text-ink lg:h-screen lg:overflow-hidden">
      <TopBar r={r} theme={theme} onToggleTheme={toggle} onOpenMobile={openMobile} />

      <div className="relative z-[25] flex shrink-0 items-center gap-6 border-b border-line bg-surface/40 px-5 py-3 backdrop-blur-xl">
        <CommandBar
          value={goal}
          onChange={setGoal}
          onSubmit={run}
          busy={r.runStatus !== "idle"}
          brandName={brand_name}
          pendingApproval={r.pendingApproval}
          onApprove={r.decide}
          speaking={r.speaking}
          spokenText={r.spokenText}
          speechProgress={r.speechProgress}
        />
        <StatsStrip steps={r.stepCount} cost={r.totalCost} forged={r.forgedTools.length} pending={!!r.pendingApproval} />
      </div>

      <PipelineRibbon
        stage={r.stage}
        stageDone={r.stageDone}
        runStatus={r.runStatus}
        narration={r.narration}
        runStartedAt={r.runStartedAt}
        danger={!!r.pendingApproval}
        rewinding={rewinding}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-12 lg:overflow-hidden">
        <div className="scroll-thin flex min-h-0 flex-col gap-4 lg:col-span-3 lg:overflow-y-auto">
          <PlanPanel plan={r.plan} verify={r.verify} presets={presets} onRun={run} />
          <ForgeVault
            tools={r.forgedTools}
            forgeSpec={r.forgeSpec}
            forgeTest={r.forgeTest}
            forgedCode={r.forgedCode}
            onInspect={r.openForged}
            pulseKey={r.pulses.vault}
            brandName={brand_name}
          />
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 lg:col-span-5 lg:overflow-y-auto">
          <AnimatePresence initial={false}>
            {r.pendingApproval && <RiskGateCard key={r.pendingApproval.req_id} approval={r.pendingApproval} onDecide={r.decide} />}
          </AnimatePresence>
          <WorkspaceDeck r={r} />
          <Telemetry events={r.events} queued={r.queued} connected={r.connected} mode={r.mode} />
        </div>

        <div className="scroll-thin flex min-h-0 flex-col gap-4 lg:col-span-4 lg:overflow-y-auto">
          <DiffStack
            report={r.report}
            ws={r.wsState}
            onUndo={r.undo}
            rewinding={rewinding}
            pulseKey={r.pulses.diff}
            committed={r.runStatus === "committed"}
            onOpenDiff={r.openDiff}
            onOpenOutbox={r.openOutbox}
          />
          <AnticipateCard offer={r.offer} onAccept={r.acceptOffer} onDismiss={r.dismissOffer} brandName={brand_name} />
        </div>
      </main>

      <LiveWindowLayer windows={r.windows} speed={r.speed} onDocked={r.dockWindow} onTogglePin={r.togglePin} />
      <RewindOverlay rewind={r.rewind} />
    </div>
  );
}
