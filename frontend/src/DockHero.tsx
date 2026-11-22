import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { Forecast, Overview } from "./api";
import type { DockLine } from "./DockScene";
import { dateClock, forecastTime, num, when } from "./format";
import { Card, Label, useCountUp } from "./ui";

// The 3D code is fetched only after the data is on screen.
const DockScene = lazy(() => import("./DockScene"));

type View = "erp" | "evidence" | "concessions" | "demo" | "picks";
const VIEWS: { id: View; label: string; title: string; note: string }[] = [
  { id: "erp", label: "System view", title: "What the stock system says", note: "Shows the ERP assumptions for comparison, not the evidence-based forecast." },
  { id: "evidence", label: "Evidence view", title: "What the paperwork supports", note: "Uses delivery notes, inspections and supplier replies to check what can actually be used." },
];
const PICKS = { id: "picks" as View, label: "Your picks", title: "With the fixes you ticked", note: "Assumes the parts you ticked below are no longer short. Ticking only simulates." };
const CONCESSIONS = { id: "concessions" as View, label: "With concessions", title: "If signed concessions are released in time", note: "Assumes the recorded quantities become usable at the estimated times below and action-dependent shipments arrive. Sign-off does not confirm release or pickup." };
const DEMO = { id: "demo" as View, label: "Demo recovery", title: "If parts are ready earlier",
  note: "Demo assumptions only. The earlier targets below do not confirm delivery or release. This plan still assumes the port pickup." };

const editionName = (name: string | null, id: string) => name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? id;
const copiesShort = (forecast: Forecast) => forecast.products.reduce((sum, p) => sum + p.short, 0);

export function canWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** If the 3D scene cannot load or run, the hero simply goes on without it. */
export class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function DockHero({ data, picks }: { data: Overview; picks: Forecast | null }) {
  // A link can open the hero on a given view (…/?view=erp), so the story can be shared.
  const [view, setView] = useState<View | null>(() => new URLSearchParams(location.search).get("view") as View | null);
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

  // Ticking a fix below brings its own view; clearing the ticks takes it away again.
  const hasPicks = !!picks;
  useEffect(() => setView((v) => (hasPicks ? "picks" : v === "picks" ? null : v)), [hasPicks]);
  const recorded = data.forecast_with_concessions?.ready ? data.forecast_with_concessions : null;
  const demo = data.demo_recovery?.forecast.ready ? data.demo_recovery : null;
  const recovery = demo ? DEMO : recorded ? CONCESSIONS : null;
  const views = [...VIEWS, ...(recovery ? [recovery] : []), ...(picks ? [PICKS] : [])];
  const forecasts: Record<View, Forecast> = { erp: data.erp_forecast, evidence: data.forecast,
    concessions: recorded ?? data.forecast, demo: demo?.forecast ?? data.forecast, picks: picks ?? data.forecast };
  const selected = view && views.some((v) => v.id === view) ? view : recovery?.id ?? "evidence";
  const f = forecasts[selected];
  const partName = new Map(data.forecast.components.map((c) => [c.material_id, c.description ?? c.material_id]));
  const short = copiesShort(f);
  const shown = useCountUp(short);
  const shortEditions = f.products.filter((p) => p.short > 0);
  const onlyShortEdition = shortEditions.length === 1 ? shortEditions[0] : null;

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
  const container = (selected === "concessions" || selected === "demo") && data.forecast.components.some((c) => c.inbound_needing_action > 0);
  const meta = views.find((v) => v.id === selected) ?? VIEWS[1];
  const comparison = selected === "concessions" || selected === "demo" ? data.recovery_comparison : null;
  const lateParts = selected === "demo" ? demo?.late_parts : comparison?.late_parts;
  const evidenceShort = copiesShort(data.forecast);

