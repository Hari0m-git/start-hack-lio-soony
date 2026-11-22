import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ComponentForecast, Overview } from "./api";
import { canWebGL, Quiet } from "./DockHero";
import { AgentLoop } from "./Extras";
import { clock, fileName, num } from "./format";
import type { ShelfPart } from "./PartsScene";
import { Button, Card, Chip, Label } from "./ui";
import { ActivityLanes, Donut, Gauge, KIND, Ring } from "./Viz";

// The 3D shelf is fetched only when the Parts page is opened.
const PartsScene = lazy(() => import("./PartsScene"));

function Coverage({ c }: { c: ComponentForecast }) {
  const scale = Math.max(c.need, c.usable_stock + c.inbound_counted) || 1;
  const pct = (n: number) => `${(100 * n) / scale}%`;
  return (
    <div className="relative h-3 w-full overflow-hidden rounded-full bg-bad-soft">
      <div className="absolute inset-y-0 left-0 bg-good" style={{ width: pct(Math.min(c.usable_stock, scale)) }} />
      <div className="absolute inset-y-0 bg-coral" style={{ left: pct(c.usable_stock), width: pct(c.inbound_counted) }} />
      <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `calc(${pct(c.need)} - 1px)` }} title={`Needed: ${num(c.need)}`} />
    </div>
  );
}

