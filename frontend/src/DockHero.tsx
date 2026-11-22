import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { Forecast, Overview } from "./api";
import type { DockLine } from "./DockScene";
import { num, when } from "./format";
import { Card, Label, useCountUp } from "./ui";

// The 3D code is fetched only after the data is on screen.
const DockScene = lazy(() => import("./DockScene"));

type View = "erp" | "evidence" | "acted";
const VIEWS: { id: View; label: string; title: string; note: string }[] = [
  { id: "erp", label: "System view", title: "What the system says", note: "Stock and deliveries exactly as Soony's ERP shows them." },
  { id: "evidence", label: "Evidence view", title: "What the paperwork supports", note: "Only what delivery notes, inspections and supplier mails support." },
  { id: "acted", label: "If we act", title: "If the open actions land", note: "Also counts goods that only arrive if somebody acts, such as the container at the port." },
];

const editionName = (name: string | null, id: string) => name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? id;

function canWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** If the 3D scene cannot load or run, the hero simply goes on without it. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function DockHero({ data }: { data: Overview }) {
  // A link can open the hero on a given view (…/?view=erp), so the story can be shared.
  const [view, setView] = useState<View>(() => {
    const asked = new URLSearchParams(location.search).get("view") as View | null;
    return VIEWS.some((v) => v.id === asked) ? asked! : "evidence";
  });
  const [three] = useState(() => canWebGL() && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [active, setActive] = useState(true);
  const stage = useRef<HTMLDivElement>(null);

  // The scene only animates while it is on screen in a visible tab.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let onScreen = true;
    const update = () => setActive(onScreen && document.visibilityState === "visible");
    const watcher = new IntersectionObserver(([entry]) => ((onScreen = entry.isIntersecting), update()), { threshold: 0.05 });
    watcher.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      watcher.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [three]);

  const forecasts: Record<View, Forecast> = { erp: data.erp_forecast, evidence: data.forecast, acted: data.forecast_if_acted };
  const f = forecasts[view];
  const partName = new Map(data.forecast.components.map((c) => [c.material_id, c.description ?? c.material_id]));
  const short = f.products.reduce((sum, p) => sum + p.short, 0);
  const shown = useCountUp(short);

  // One ghost box stands for the same number of copies in every view, so the views can be compared.
  const worst = Math.max(0, ...Object.values(forecasts).flatMap((x) => x.products.map((p) => p.short)));
  const perGhost = worst > 0 ? Math.max(100, Math.ceil(worst / 12 / 500) * 500) : 0;
  const fastest = Math.max(1, ...f.products.map((p) => p.rate_per_hour));
  const lines: DockLine[] = f.products.map((p) => ({
    id: p.product_id,
    stopped: p.short > 0,
    speed: 0.5 + (1.5 * p.rate_per_hour) / fastest,
    ghosts: perGhost ? Math.min(12, Math.ceil(p.short / perGhost)) : 0,
  }));
  const container = view === "acted" && data.forecast.components.some((c) => c.inbound_needing_action > 0);
  const meta = VIEWS.find((v) => v.id === view)!;

  return (
    <Card className="overflow-hidden">
      <div className="dusk flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <Label>The Hamburg dock · trucks leave {when(f.deadline)}</Label>
          <div className="mt-0.5 font-display text-lg font-semibold">{meta.title}</div>
        </div>
        <div role="radiogroup" aria-label="Which forecast to show" className="flex max-w-full rounded-full border border-line bg-card p-1 text-sm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="radio"
              aria-checked={view === v.id}
              onClick={() => setView(v.id)}
              className={`whitespace-nowrap rounded-full px-2.5 py-1.5 font-medium transition-colors sm:px-3 duration-200 ${view === v.id ? "bg-accent-600 text-white" : "text-muted hover:bg-accent-soft hover:text-ink"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`grid ${three ? "lg:grid-cols-[1.45fr_1fr]" : ""}`}>
        {three && (
          <div ref={stage} className="relative h-[210px] min-w-0 overflow-hidden sm:h-[300px] lg:h-[360px]">
            <Quiet>
              <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">Setting up the dock…</div>}>
                <DockScene lines={lines} container={container} active={active} />
              </Suspense>
            </Quiet>
            {perGhost > 0 && (
              <div className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-1.5 text-[11px] text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-bad/45 ring-1 ring-bad/50" /> one ghost box = {num(perGhost)} copies that miss the trucks
              </div>
            )}
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-4 border-line p-4 sm:p-5 lg:border-l">
          <div>
            <div className={`font-display text-5xl font-semibold tracking-tight sm:text-[56px] ${short > 0 ? "text-bad-ink" : "text-good-ink"}`} aria-live="polite">
              {num(shown)}
            </div>
            <div className="text-sm text-muted">{short > 0 ? "copies miss the launch in this view" : "copies miss the launch: every one is packed in time"}</div>
          </div>

          {f.products.map((p) => {
            const share = (n: number) => `${(100 * n) / Math.max(1, p.day_one_demand)}%`;
            return (
              <div key={p.product_id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-semibold">{editionName(p.name, p.product_id)}</span>
                  <span className="text-muted">
                    {num(p.packed + p.packed_by_deadline)} of {num(p.day_one_demand)} by {when(f.deadline)}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-accent-soft" role="img" aria-label={`${num(p.packed)} packed, ${num(p.packed_by_deadline)} still feasible, ${num(p.short)} short`}>
                  <div className="bg-accent-600 transition-[width] duration-500 ease-out" style={{ width: share(p.packed) }} />
                  <div className="bg-sky transition-[width] duration-500 ease-out" style={{ width: share(p.packed_by_deadline) }} />
                  <div className="bg-bad transition-[width] duration-500 ease-out" style={{ width: share(p.short) }} />
                </div>
                <div className={`mt-1.5 text-sm ${p.short > 0 ? "text-bad-ink" : "text-good-ink"}`}>
                  {p.short > 0 && p.first_stop
                    ? `First stops ${when(p.first_stop.at)} for ${partName.get(p.first_stop.material_id) ?? p.first_stop.material_id} · ${num(p.short)} short by the deadline`
                    : p.finished_at
                      ? `Finishes ${when(p.finished_at)}`
                      : "Packed in time"}
                </div>
              </div>
            );
          })}

          <p className="mt-auto text-xs text-muted">
            {meta.note} <span className="whitespace-nowrap">Dark: packed · blue: still feasible · coral: short.</span>
          </p>
        </div>
      </div>
    </Card>
  );
}
