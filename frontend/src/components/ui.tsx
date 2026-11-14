import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { soundFx } from "../lib/sound";

export type Tone = "ok" | "warn" | "danger" | "accent" | "forge" | "signal" | "neutral";

export const TONE: Record<Tone, { text: string; soft: string; border: string; solid: string; dot: string; glow: string }> = {
  ok: {
    text: "text-ok",
    soft: "bg-ok/10",
    border: "border-ok/30",
    solid: "bg-ok text-on-solid",
    dot: "bg-ok",
    glow: "shadow-[0_0_0_1px_var(--ok),0_0_32px_-4px_var(--ok)]",
  },
  warn: {
    text: "text-warn",
    soft: "bg-warn/10",
    border: "border-warn/35",
    solid: "bg-warn text-on-solid",
    dot: "bg-warn",
    glow: "shadow-[0_0_0_1px_var(--warn),0_0_32px_-4px_var(--warn)]",
  },
  danger: {
    text: "text-danger",
    soft: "bg-danger/10",
    border: "border-danger/35",
    solid: "bg-danger text-white",
    dot: "bg-danger",
    glow: "shadow-[0_0_0_1px_var(--danger),0_0_32px_-4px_var(--danger)]",
  },
  accent: {
    text: "text-accent",
    soft: "bg-accent/10",
    border: "border-accent/35",
    solid: "bg-accent text-white dark:text-on-solid",
    dot: "bg-accent",
    glow: "shadow-[0_0_0_1px_var(--accent),0_0_32px_-4px_var(--accent)]",
  },
  forge: {
    text: "text-forge",
    soft: "bg-forge/10",
    border: "border-forge/35",
    solid: "bg-forge text-white dark:text-on-solid",
    dot: "bg-forge",
    glow: "shadow-[0_0_0_1px_var(--forge),0_0_32px_-4px_var(--forge)]",
  },
  signal: {
    text: "text-signal",
    soft: "bg-signal/10",
    border: "border-signal/35",
    solid: "bg-signal text-white dark:text-on-solid",
    dot: "bg-signal",
    glow: "shadow-[0_0_0_1px_var(--signal),0_0_32px_-4px_var(--signal)]",
  },
  neutral: {
    text: "text-ink-2",
    soft: "bg-sunken",
    border: "border-line",
    solid: "bg-ink text-canvas",
    dot: "bg-ink-3",
    glow: "shadow-[0_0_0_1px_var(--line-strong)]",
  },
};

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Chip({
  tone = "neutral",
  children,
  className,
  solid,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  solid?: boolean;
}) {
  const t = TONE[tone];
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-mono text-[10px] font-medium uppercase tracking-wide",
        solid ? cx(t.solid, "border-transparent") : cx(t.soft, t.border, t.text),
        className
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = "neutral", live }: { tone?: Tone; live?: boolean }) {
  const t = TONE[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {live && <span className={cx("absolute inset-0 rounded-full opacity-60 animate-ping", t.dot)} />}
      <span className={cx("relative h-2 w-2 rounded-full", t.dot)} />
    </span>
  );
}

type BtnVariant = "primary" | "ghost" | "outline" | "ok" | "danger" | "warn" | "signal";

export function btn(variant: BtnVariant = "outline", size: "sm" | "md" | "lg" = "md") {
  const sizes = {
    sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
    md: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
    lg: "h-10 px-4 text-[13px] gap-2 rounded-lg",
  };
  const variants: Record<BtnVariant, string> = {
    primary:
      "bg-accent text-white dark:text-on-solid font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.2)] hover:brightness-110 active:brightness-95",
    ghost: "text-ink-2 hover:text-ink hover:bg-sunken",
    outline: "border border-line bg-surface text-ink hover:bg-sunken hover:border-line-strong",
    ok: "bg-ok text-on-solid font-semibold hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]",
    danger: "bg-danger text-white font-semibold hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]",
    warn: "bg-warn text-on-solid font-semibold hover:brightness-110 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]",
    signal: "bg-signal text-white dark:text-on-solid font-semibold hover:brightness-110",
  };
  return cx(
    "inline-flex items-center justify-center whitespace-nowrap font-medium transition-all duration-150 disabled:opacity-40 select-none",
    sizes[size],
    variants[variant]
  );
}

