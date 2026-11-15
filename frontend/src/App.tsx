import { useEffect, useRef, useState } from "react";
import { CommandBar } from "./components/CommandBar";
import { ForgeVault, PlanPanel } from "./components/LeftRail";
import { LiveWindowLayer } from "./components/LiveWindows";
import { MobileGate } from "./components/MobileGate";
import { PipelineRibbon } from "./components/PipelineRibbon";
import { RewindOverlay } from "./components/RewindOverlay";
import { AnticipateCard, CostMonitor, DiffStack, StatsStrip } from "./components/RightRail";
import { Telemetry } from "./components/Telemetry";
import { TopBar } from "./components/TopBar";
import { OperatorConsultPanel } from "./components/OperatorConsultPanel";
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
      if (defaultGoal.toLowerCase().includes("audit shipment d-1042")) {
        setGoal(PRESET_SCENARIOS[0].goal);
      } else {
        setGoal(defaultGoal);
      }
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
  const claimsRows = r.wsState?.tables?.claims ?? [];
  const latestClaim = claimsRows[claimsRows.length - 1];
  const committedClaimId =
    r.runStatus === "committed" || claimsRows.length > 0 ? String(latestClaim?.id ?? "CLM-D-1042") : null;
  const desktopVoiceTurnHandler = r.sendDesktopVoiceTurn;

  return (
    <div className="recoup-canvas flex min-h-screen flex-col text-ink lg:h-screen lg:overflow-hidden">
      <TopBar r={r} theme={theme} onToggleTheme={toggle} onOpenMobile={openMobile} />

      <div className="relative z-[25] flex shrink-0 items-center gap-4 border-b border-line bg-surface/40 px-4 py-2 backdrop-blur-xl">
        <CommandBar
          value={goal}
          onChange={setGoal}
          onSubmit={run}
          busy={r.runStatus === "running" || r.runStatus === "committing"}
          brandName={brand_name}
          pendingApproval={r.pendingApproval}
          onApprove={r.decide}
          onDesktopVoiceTurn={desktopVoiceTurnHandler}
          speaking={r.speaking}
          spokenText={r.spokenText}
          speechProgress={r.speechProgress}
          evidenceItems={r.evidenceItems}
          uploadingEvidence={r.uploadingEvidence}
          onUploadEvidence={r.uploadEvidence}
          onDismissEvidence={r.dismissEvidence}
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

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 overflow-y-auto lg:grid-cols-12 lg:overflow-hidden">
        {/* Left Column (col-span-3) */}
        <div className="min-h-0 flex flex-col gap-3 lg:col-span-3 lg:overflow-hidden">
          <div className="min-h-0 flex-1 flex flex-col [&>section]:h-full [&>section]:flex-1 [&>section]:min-h-0">
            <PlanPanel plan={r.plan} verify={r.verify} presets={presets} onRun={run} />
          </div>
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

        {/* Center Column (col-span-5) */}
        <div className="min-h-0 flex flex-col gap-3 lg:col-span-5 lg:overflow-hidden">
          <div className="min-h-0 flex-1 flex flex-col [&>div]:h-full [&>div]:min-h-0 [&>div]:flex-1">
            <WorkspaceDeck r={r} />
          </div>
          <Telemetry events={r.events} queued={r.queued} connected={r.connected} mode={r.mode} />
        </div>

        {/* Right Column (col-span-4) */}
        <div className="min-h-0 flex flex-col gap-3 lg:col-span-4 lg:overflow-y-auto scroll-thin">
          <OperatorConsultPanel
            brandName={brand_name}
            consult={r.operatorConsult}
            pendingApproval={r.pendingApproval}
            committedClaimId={committedClaimId}
            voiceOn={r.voiceOn}
            speaking={r.speaking}
            onDesktopVoiceTurn={desktopVoiceTurnHandler}
            onEscalateToPhone={r.escalateToPhone}
            onSelectResolution={r.respondOperatorConsult}
            onReject={(reqId) => r.decide(reqId, false)}
            onReplayTurn={r.replayConsultTurn}
            irisGate={r.wsState?.iris_gate ?? r.wsState?.active_call?.iris_gate}
            activeCall={r.wsState?.active_call}
          />
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
          <CostMonitor events={r.events} totalCost={r.totalCost} irisUsage={r.wsState?.iris_usage} />
        </div>
      </main>

      <LiveWindowLayer windows={r.windows} speed={r.speed} onDocked={r.dockWindow} onTogglePin={r.togglePin} />
      <RewindOverlay rewind={r.rewind} />
    </div>
  );
}