/** True while the element is on screen in a visible tab, so a scene can rest otherwise. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(true);
  useEffect(() => {
    const el = ref.current;
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
  }, []);
  return { ref, active };
}

function Figure({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`font-display text-2xl font-semibold leading-tight ${tone}`}>{value}</div>
    </div>
  );
}

export function Parts({ data, onOpen }: { data: Overview; onOpen: (key: string) => void }) {
  const cases = new Set(data.cases.map((c) => c.material_id));
  const rows = [...data.forecast.components].sort((a, b) => b.gap - a.gap || Number(b.erp_stock !== b.usable_stock) - Number(a.erp_stock !== a.usable_stock));
  const quiet = data.findings.filter((f) => f.level !== "stops_line");
  const [three] = useState(() => canWebGL() && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [chosen, setChosen] = useState<string | null>(rows[0]?.material_id ?? null);
  const { ref, active } = useOnScreen<HTMLDivElement>();
  const shelf: ShelfPart[] = rows.map((c) => {
    const need = c.need || 1;
    return { id: c.material_id, onSite: c.usable_stock / need, onItsWay: c.inbound_counted / need, system: c.erp_stock / need, short: c.gap > 0 };
  });
  const pick = rows.find((c) => c.material_id === chosen) ?? rows[0];
  const wrongOf = (c: ComponentForecast) => Math.round(c.erp_stock) !== Math.round(c.usable_stock);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Parts for the copies still to pack</h1>
        <p className="mt-1 text-[15px] text-muted">
          Every part against what is still needed. Click a column or a row to see its figures; parts that stop a line come first.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card className="overflow-hidden">
          <div className="dusk flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
            <Label>The shelf · each column is one part, as a share of what is needed</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-good" />on site</span>
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-coral" />on its way</span>
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-bad/45 ring-1 ring-bad/50" />missing</span>
              <span><i className="mr-1.5 inline-block h-0.5 w-3 bg-ink align-middle" />needed</span>
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-ink" />what the system believes</span>
            </div>
          </div>
          {three && (
            <div ref={ref} className="h-[230px] min-w-0 overflow-hidden sm:h-[300px] xl:h-[340px]">
              <Quiet>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted">Stacking the shelf…</div>}>
                  <PartsScene parts={shelf} chosen={pick?.material_id ?? null} onChoose={setChosen} active={active} />
                </Suspense>
              </Quiet>
            </div>
          )}
          <div className="grid border-t border-line" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
            {rows.map((c, i) => (
              <button
                key={c.material_id}
                onClick={() => setChosen(c.material_id)}
                aria-pressed={pick?.material_id === c.material_id}
                title={c.description ?? c.material_id}
                className={`flex min-w-0 flex-col items-center gap-0.5 px-1 py-2 text-center text-[11px] leading-tight ${pick?.material_id === c.material_id ? "bg-accent-soft" : "hover:bg-accent-soft/60"}`}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${c.gap > 0 ? "bg-bad-soft text-bad-ink" : wrongOf(c) ? "bg-warn-soft text-warn-ink" : "bg-good-soft text-good-ink"}`}>
                  {i + 1}
                </span>
                <span className="hidden w-full truncate md:block">{c.description?.replace(/ (Grand Heist|–).*/, "")}</span>
              </button>
            ))}
          </div>
        </Card>

        {pick && (
          <Card className="flex flex-col p-5">
            <Label>Part {rows.indexOf(pick) + 1} of {rows.length}</Label>
            <div className="mt-1 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-xl font-semibold leading-snug">{pick.description}</h2>
                <div className="text-xs text-muted">{pick.material_id}</div>
              </div>
              <Ring share={(pick.usable_stock + pick.inbound_counted) / (pick.need || 1)} tone={pick.gap > 0 ? "bad" : "good"} size={64}>
                {Math.min(999, Math.round((100 * (pick.usable_stock + pick.inbound_counted)) / (pick.need || 1)))}%
              </Ring>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              <Figure label="Still needed" value={num(pick.need)} />
              <Figure label="On site and usable" value={num(pick.usable_stock)} />
              <Figure label="On its way, counted" value={num(pick.inbound_counted)} />
              <Figure label="Missing" value={num(pick.gap)} tone={pick.gap > 0 ? "text-bad-ink" : "text-good-ink"} />
            </div>
            {wrongOf(pick) && (
              <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-ink">
                The system shows {num(pick.erp_stock)} in stock. The paperwork supports {num(pick.usable_stock)}.
              </p>
            )}
            {pick.inbound_needing_action > 0 && (
              <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink-2">{num(pick.inbound_needing_action)} more would arrive if someone acts.</p>
            )}
            <div className="mt-auto pt-4">
              {cases.has(pick.material_id) ? (
                <Button onClick={() => onOpen(`part:${pick.material_id}`)}>Open the case</Button>
              ) : (
                <span className="text-sm text-muted">No case: this part does not put the launch at risk.</span>
              )}
            </div>
          </Card>
        )}
      </div>

      <Card className="divide-y divide-line">
        {rows.map((c, i) => {
          const wrong = wrongOf(c);
          return (
            <div
              key={c.material_id}
              onClick={() => setChosen(c.material_id)}
              className={`grid cursor-pointer items-center gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_auto] ${pick?.material_id === c.material_id ? "bg-accent-soft/50" : "hover:bg-accent-soft/30"}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-semibold ring-1 ring-line">{i + 1}</span>
                <div className="min-w-0">
                  <div className="font-medium">{c.description}</div>
                  <div className="text-xs text-muted">{c.material_id}</div>
                </div>
              </div>
              <div>
                <Coverage c={c} />
                <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs text-muted">
                  <span>needed {num(c.need)}</span>
                  <span>on site {num(c.usable_stock)}</span>
                  {c.inbound_counted > 0 && <span>on its way {num(c.inbound_counted)}</span>}
                  {wrong && <span className="text-bad-ink">the system shows {num(c.erp_stock)}</span>}
                  {c.inbound_needing_action > 0 && <span className="text-warn-ink">{num(c.inbound_needing_action)} more if someone acts</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                {c.gap > 0 ? <Chip tone="bad">{num(c.gap)} missing</Chip> : wrong ? <Chip tone="warn">enough, but the system is wrong</Chip> : <Chip tone="good">enough</Chip>}
                {cases.has(c.material_id) && (
                  <button className="text-sm font-medium text-accent-ink hover:underline" onClick={(e) => (e.stopPropagation(), onOpen(`part:${c.material_id}`))}>
                    Open ›
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      {quiet.length > 0 && (
        <Card className="p-5">
          <Label>Also noticed · not stopping a line</Label>
          <ul className="mt-3 grid gap-x-8 gap-y-3 text-sm lg:grid-cols-2">
            {quiet.map((f) => (
              <li key={f.key}>
                <div className="font-medium">{f.title}</div>
                <div className="text-muted">{f.detail}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-muted">How this is counted: {data.forecast.assumptions.join(" ")}</p>
    </div>
  );
}

type Kind = Overview["activity"][number]["kind"];

export function Activity({ data, onOpen }: { data: Overview; onOpen: (key: string) => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const shown = data.activity.filter((a) => !kind || a.kind === kind);
  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold tracking-tight">What happened</h1>
        <p className="mt-1 text-[15px] text-muted">Everything the agents noticed and did. Times are Hamburg time.</p>
      </section>

      <Card className="p-5">
        <Label>The day at a glance · one dot per event</Label>
        <div className="mt-3">
          <ActivityLanes items={data.activity} chosen={kind} onChoose={setKind} />
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{kind ? `${KIND[kind].label} · ${shown.length} events, newest first` : `All ${shown.length} events, newest first`}</Label>
          {kind && (
            <button className="text-sm font-medium text-accent-ink hover:underline" onClick={() => setKind(null)}>
              Show all
            </button>
          )}
        </div>
        <ol className="relative mt-4 space-y-5 border-l border-line pl-6">
          {shown.map((a, i) => (
            <li key={i} className="relative">
              <span className={`absolute -left-[29px] top-1.5 h-2.5 w-2.5 rounded-full ${KIND[a.kind].dot}`} />
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                <span>{clock(a.at)}</span>
                <span>· {KIND[a.kind].label}</span>
              </div>
              <div className="text-[15px]">
                {a.text}
                {a.case_key && (
                  <button className="ml-2 text-sm font-medium text-accent-ink hover:underline" onClick={() => onOpen(a.case_key!)}>
                    Open ›
                  </button>
                )}
              </div>
              {a.detail && <div className="text-sm text-muted">{a.detail}</div>}
            </li>
          ))}
          {shown.length === 0 && <li className="text-sm text-muted">Nothing yet.</li>}
        </ol>
      </Card>
    </div>
  );
}

export function Agents({ data }: { data: Overview }) {
  const sent = data.agent_work.sent_by_agents + data.agent_work.approved_by_people;
  const rules: [string, string][] = [
    ["Send on their own", "Questions, reminders and requests for confirmation. Each one is checked twice before it leaves and goes only to a supplier contact from Soony's own data."],
    ["Wait for a person", "Anything that places, releases or changes an order, or accepts a price or a condition. That is one click for the person Soony's approval policy names."],
    ["Hand over", "A case with no route left, or one the agent failed to work twice. It stops there and tells you why."],
    ["Stop by themselves", `After three unattended messages to one contact, and when the day's budget of $${String(data.spend.budget_usd)} is used up.`],
  ];
  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold tracking-tight">The agents</h1>
        <p className="mt-1 text-[15px] text-muted">What they have done today, what it cost, and what they are allowed to do without you.</p>
      </section>

      <Card className="p-5">
        <Label>One pass, step by step</Label>
        <div className="mt-4">
          <AgentLoop data={data} />
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Files watched", num(data.files), `${num(data.documents_read)} documents read`, data.files ? data.documents_read / data.files : 0, "read"],
            ["Problems found", String(data.agent_work.findings), "that the system did not show", data.findings.length ? data.agent_work.findings / data.findings.length : 0, "need action"],
            ["Messages sent", String(sent), `${data.agent_work.sent_by_agents} by agents, ${data.agent_work.approved_by_people} approved by a person`, sent ? data.agent_work.sent_by_agents / sent : 0, "by agents"],
            ["Replies read", String(data.agent_work.replies), "supplier answers turned into facts", null, ""],
          ] as [string, string, string, number | null, string][]
        ).map(([label, value, hint, share, what]) => (
          <Card key={label} tilt className="flex items-center justify-between gap-3 p-5">
            <div className="min-w-0">
              <Label>{label}</Label>
              <div className="mt-1 font-display text-[40px] font-semibold leading-none tracking-tight">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
            {share != null && (
              <div className="text-center">
                <Ring share={share}>{Math.round(share * 100)}%</Ring>
                <div className="mt-1 text-[11px] text-muted">{what}</div>
              </div>
            )}
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="p-5">
          <Label>Where the money went today</Label>
          <div className="mt-4">
            <Donut
              centre={`$${data.spend.today_usd.toFixed(2)}`}
              caption="today"
              slices={data.spend.by_kind.map((k) => ({ label: k.kind, value: k.usd, note: `$${k.usd.toFixed(2)} · ${k.calls} calls` }))}
            />
          </div>
        </Card>
        <Card className="flex flex-col p-5">
          <Label>Daily limit</Label>
          <div className="my-auto py-3">
            <Gauge used={data.spend.today_usd} limit={data.spend.budget_usd} label={`$${data.spend.today_usd.toFixed(2)} of $${String(data.spend.budget_usd)}`} />
          </div>
          <p className="text-xs text-muted">At the limit the agents pause themselves until the next day.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <Label>What they may and may not do</Label>
          <dl className="mt-3 space-y-3 text-sm">
            {rules.map(([title, text]) => (
              <div key={title}>
                <dt className="font-medium">{title}</dt>
                <dd className="text-muted">{text}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-5">
          <Label>Record of who did what</Label>
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
            {data.audit.map((a, i) => (
              <li key={i}>
                <span className="text-muted">{clock(a.ts)}</span> <span className="font-medium">{a.actor}</span> {a.action}
                {a.detail && <span className="break-all text-muted"> · {a.detail}</span>}
              </li>
            ))}
            {data.audit.length === 0 && <li className="text-muted">Nothing recorded yet. Approvals, refusals, automatic sends and handovers appear here.</li>}
          </ul>
        </Card>
      </div>

      <Card className="p-5 text-sm">
        <Label>Status</Label>
        <p className="mt-2">
          {data.loop.agents_on ? (data.loop.running ? "The agents are working right now." : "The agents are on and check the portal and the mailbox every two minutes.") : "The agents are switched off on this copy of the desk; it only shows what is stored."}
          {data.last_sync && ` Last check of the portal: ${clock(data.last_sync.started_at)}.`}
          {data.mail_address && ` Mailbox: ${data.mail_address}.`}
        </p>
        {data.loop.last_tick?.errors?.length ? <p className="mt-2 text-bad-ink">Last pass reported: {data.loop.last_tick.errors.join("; ")}</p> : null}
        {data.needs_review.length > 0 && (
          <div className="mt-3">
            <div className="font-medium">Documents the agents were not sure they read correctly</div>
            <ul className="mt-1 text-muted">
              {data.needs_review.map((r) => (
                <li key={r.path}>
                  {fileName(r.path)}: {r.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
