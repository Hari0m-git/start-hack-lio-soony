import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ComponentForecast, Overview } from "./api";
import { canWebGL, Quiet } from "./DockHero";
import { AgentLoop } from "./Extras";
import { dateClock, fileName, forecastTime, num } from "./format";
import type { ShelfPart } from "./PartsScene";
import { Button, Card, Chip, DetailCard, Label } from "./ui";
import { ActivityLanes, Donut, Gauge, KIND, Ring } from "./Viz";

// The 3D shelf is fetched only when the Parts page is opened.
const PartsScene = lazy(() => import("./PartsScene"));

function Coverage({ c }: { c: ComponentForecast }) {
  const scale = Math.max(c.need, c.usable_stock + c.inbound_counted) || 1;
  const pct = (n: number) => `${(100 * n) / scale}%`;
  const have = Math.min(c.usable_stock + c.inbound_counted, scale);
  return (
    <div className="relative my-1.5 h-5 w-full">
      <div className="absolute inset-0 overflow-hidden rounded-md bg-line">
        <div className="absolute inset-y-0 left-0 bg-good" style={{ width: pct(Math.min(c.usable_stock, scale)) }} />
        <div className="absolute inset-y-0 bg-coral" style={{ left: pct(c.usable_stock), width: pct(c.inbound_counted) }} />
        {c.gap > 0 && <div className="hatch absolute inset-y-0" style={{ left: pct(have), width: pct(c.need - have) }} />}
      </div>
      {/* The mark for what is needed stands taller than the bar, so it shows on any colour. */}
      <div
        className="absolute -inset-y-1.5 w-1 rounded-full bg-accent-600 ring-2 ring-card"
        style={{ left: `calc(${pct(c.need)} - 2px)` }}
        title={`Needed: ${num(c.need)}`}
      />
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
  const partHeading = useRef<HTMLHeadingElement>(null);
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
          Select a part to see what’s available and what’s missing. Shortages come first. Last packing count: {forecastTime(data.forecast.as_of)}.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card className="overflow-hidden">
          <div className="dusk flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
            <Label>Parts shelf · height compared with what’s needed</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-good" />on site</span>
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-coral" />on its way</span>
              <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-bad/45 ring-1 ring-bad/50" />missing</span>
              <span><i className="mr-1.5 inline-block h-1 w-3 rounded-sm bg-accent-600 align-middle" />needed</span>
              {three && <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-ink" />stock system</span>}
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
          {!three && (
            // Without 3D (reduced motion, or no WebGL) the same columns are drawn flat.
            <div className="grid h-[230px] items-end gap-2 px-3 pt-4 sm:h-[300px]" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
              {shelf.map((part) => {
                const h = (share: number) => `${(100 * Math.max(0, Math.min(share, 1.5))) / 1.5}%`;
                const missing = Math.max(0, 1 - part.onSite - part.onItsWay);
                return (
                  <button
                    key={part.id}
                    onClick={() => setChosen(part.id)}
                  aria-label={`Show ${rows.find((c) => c.material_id === part.id)?.description ?? part.id}`}
                  aria-pressed={pick?.material_id === part.id}
                    className={`relative flex h-full flex-col-reverse overflow-hidden rounded-t-md ${pick?.material_id === part.id ? "bg-accent-soft" : "bg-band"}`}
                  >
                    <span className="block w-full bg-good" style={{ height: h(part.onSite) }} />
                    <span className="block w-full bg-coral" style={{ height: h(Math.min(part.onItsWay, 1.5 - Math.min(part.onSite, 1.5))) }} />
                    <span className="hatch block w-full" style={{ height: h(missing) }} />
                    <span className="absolute inset-x-0 h-1 bg-accent-600" style={{ bottom: h(1) }} />
                  </button>
                );
              })}
            </div>
          )}
          <div className="grid border-t border-line" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
            {rows.map((c, i) => (
              <button
                key={c.material_id}
                onClick={() => setChosen(c.material_id)}
                aria-pressed={pick?.material_id === c.material_id}
                aria-label={`Select ${c.description ?? c.material_id}`}
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
                <h2 ref={partHeading} tabIndex={-1} className="scroll-mt-36 font-display text-xl font-semibold leading-snug">{pick.description ?? pick.material_id}</h2>
                <div className="text-xs text-muted">{pick.material_id}</div>
              </div>
              {pick.need > 0 && (
                <div className="shrink-0 text-center">
                  <Ring share={(pick.usable_stock + pick.inbound_counted) / pick.need} tone={pick.gap > 0 ? "bad" : "good"} size={64}>
                    {Math.min(100, Math.round((100 * (pick.usable_stock + pick.inbound_counted)) / pick.need))}%
                  </Ring>
                  <span className="text-xs text-muted">covered</span>
                </div>
              )}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              <Figure label="Still needed" value={num(pick.need)} />
              <Figure label="On site and usable" value={num(pick.usable_stock)} />
              <Figure label="Expected by deadline" value={num(pick.inbound_counted)} />
              <Figure label="Missing" value={num(pick.gap)} tone={pick.gap > 0 ? "text-bad-ink" : "text-ink"} />
            </div>
            {pick.usable_stock + pick.inbound_counted > pick.need && (
              <p className="mt-3 text-sm text-muted">
                {num(pick.usable_stock + pick.inbound_counted - pick.need)} pieces more than this launch needs.
              </p>
            )}
            {wrongOf(pick) && (
              <p className="mt-4 rounded-lg border-l-4 border-accent-600 bg-accent-soft px-3 py-2 text-sm font-semibold text-ink">
                The system shows {num(pick.erp_stock)} in stock. The paperwork supports {num(pick.usable_stock)}.
              </p>
            )}
            {pick.inbound_needing_action > 0 && (
              <p className="mt-2 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink-2">
                {num(pick.inbound_needing_action)} pieces in shipments requiring action, not yet counted.
                {pick.gap > 0 && ` Only ${num(pick.gap)} more pieces are needed for this launch.`}
              </p>
            )}
            <div className="mt-auto pt-4">
              {cases.has(pick.material_id) ? (
                <Button onClick={() => onOpen(`part:${pick.material_id}`)}>Open the case</Button>
              ) : (
                <span className="text-sm text-muted">{pick.gap > 0 ? "No case has been opened for this shortage yet." : "No open case for this part."}</span>
              )}
            </div>
          </Card>
        )}
      </div>

      <Card className="divide-y divide-line">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3 text-xs font-medium text-ink-2">
          <span className="font-semibold uppercase tracking-[0.08em] text-muted">How to read the bars</span>
          <span><i className="mr-1.5 inline-block h-3 w-5 rounded-sm bg-good align-middle" />on site and usable</span>
          <span><i className="mr-1.5 inline-block h-3 w-5 rounded-sm bg-coral align-middle" />on its way</span>
          <span><i className="hatch mr-1.5 inline-block h-3 w-5 rounded-sm align-middle" />missing</span>
          <span><i className="mr-1.5 inline-block h-4 w-1 rounded-full bg-accent-600 align-middle" />what is needed</span>
        </div>
        {rows.map((c, i) => {
          const wrong = wrongOf(c);
          return (
            <div
              key={c.material_id}
              className={`grid items-center gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_11rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_13rem] ${pick?.material_id === c.material_id ? "bg-accent-soft/50" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-semibold ring-1 ring-line">{i + 1}</span>
                <div className="min-w-0">
                  <button
                    className="text-left font-medium text-accent-ink underline-offset-2 hover:underline"
                    onClick={() => {
                      setChosen(c.material_id);
                      requestAnimationFrame(() => {
                        partHeading.current?.focus({ preventScroll: true });
                        partHeading.current?.scrollIntoView({ block: "start" });
                      });
                    }}
                  >
                    {c.description ?? c.material_id}
                  </button>
                  <div className="text-xs text-muted">{c.material_id}</div>
                </div>
              </div>
              <div>
                <Coverage c={c} />
                <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs text-muted">
                  <span>needed {num(c.need)}</span>
                  <span>on site {num(c.usable_stock)}</span>
                  {c.inbound_counted > 0 && <span>on its way {num(c.inbound_counted)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                {c.gap > 0 ? <Chip tone="bad">{num(c.gap)} missing</Chip> : wrong ? <Chip tone="warn">Stock differs</Chip> : <Chip tone="good">Covered</Chip>}
                {cases.has(c.material_id) && (
                  <button className="shrink-0 text-sm font-medium text-accent-ink hover:underline" aria-label={`Open case for ${c.description ?? c.material_id}`} onClick={() => onOpen(`part:${c.material_id}`)}>
                    Case ›
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      {quiet.length > 0 && (
        <DetailCard title={`Other findings (${quiet.length})`}>
          <ul className="mt-3 grid gap-x-8 gap-y-3 text-sm lg:grid-cols-2">
            {quiet.map((f) => (
              <li key={f.key}>
                <div className="font-medium">{f.title}</div>
                <div className="text-muted">{f.detail}</div>
              </li>
            ))}
          </ul>
        </DetailCard>
      )}
      <p className="text-xs text-muted">How this is counted: {data.forecast.assumptions.join(" ")} On-its-way quantities are forecast, not stock already at the site.</p>
    </div>
  );
}

type Kind = Overview["activity"][number]["kind"];

export function Activity({ data, onOpen }: { data: Overview; onOpen: (key: string) => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const shown = data.activity.filter((a) => !kind || a.kind === kind);
  const caseKeys = new Set(data.cases.map((c) => c.key));
  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold tracking-tight">What happened</h1>
        <p className="mt-1 text-[15px] text-muted">Recent files, supplier mail and handovers. Times include the date in Hamburg time; older events may not appear here.</p>
      </section>

      <Card className="p-5">
        <Label>Filter by event type</Label>
        <div className="mt-3">
          <ActivityLanes items={data.activity} chosen={kind} onChoose={setKind} />
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{kind ? `${KIND[kind].label} · ${shown.length} recent events` : `${shown.length} recent events, newest first`}</Label>
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
                <span>{dateClock(a.at)}</span>
                <span>· {KIND[a.kind].label}</span>
              </div>
              <div className="text-[15px]">
                {a.text}
                {a.case_key && caseKeys.has(a.case_key) && (
                  <button className="ml-2 text-sm font-medium text-accent-ink hover:underline" onClick={() => onOpen(a.case_key!)}>
                    View case ›
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
  const reviewFindings = data.findings.filter((f) => f.level !== "info");
  const stoppingFindings = reviewFindings.filter((f) => f.level === "stops_line").length;
  const rules: [string, string][] = [
    ["Routine supplier questions", "If automatic inquiries are enabled, agents may ask for information without committing to a purchase or a change."],
    ["Wait for a person", "Anything that places, releases or changes an order, or accepts a price or a condition. That is one click for the person Soony's approval policy names."],
    ["Hand over", "A case with no route left, or one the agent failed to work twice. It stops there and tells you why."],
    ["When work pauses", "Automatic follow-ups stop after unanswered messages reach the case limit. Model work pauses when the daily budget is used up."],
  ];
  const spendByKind = data.spend.by_kind.filter((k) => k.calls > 0 || k.usd > 0);
  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold tracking-tight">The agents</h1>
        <p className="mt-1 text-[15px] text-muted">
          {data.loop.running ? "A check is in progress." : data.loop.agents_on ? "Automatic checks are on." : "Automatic checks are off. This desk shows saved data."}
          {data.last_sync && ` Last portal check: ${dateClock(data.last_sync.started_at)}.`}
        </p>
        {!!data.loop.last_tick?.errors?.length && <p className="mt-2 text-sm text-bad-ink">The last check reported problems. See “How the agents work” for details.</p>}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Files in the desk", num(data.files), `${num(data.documents_read)} documents read; spreadsheets may be processed separately`],
            ["Findings to review", String(reviewFindings.length), `${stoppingFindings} linked to shortages`],
            ["Messages sent via Foredock", String(sent), `${data.agent_work.sent_by_agents} automatic, ${data.agent_work.approved_by_people} other desk sends · all time`],
            ["Supplier replies", String(data.agent_work.replies), "Excludes automatic replies · all time"],
          ]
        ).map(([label, value, hint]) => (
          <Card key={label} className="p-5">
            <div className="min-w-0">
              <Label>{label}</Label>
              <div className="mt-1 font-display text-[40px] font-semibold leading-none tracking-tight">{value}</div>
              <div className="mt-1 text-xs text-muted">{hint}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <Label>Daily AI spending</Label>
        <div className="mt-2 flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <p className="font-display text-2xl font-semibold">${data.spend.today_usd.toFixed(2)} of ${data.spend.budget_usd.toFixed(2)}</p>
            <p className="text-sm text-muted">Model usage since midnight UTC. This is not supplier spending.</p>
          </div>
          <div className="w-36">
            <Gauge used={data.spend.today_usd} limit={data.spend.budget_usd} label="of the budget used" />
          </div>
        </div>
      </Card>
      <DetailCard title="AI spending breakdown">
          {spendByKind.length > 0 ? (
            <Donut
              centre={`$${data.spend.today_usd.toFixed(2)}`}
              caption="UTC day"
              slices={spendByKind.map((k) => ({ label: k.kind, value: k.usd, note: `$${k.usd.toFixed(2)} · ${k.calls} calls` }))}
            />
          ) : <p className="text-sm text-muted">No model calls recorded for the current UTC day.</p>}
      </DetailCard>
      <DetailCard title="How the agents work">
          <AgentLoop data={data} />
          {data.mail_address && <p className="mt-3 text-sm text-muted">Mailbox: {data.mail_address}</p>}
          {!!data.loop.last_tick?.errors?.length && <p className="mt-3 text-sm text-bad-ink">Last check: {data.loop.last_tick.errors.join("; ")}</p>}
          <dl className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
            {rules.map(([title, text]) => (
              <div key={title}>
                <dt className="font-medium">{title}</dt>
                <dd className="text-muted">{text}</dd>
              </div>
            ))}
          </dl>
      </DetailCard>
      <DetailCard title={`Audit log (${data.audit.length} recent entries)`}>
          <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {data.audit.map((a, i) => (
              <li key={i}>
                <span className="text-muted">{dateClock(a.ts)}</span> <span className="font-medium">{a.actor}</span> {a.action}
                {a.detail && <span className="break-all text-muted"> · {a.detail}</span>}
              </li>
            ))}
            {data.audit.length === 0 && <li className="text-muted">Nothing recorded yet. Approvals, refusals, automatic sends and handovers appear here.</li>}
          </ul>
      </DetailCard>
        {data.needs_review.length > 0 && (
          <DetailCard title={`Files that need a closer look (${data.needs_review.length})`}>
            <ul className="space-y-1 text-sm text-muted">
              {data.needs_review.map((r) => (
                <li key={r.path}>
                  {fileName(r.path)}: {r.detail}
                </li>
              ))}
            </ul>
          </DetailCard>
        )}
    </div>
  );
}