  return (
    <Card className="overflow-hidden">
      <div className="dusk flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <Label>Compare launch scenarios</Label>
          <div className="mt-0.5 font-display text-lg font-semibold">{meta.title}</div>
        </div>
        <div role="group" aria-label="Compare forecast scenarios" className="flex max-w-full flex-wrap rounded-2xl border border-line bg-card p-1 text-sm">
          {views.map((v) => (
            <button
              key={v.id}
              aria-pressed={selected === v.id}
              onClick={() => setView(v.id)}
              className={`whitespace-nowrap rounded-full px-2.5 py-1.5 font-medium transition-colors sm:px-3 duration-200 ${selected === v.id ? "bg-accent-600 text-white" : "text-muted hover:bg-accent-soft hover:text-ink"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`grid ${three ? "lg:grid-cols-[1.45fr_1fr]" : ""}`}>
        {three && (
          <div ref={stage} className="relative h-[210px] min-w-0 overflow-hidden sm:h-[300px] lg:h-[360px] 2xl:h-[420px]">
            <Quiet>
              <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">Setting up the dock…</div>}>
                <DockScene lines={lines} container={container} active={active} />
              </Suspense>
            </Quiet>
            {perGhost > 0 && (
              <div className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-1.5 text-[11px] text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-bad/45 ring-1 ring-bad/50" /> Each translucent box represents about {num(perGhost)} missing copies
              </div>
            )}
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-4 border-line p-4 sm:p-5 lg:border-l">
          <div>
            <div className={`font-display text-5xl font-semibold tracking-tight sm:text-[56px] ${short > 0 ? "text-bad-ink" : "text-good-ink"}`} aria-live="polite">
              {num(shown)}
            </div>
            <div className="text-sm text-muted">
              {onlyShortEdition && `${editionName(onlyShortEdition.name, onlyShortEdition.product_id)} `}
              copies projected to miss the launch
            </div>
          </div>

          {f.products.map((p) => {
            const share = (n: number) => `${(100 * n) / Math.max(1, p.day_one_demand)}%`;
            return (
              <div key={p.product_id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-semibold">{editionName(p.name, p.product_id)}</span>
                  <span className="text-muted">
                    {num(p.packed + p.packed_by_deadline)} of {num(p.day_one_demand)} by deadline
                  </span>
                </div>
                <div className="mt-1.5 flex h-3 overflow-hidden rounded-full bg-line" role="img" aria-label={`${num(p.packed)} packed, ${num(p.packed_by_deadline)} still feasible${onlyShortEdition && p.short > 0 ? "" : `, ${num(p.short)} short`}`}>
                  <div className="bg-good transition-[width] duration-500 ease-out" style={{ width: share(p.packed) }} />
                  <div className="bg-coral transition-[width] duration-500 ease-out" style={{ width: share(p.packed_by_deadline) }} />
                  <div className="hatch transition-[width] duration-500 ease-out" style={{ width: share(p.short) }} />
                </div>
                {p.short > 0 && p.first_stop ? (
                  <div className="mt-2 flex items-start gap-2.5 rounded-lg bg-accent-600 px-3 py-2 text-sm text-white">
                    <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M12 8v5M12 16.5v.5M10.3 4.2L2.8 17.5A2 2 0 004.5 20.5h15a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" />
                    </svg>
                    <span>
                      <span className="font-semibold">First modeled stall {forecastTime(p.first_stop.at)}</span> for {partName.get(p.first_stop.material_id) ?? p.first_stop.material_id}
                      {!onlyShortEdition && <span className="block font-display text-base font-semibold">{num(p.short)} short by the deadline</span>}
                    </span>
                  </div>
                ) : p.short > 0 ? (
                  onlyShortEdition ? null : <div className="mt-2 text-sm font-semibold text-bad-ink">{num(p.short)} short by the deadline</div>
                ) : (
                  <div className="mt-2 rounded-lg bg-band px-3 py-2 text-sm font-semibold text-ink ring-1 ring-line">
                    {p.finished_at ? `Finishes ${when(p.finished_at)}, in time` : "Packed in time"}
                  </div>
                )}
              </div>
            );
          })}

          <div className="mt-auto space-y-2 text-xs text-muted">
            <p>{meta.note}</p>
            {short > 0 && !!lateParts?.length && (
              <div className="space-y-1 rounded-lg border border-line bg-band px-3 py-2">
                <p className="font-semibold text-ink">After launch</p>
                {lateParts.map((part) => (
                  <p key={part.material_id}>{part.description}: enough stock to cover the part gap is expected {when(part.expected_date)}.</p>
                ))}
                <p>Clearing the backlog still depends on delivery and scheduled packing. No dispatch date is confirmed.</p>
              </div>
            )}
            {comparison && (
              <details className="rounded-lg border border-line bg-band px-3 py-2">
                <summary className="cursor-pointer font-semibold text-ink">Timing and forecast details</summary>
                <div className="mt-2 space-y-2">
                  <p>Evidence view: {num(evidenceShort)} copies projected to miss launch.</p>
                  {comparison.without_supplier_commitments !== evidenceShort && (
                    <p>Without supplier commitments: {num(comparison.without_supplier_commitments)} projected to miss launch.</p>
                  )}
                  {selected === "demo" && recorded && <>
                    {recorded.products.filter((p) => p.finished_at).map((p) => (
                      <p key={p.product_id}>At the recorded estimates, {editionName(p.name, p.product_id)} finishes {when(p.finished_at)}.</p>
                    ))}
                    {copiesShort(recorded) !== short && (
                      <p>At the recorded estimates, {num(copiesShort(recorded))} copies are projected to miss launch.</p>
                    )}
                  </>}
                  {selected === "demo" && demo?.targets.map((target) => (
                    <p key={target.material_id}>
                      <span className="font-semibold text-ink">{target.description}:</span>{" "}
                      assumed ready for packing {forecastTime(target.ready_at)} (Hamburg time).
                    </p>
                  ))}
                </div>
              </details>
            )}
            {selected === "concessions" && data.recorded_releases?.map((release) => (
              <p key={release.case_key} className="rounded-lg border border-line bg-band px-3 py-2">
                <span className="font-semibold text-ink">{release.description}: {num(release.quantity)} pieces.</span>{" "}
                Approval recorded {dateClock(release.recorded_at)}; estimated release {forecastTime(release.expected_at)} (Hamburg time).
              </p>
            ))}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-good" />Already packed</span>
              <span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-coral" />Expected to pack</span>
              <span><i className="hatch mr-1.5 inline-block h-2 w-2 rounded-sm" />Short</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