export function PulseRing({ pulseKey, tone }: { pulseKey: number; tone: Tone }) {
  return (
    <AnimatePresence>
      {pulseKey > 0 && (
        <motion.span
          key={pulseKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.6, times: [0, 0.12, 0.5, 1] }}
          className={cx("pointer-events-none absolute inset-0 z-20 rounded-[inherit]", TONE[tone].glow)}
        />
      )}
    </AnimatePresence>
  );
}

export function Panel({
  title,
  icon,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  anchor,
  pulseKey = 0,
  pulseTone = "accent",
}: {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  anchor?: (el: HTMLElement | null) => void;
  pulseKey?: number;
  pulseTone?: Tone;
}) {
  return (
    <section
      ref={anchor}
      className={cx("relative flex min-h-0 flex-col rounded-xl border border-line bg-surface shadow-card", className)}
    >
      <PulseRing pulseKey={pulseKey} tone={pulseTone} />
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="text-ink-3 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
          <h2 className="truncate text-[12px] font-semibold tracking-tight text-ink">{title}</h2>
          {meta}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      <div className={cx("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

export interface DrawerProps {
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  bodyClassName?: string;
  anchor?: (el: HTMLElement | null) => void;
  pulseKey?: number;
  pulseTone?: Tone;
  children: ReactNode;
}

export function Drawer({
  title,
  icon,
  badge,
  actions,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
  bodyClassName,
  anchor,
  pulseKey = 0,
  pulseTone = "accent",
  children,
}: DrawerProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  const toggleOpen = () => {
    soundFx.playUiClick();
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <section
      ref={anchor}
      className={cx(
        "relative flex min-h-0 shrink-0 flex-col rounded-xl border border-line bg-surface shadow-card transition-colors",
        className
      )}
    >
      <PulseRing pulseKey={pulseKey} tone={pulseTone} />
      <header
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
        className={cx(
          "flex h-[38px] min-h-[38px] cursor-pointer select-none items-center justify-between gap-2 px-3.5 transition-colors hover:bg-sunken/40",
          isOpen && "border-b border-line"
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span className="text-ink-3 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
          <h2 className="truncate text-[12px] font-semibold tracking-tight text-ink">{title}</h2>
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions && (
            <div
              className="flex shrink-0 items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {actions}
            </div>
          )}
          <span
            aria-hidden
            className={cx(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center text-ink-3 transition-transform duration-200",
              isOpen ? "rotate-180 text-ink" : "rotate-0"
            )}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </div>
      </header>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className={cx("min-h-0", bodyClassName)}>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "xs" | "sm";
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="relative flex items-center rounded-lg border border-line bg-sunken p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => {
              if (!active) soundFx.playUiClick();
              onChange(o.value);
            }}
            className={cx(
              "relative z-10 whitespace-nowrap rounded-md font-medium transition-colors",
              size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
              active ? "text-ink" : "text-ink-3 hover:text-ink-2"
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${ariaLabel}`}
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
                className="absolute inset-0 -z-10 rounded-md border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-sunken px-1 font-mono text-[10px] text-ink-3">
      {children}
    </kbd>
  );
}

export function Equalizer({
  active,
  bars = 5,
  tone = "accent",
  className,
}: {
  active: boolean;
  bars?: number;
  tone?: Tone;
  className?: string;
}) {
  const delays = [0, 0.18, 0.36, 0.12, 0.3, 0.06, 0.24, 0.42];
  const durs = [0.82, 0.64, 0.92, 0.7, 0.86, 0.6, 0.78, 0.9];
  return (
    <span aria-hidden className={cx("inline-flex h-4 items-center gap-[2px]", className)}>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cx("h-full w-[2.5px] rounded-full", TONE[tone].dot, active ? "eq-bar" : "opacity-40")}
          style={
            active
              ? { animationDelay: `${delays[i % 8]}s`, animationDuration: `${durs[i % 8]}s` }
              : { transform: `scaleY(${0.25 + ((i * 37) % 5) * 0.08})` }
          }
        />
      ))}
    </span>
  );
}
