import { useEffect, useState } from "react";
import { fileUrl, getWhatIf, needsCaseAttention, type Case, type Finding, type Forecast, type Overview } from "./api";
import { PackChart } from "./Chart";
import { DockHero } from "./DockHero";
import { dateClock, fileName, forecastTime, money, num, when } from "./format";
import { Button, Card, Chip, DetailCard, StateChip } from "./ui";
import { Levers, LineTimeline } from "./Viz";

const editionName = (name: string | null, id: string) => name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? id;

/** How urgent a case is, told from the forecast: P0 stops a line first, P1 is short, P2 is not short. */
type Urgency = { rank: "P0" | "P1" | "P2"; stop: string | null };
const RANK = { P0: "bg-accent-600 text-white", P1: "bg-warn-soft text-warn-ink ring-1 ring-warn/40", P2: "bg-accent-soft text-ink-2" };

function Rank({ urgency }: { urgency: Urgency }) {
  const meaning = { P0: "First bottleneck", P1: "Part shortage", P2: "No quantity gap" }[urgency.rank];
  return (
    <span title={`${urgency.rank}: ${meaning}`} className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold tracking-wide ${RANK[urgency.rank]}`}>
      {meaning}
    </span>
  );
}

/** Decide by, who signs, cost: the things a decision needs, in one line. */
function Facts({ item, urgency }: { item: Case; urgency: Urgency }) {
  const rec = item.recommended;
  const signer = item.approval?.person ?? item.approval?.required_role;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {urgency.stop && <div className="rounded bg-accent-soft px-1.5 font-semibold text-bad-ink"><dt className="inline">First modeled stall </dt><dd className="inline">{forecastTime(urgency.stop)}</dd></div>}
      {signer && signer !== "No approval required" && <div><dt className="inline text-muted">Proposed approver: </dt><dd className="inline font-semibold text-ink">{signer}</dd></div>}
      {rec?.cost != null && <div><dt className="inline text-muted">Cost </dt><dd className="inline font-semibold text-ink">{money(rec.cost, rec.currency)}</dd></div>}
      {rec && item.saves_alone > 0 && <div><dt className="inline text-muted">If fully fixed </dt><dd className="inline font-semibold text-ink">up to {num(item.saves_alone)} copies</dd></div>}
    </dl>
  );
}

function ActionCard({ item, urgency, onOpen }: { item: Case; urgency: Urgency; onOpen: () => void }) {
  const rec = item.recommended;
  const needsConcession = !!item.concession_target && !item.concession_approval;
  return (
    <Card className="border-l-4 border-l-bad p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted"><Rank urgency={urgency} /> {item.description}</div>
          <h3 className="text-lg font-semibold leading-snug">{item.card?.headline ?? item.description ?? item.material_id}</h3>
        </div>
        {needsConcession ? <Chip tone="warn">Concession sign-offs</Chip> : <StateChip state={item.state} />}
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-ink/90">{item.card?.problem ?? item.summary}</p>
      <div className="mt-3 rounded-lg bg-paper p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">The agent suggests</div>
        <p className="mt-0.5 text-[15px] leading-relaxed">{item.card?.suggestion ?? rec?.title}</p>
        {rec && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.saves_alone > 0 && <Chip tone="good">if fully fixed, up to {num(item.saves_alone)} copies</Chip>}
            {rec.copies_saved > item.saves_alone && <Chip tone="warn">agent estimate exceeds forecast ceiling</Chip>}
            <Chip>{money(rec.cost, rec.currency)}</Chip>
            {rec.arrives_by && <Chip>on the dock {when(rec.arrives_by)}</Chip>}
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="rounded-lg border-l-4 border-accent-600 bg-band px-3 py-2 text-[15px] font-medium text-ink">
          <span className="font-bold text-bad-ink">Your step: </span>
          {needsConcession ? "Record the concession once all required sign-offs are complete."
            : item.needs_human ? "Decide how to proceed. The agent could not take this further." : (item.card?.your_step ?? "Review and approve.")}
        </p>
        <Button onClick={onOpen}>{needsConcession ? "Review concession" : item.state === "needs_human" ? "Review case" : "Review draft"}</Button>
      </div>
    </Card>
  );
}

function QuietRow({ item, urgency, onOpen }: { item: Case; urgency: Urgency; onOpen: () => void }) {
  const last = [...item.messages].reverse().find((m) => item.state === "waiting_for_supplier" ? m.status === "sent" : m.status === "received" && m.sent_by !== "auto");
  const status =
    item.state === "waiting_for_supplier"
      ? `Waiting for ${last?.counterpart_name ?? "the supplier"}${last?.sent_at ? ` · sent ${dateClock(last.sent_at)}` : ""}`
      : item.state === "supplier_answered"
        ? `${last?.counterpart_name ?? "The supplier"} replied${last?.sent_at ? ` · ${dateClock(last.sent_at)}` : ""}`
        : (item.card?.your_step ?? "The agent has a suggestion ready");
  return (
    <button onClick={onOpen} className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left hover:bg-paper">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 font-medium">
          <Rank urgency={urgency} /> {item.card?.headline ?? item.description} <span className="text-xs font-normal text-muted">· {item.description}</span>
        </div>
        <div className="mt-0.5 text-sm text-ink-2">{status}</div>
        <Facts item={item} urgency={urgency} />
      </div>
      <span className="shrink-0 text-sm text-accent-ink">Open ›</span>
    </button>
  );
}

const LEVEL = { stops_line: ["Shortage", "bad"], watch: ["Check", "warn"], info: ["Context", "neutral"] } as const;

/** What the agents found, each with its sources one click away. */
function EvidenceList({ findings }: { findings: Finding[] }) {
  return (
    <div className="divide-y divide-line">
      {findings.map((f) => (
        <details key={f.key} className="py-2.5 first:pt-0 last:pb-0">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-sm">
            <span className="min-w-0">
              <span className={`mr-2 inline-block h-2 w-2 rounded-full ${f.level === "stops_line" ? "bg-bad" : f.level === "watch" ? "bg-warn" : "bg-muted/40"}`} />
              <span className="font-medium">{f.title}</span>
            </span>
            <span className="shrink-0"><Chip tone={LEVEL[f.level][1]}>{LEVEL[f.level][0]}</Chip></span>
          </summary>
          <div className="mt-2 pl-4 text-sm">
            <p className="text-muted">{f.detail}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {f.evidence.map((e) => (
                <a key={e.path} href={fileUrl(e.path)} target="_blank" rel="noreferrer" title={e.path} className="rounded-md border border-line bg-paper px-2 py-1 text-xs text-accent-ink hover:underline">
                  {fileName(e.path)}
                </a>
              ))}
            </div>
          </div>
        </details>
      ))}
      {findings.length === 0 && <p className="text-sm text-muted">Nothing found yet.</p>}
    </div>
  );
}

export function Today({ data, onOpen }: { data: Overview; onOpen: (key: string) => void }) {
  // The fixes ticked under "What if", and the forecast with them.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [simulation, setSimulation] = useState<{ key: string; forecast: Forecast | null } | null>(null);
  const pickedKey = [...picked].sort().join(",");
  useEffect(() => {
    if (!pickedKey) {
      setSimulation(null);
      return;
    }
    let stale = false;
    getWhatIf(pickedKey.split(","))
      .then((result) => !stale && setSimulation({ key: pickedKey, forecast: result.ready ? result : null }))
      .catch(() => !stale && setSimulation({ key: pickedKey, forecast: null }));
    return () => {
      stale = true;
    };
  }, [pickedKey, data.forecast]);
  const current = simulation?.key === pickedKey ? simulation : null;
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const f = data.forecast;
  const short = f.products.filter((p) => p.short > 0);
  const approved = data.cases.flatMap((item) => item.concession_approval ? [{ item, approval: item.concession_approval }] : []);
  approved.sort((a, b) => Date.parse(b.approval.recorded_at) - Date.parse(a.approval.recorded_at));
  const yours = data.cases.filter(needsCaseAttention);
  const theirs = data.cases.filter((c) => !c.concession_approval && !yours.includes(c));
  const stopOf = (id: string) => f.products.filter((p) => p.first_stop?.material_id === id).map((p) => p.first_stop!.at).sort()[0] ?? "z";
  yours.sort((a, b) => stopOf(a.material_id).localeCompare(stopOf(b.material_id)));
  const partName = new Map(f.components.map((c) => [c.material_id, c.description ?? c.material_id]));
  const gaps = new Map(f.components.map((c) => [c.material_id, c.gap]));
  const urgencyOf = (c: Case): Urgency => {
    const stop = f.products.filter((p) => p.short > 0 && p.first_stop?.material_id === c.material_id).map((p) => p.first_stop!.at).sort()[0] ?? null;
    return { rank: stop ? "P0" : (gaps.get(c.material_id) ?? 0) > 0 ? "P1" : "P2", stop };
  };
  const order = { P0: 0, P1: 1, P2: 2 };
  theirs.sort((a, b) => order[urgencyOf(a).rank] - order[urgencyOf(b).rank]);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight sm:text-[32px]">Launch outlook</h1>
        <p className="mt-2 text-[15px] text-muted">
          {data.erp_forecast.will_make_it && short.length > 0
            ? "The stock system shows no shortage. The paperwork tells a different story. "
            : ""}
          Based on the last recorded packing count ({forecastTime(f.as_of)}).
        </p>
      </section>

      <DockHero data={data} picks={current?.forecast ?? null} onOpen={onOpen} />

      <div className="grid items-start gap-6 xl:grid-cols-[1.7fr_1fr]">
        <div className="space-y-6">
          <section>
            <h2 className="font-display text-lg font-semibold">Approvals and escalations{yours.length ? ` (${yours.length})` : ""}</h2>
            <div className="mt-3 space-y-4">
              {yours.map((c) => (
                <ActionCard key={c.key} item={c} urgency={urgencyOf(c)} onOpen={() => onOpen(c.key)} />
              ))}
              {yours.length === 0 && (
                <Card className="p-5 text-sm text-muted">
                  No approvals or escalations waiting for you.
                </Card>
              )}
            </div>
          </section>

          {approved.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">Recorded concession approvals ({approved.length})</h2>
              <Card className="mt-3 divide-y divide-line overflow-hidden">
                {approved.map(({ item, approval }) => (
                  <button key={item.key} onClick={() => onOpen(item.key)}
                    className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper">
                    <span className="min-w-0">
                      <span className="block font-medium">{item.description ?? item.material_id}: {num(approval.quantity)} pieces</span>
                      <span className="block text-sm text-muted">Recorded by {approval.recorded_by} · {dateClock(approval.recorded_at)} Hamburg time</span>
                    </span>
                    <span className="shrink-0 text-sm text-accent-ink">View case</span>
                  </button>
                ))}
              </Card>
              <p className="mt-2 text-xs text-muted">These sign-offs do not confirm warehouse release.</p>
            </section>
          )}

          {theirs.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">Other open cases</h2>
              <Card className="mt-3 divide-y divide-line overflow-hidden">
                {theirs.map((c) => (
                  <QuietRow key={c.key} item={c} urgency={urgencyOf(c)} onOpen={() => onOpen(c.key)} />
                ))}
              </Card>
            </section>
          )}
        </div>

        <div className="space-y-6">
          {data.cases.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">What if we fix these shortages?</h2>
              <Card className="mt-3 p-4">
                <Levers cases={data.cases} plan={data.plan} picked={picked} onToggle={toggle} onClear={() => setPicked(new Set())} result={current?.forecast ?? null} loading={!current} />
              </Card>
            </section>
          )}
        </div>
      </div>

      <DetailCard title={`Findings and source files (${data.findings.length})`}>
        <EvidenceList findings={data.findings} />
      </DetailCard>
      <DetailCard title="Evidence view: packing timeline and charts">
        <p className="mb-4 text-sm text-muted">Based on the paperwork. Past stalls shown here are modeled, not observed.</p>
        <LineTimeline forecast={f} now={data.now} partName={partName} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {f.products.map((p) => (
            <Card key={p.product_id} className="p-5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-semibold">{editionName(p.name, p.product_id)}</div>
                <div className={`text-sm font-semibold ${p.short > 0 ? "text-bad-ink" : "text-good-ink"}`}>
                  {p.short > 0 ? `${num(p.short)} copies short` : `done ${when(p.finished_at)}`}
                </div>
              </div>
              <div className="mt-0.5 text-sm text-muted">
                {num(p.packed)} of {num(p.day_one_demand)} packed · {num(p.to_pack)} to go
              </div>
              <div className="mt-3">
                <PackChart productId={p.product_id} evidence={f} erp={data.erp_forecast} />
              </div>
              {p.first_stop && p.short > 0 && (
                <p className="mt-3 rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white">
                  First modeled stall: {forecastTime(p.first_stop.at)}, when {partName.get(p.first_stop.material_id) ?? p.first_stop.material_id} runs out.
                </p>
              )}
            </Card>
          ))}
        </div>
      </DetailCard>
    </div>
  );
}
