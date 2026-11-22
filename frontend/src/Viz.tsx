import type { ReactNode } from "react";
import type { Case, Forecast, Overview } from "./api";
import { clock, num, parts, when } from "./format";

const editionName = (name: string | null, id: string) => name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? id;
const STROKE = { accent: "stroke-accent-600", good: "stroke-good", warn: "stroke-warn", bad: "stroke-bad" };

/** A ring that fills to a share between 0 and 1. */
export function Ring({ share, tone = "accent", size = 56, children }: { share: number; tone?: keyof typeof STROKE; size?: number; children?: ReactNode }) {
  const r = 22;
  const around = 2 * Math.PI * r;
  const filled = around * Math.max(0, Math.min(1, share));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 56 56" className="-rotate-90" aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" className="stroke-accent-soft" />
        <circle
          cx="28" cy="28" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${filled} ${around}`}
          className={`${STROKE[tone]} transition-[stroke-dasharray] duration-700 ease-out`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold">{children}</div>
    </div>
  );
}

type Stretch = { from: number; to: number; state: "run" | "wait" | "night" | "done" };

/** Hour by hour: when each line packs, when it stands waiting for a part, and where "now" is. */
export function LineTimeline({ forecast, now, partName }: { forecast: Forecast; now: string; partName: Map<string, string> }) {
  const t0 = parts(forecast.as_of)?.utc ?? 0;
  const t1 = parts(forecast.deadline)?.utc ?? 1;
  const at = (ms: number) => `${(100 * (ms - t0)) / (t1 - t0)}%`;
  const span = (a: number, b: number) => `${(100 * (b - a)) / (t1 - t0)}%`;
  const nowMs = parts(now)?.utc ?? 0;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / 10_800_000) * 10_800_000; t < t1; t += 10_800_000) ticks.push(t);
  const label = (ms: number) => `${String(new Date(ms).getUTCHours()).padStart(2, "0")}:00`;

  const rows = forecast.products.map((p) => {
    const stretches: Stretch[] = [];
    forecast.timeline.slice(1).forEach((point, i) => {
      const before = forecast.timeline[i];
      const from = parts(before.at)!.utc;
      const to = parts(point.at)!.utc;
      const packed = Number(point[p.product_id] ?? 0);
      const grew = packed > Number(before[p.product_id] ?? 0);
      const state = to - from > 7_200_000 ? "night" : grew ? "run" : packed >= p.to_pack ? "done" : "wait";
      const last = stretches[stretches.length - 1];
      if (last?.state === state) last.to = to;
      else stretches.push({ from, to, state });
    });
    // The forecast names the part behind the first stop only; later stops may be for another part.
    return { p, stretches, firstWait: stretches.find((s) => s.state === "wait") };
  });
  const look: Record<Stretch["state"], string> = {
    run: "bg-good/55", wait: "bg-bad text-white", night: "bg-line/60 text-muted", done: "bg-accent-soft text-ink-2",
  };

  return (
    <div>
      <div className="space-y-3">
        {rows.map(({ p, stretches, firstWait }) => (
          <div key={p.product_id} className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[9.5rem_1fr]">
            <div className="text-sm font-semibold">{editionName(p.name, p.product_id)}</div>
            <div className="relative h-8 overflow-hidden rounded-lg bg-paper ring-1 ring-line">
              {stretches.map((s) => (
                <div
                  key={s.from}
                  className={`absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap px-2 text-[11px] font-medium ${look[s.state]}`}
                  style={{ left: at(s.from), width: span(s.from, s.to) }}
                  title={`${s.state === "run" ? "Packing" : s.state === "wait" ? "Waiting for a part" : s.state === "night" ? "Night, no shift" : "Finished"} · ${when(new Date(s.from).toISOString())} to ${when(new Date(s.to).toISOString())}`}
                >
                  {s.state === "wait"
                    ? s === firstWait && p.first_stop
                      ? `waits for ${partName.get(p.first_stop.material_id) ?? p.first_stop.material_id}`
                      : "waits for a part"
                    : s.state === "night" ? "night" : s.state === "done" ? "done" : ""}
                </div>
              ))}
              {nowMs > t0 && nowMs < t1 && <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: at(nowMs) }} title="Now" />}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 grid gap-x-3 sm:grid-cols-[9.5rem_1fr]">
        <div />
        <div className="relative h-4 text-[11px] text-muted">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: at(t) }}>
              {label(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-good/55" />packing</span>
        <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-bad" />line stands, waiting for a part</span>
        <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-line" />night, no shift</span>
        <span><i className="mr-1.5 inline-block h-3 w-0.5 bg-ink align-middle" />now</span>
        <span>from {when(forecast.as_of)} until the trucks leave {when(forecast.deadline)}</span>
      </div>
    </div>
  );
}

/** What solving each part alone would save, as bars against everything that is short today. */
export function WorthBars({ cases, plan, onOpen }: { cases: Case[]; plan: Overview["plan"]; onOpen: (key: string) => void }) {
  const total = Math.max(1, plan.short_now);
  const together = plan.short_if_all_solved == null ? null : plan.short_now - plan.short_if_all_solved;
  return (
    <div className="space-y-3">
      {[...cases].sort((a, b) => b.saves_alone - a.saves_alone).map((c) => (
        <button key={c.key} onClick={() => onOpen(c.key)} className="block w-full rounded-lg text-left hover:bg-accent-soft/60">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{c.description}</span>
            <span className="shrink-0 font-display font-semibold">{num(c.saves_alone)}</span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-accent-soft">
            <div className="h-full rounded-full bg-sky transition-[width] duration-700 ease-out" style={{ width: `${(100 * c.saves_alone) / total}%` }} />
          </div>
          {c.then_limited_by.length > 0 && <div className="mt-1 truncate text-xs text-muted">then {c.then_limited_by.join(" and ")} hold the line</div>}
        </button>
      ))}
      {together != null && (
        <div className="border-t border-line pt-3">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold">All of them together</span>
            <span className="shrink-0 font-display font-semibold text-good-ink">{num(together)}</span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-accent-soft">
            <div className="h-full rounded-full bg-good transition-[width] duration-700 ease-out" style={{ width: `${(100 * together) / total}%` }} />
          </div>
          <div className="mt-1 text-xs text-muted">
            {plan.short_if_all_solved ? `${num(plan.short_if_all_solved)} copies would still miss the launch` : "every copy is packed in time"}
          </div>
        </div>
      )}
    </div>
  );
}

const SLICES = ["stroke-accent-600", "stroke-sky", "stroke-peach", "stroke-good", "stroke-warn", "stroke-bad", "stroke-accent"];
const DOTS = ["bg-accent-600", "bg-sky", "bg-peach", "bg-good", "bg-warn", "bg-bad", "bg-accent"];

/** Shares of a whole as a ring, with the legend beside it. */
export function Donut({ slices, centre, caption }: { slices: { label: string; value: number; note?: string }[]; centre: string; caption: string }) {
  const r = 40;
  const around = 2 * Math.PI * r;
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative h-36 w-36 shrink-0">
        <svg viewBox="0 0 100 100" className="-rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="13" className="stroke-accent-soft" />
          {total > 0 && slices.map((s, i) => {
            const length = (around * s.value) / total;
            const arc = (
              <circle key={s.label} cx="50" cy="50" r={r} fill="none" strokeWidth="13" strokeDasharray={`${length} ${around}`} strokeDashoffset={-offset} className={SLICES[i % SLICES.length]} />
            );
            offset += length;
            return arc;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-xl font-semibold">{centre}</span>
          <span className="text-[11px] text-muted">{caption}</span>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-1.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.label} className="flex items-baseline justify-between gap-3">
            <span><i className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${DOTS[i % DOTS.length]}`} /><span className="first-letter:uppercase">{s.label}</span></span>
            <span className="text-muted">{s.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A half-circle gauge: how much of a limit is used. */
export function Gauge({ used, limit, label }: { used: number; limit: number; label: string }) {
  const half = Math.PI * 40;
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="relative mx-auto w-52">
      <svg viewBox="0 0 100 56" aria-hidden>
        <path d="M10 50 A40 40 0 0 1 90 50" fill="none" strokeWidth="11" strokeLinecap="round" className="stroke-accent-soft" />
        <path
          d="M10 50 A40 40 0 0 1 90 50" fill="none" strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${half * share} ${half}`}
          className={`${share > 0.85 ? "stroke-bad" : share > 0.6 ? "stroke-warn" : "stroke-good"} transition-[stroke-dasharray] duration-700 ease-out`}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="font-display text-2xl font-semibold">{Math.round(share * 100)}%</div>
        <div className="text-[11px] text-muted">{label}</div>
      </div>
    </div>
  );
}

type Event = Overview["activity"][number];
export const KIND: Record<Event["kind"], { label: string; dot: string }> = {
  files: { label: "New files", dot: "bg-accent-600" },
  sent_by_agent: { label: "Agent asked", dot: "bg-sky" },
  sent_by_human: { label: "You approved", dot: "bg-warn" },
  reply: { label: "Supplier answered", dot: "bg-good" },
  handover: { label: "Handed to you", dot: "bg-bad" },
  foreign: { label: "Not sent by the agents", dot: "bg-peach" },
};

/** The day at a glance: one lane per kind of event, one dot per event, placed by its time. */
export function ActivityLanes({ items, chosen, onChoose }: { items: Event[]; chosen: Event["kind"] | null; onChoose: (kind: Event["kind"] | null) => void }) {
  const times = items.map((i) => (i.at ? new Date(i.at).getTime() : NaN)).filter((t) => !Number.isNaN(t));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const place = (iso: string | null) => (iso && last > first ? `${2 + (96 * (new Date(iso).getTime() - first)) / (last - first)}%` : "50%");
  return (
    <div>
      <div className="space-y-1.5">
        {(Object.keys(KIND) as Event["kind"][]).map((kind) => {
          const mine = items.filter((i) => i.kind === kind);
          const on = chosen === kind;
          return (
            <button
              key={kind}
              onClick={() => onChoose(on ? null : kind)}
              aria-pressed={on}
              className={`grid w-full items-center gap-3 rounded-lg px-2 py-1 text-left sm:grid-cols-[11rem_1fr] ${on ? "bg-accent-soft" : "hover:bg-accent-soft/60"} ${chosen && !on ? "opacity-45" : ""}`}
            >
              <span className="flex items-center justify-between gap-2 text-sm">
                <span><i className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${KIND[kind].dot}`} />{KIND[kind].label}</span>
                <span className="font-display font-semibold">{mine.length}</span>
              </span>
              <span className="relative block h-6 rounded-md bg-paper ring-1 ring-line">
                {mine.map((e, i) => (
                  <i key={i} title={`${clock(e.at)} · ${e.text}`} className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card ${KIND[kind].dot}`} style={{ left: place(e.at) }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {times.length > 1 && (
        <div className="mt-1 grid gap-3 px-2 sm:grid-cols-[11rem_1fr]">
          <span />
          <span className="flex justify-between text-[11px] text-muted">
            <span>{clock(new Date(first).toISOString())}</span>
            <span>{chosen ? "Showing one kind. Click it again to show all." : "Click a row to show only that kind below."}</span>
            <span>{clock(new Date(last).toISOString())}</span>
          </span>
        </div>
      )}
    </div>
  );
}
