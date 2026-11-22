import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CaseState } from "./api";

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A card. With `tilt` it leans up to three degrees towards the pointer. */
export function Card({ children, className = "", tilt = false }: { children: ReactNode; className?: string; tilt?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!tilt || !el || calm() || !matchMedia("(hover: hover)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 3).toFixed(2)}deg)`;
    };
    const leave = () => (el.style.transform = "");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [tilt]);
  return (
    <section ref={ref} className={`rise rounded-2xl border border-line bg-card shadow-card transition-transform duration-300 ease-out ${className}`}>
      {children}
    </section>
  );
}

/** A number that counts to its new value once, instead of jumping. */
export function useCountUp(target: number, ms = 400): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (calm() || from.current === target) return setShown(target);
    const start = performance.now();
    const begin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const value = begin + (target - begin) * (1 - (1 - t) ** 3);
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return Math.round(shown);
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{children}</div>;
}

type Tone = "bad" | "warn" | "good" | "neutral";
const TONES: Record<Tone, string> = {
  bad: "bg-bad-soft text-bad-ink ring-1 ring-bad/20",
  warn: "bg-warn-soft text-warn-ink",
  good: "bg-good-soft text-good-ink",
  neutral: "bg-band text-ink-2 ring-1 ring-line",
};

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block max-w-full truncate rounded-full px-2.5 py-0.5 align-bottom text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const STATES: Record<CaseState, { label: string; tone: Tone }> = {
  needs_human: { label: "Handed over to you", tone: "bad" },
  needs_approval: { label: "Needs your approval", tone: "bad" },
  supplier_answered: { label: "Supplier answered", tone: "warn" },
  waiting_for_supplier: { label: "Waiting for supplier", tone: "neutral" },
  proposed: { label: "Recommendation ready", tone: "warn" },
};

export function StateChip({ state }: { state: CaseState }) {
  return <Chip tone={STATES[state].tone}>{STATES[state].label}</Chip>;
}

export function Button({
  children,
  onClick,
  kind = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "quiet";
  disabled?: boolean;
}) {
  const style =
    kind === "primary"
      ? "bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50"
      : "border border-line bg-card text-ink hover:bg-accent-soft disabled:text-muted";
  return (
    <button onClick={onClick} disabled={disabled} className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors duration-200 ${style}`}>
      {children}
    </button>
  );
}
