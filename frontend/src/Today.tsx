import { useEffect, useState } from "react";
import { fileUrl, getWhatIf, type Case, type Finding, type Forecast, type Overview } from "./api";
import { PackChart } from "./Chart";
import { DockHero } from "./DockHero";
import { clock, fileName, money, num, when } from "./format";
import { Button, Card, Chip, Label, StateChip } from "./ui";
import { Levers, LineTimeline, Ring } from "./Viz";

const HELP_KEY = "foredock.help.dismissed";
const editionName = (name: string | null, id: string) => name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? id;

function Kpi({ label, value, hint, tone = "text-ink", share, ring, what }: {
  label: string; value: string; hint: string; tone?: string; share: number; ring: "accent" | "good" | "warn" | "bad"; what: string;
}) {
  return (
    <Card tilt className="flex items-center justify-between gap-4 p-5">
      <div className="min-w-0">
        <Label>{label}</Label>
        <div className={`mt-1 font-display text-[44px] font-semibold leading-none tracking-tight ${tone}`}>{value}</div>
        <div className="mt-1 text-xs text-muted">{hint}</div>
      </div>
      <div className="w-20 shrink-0 text-center">
        <div className="flex justify-center">
          <Ring share={share} tone={ring} size={64}>{Math.round(share * 100)}%</Ring>
        </div>
        <div className="mt-1 text-[11px] leading-tight text-muted">{what}</div>
      </div>
    </Card>
  );
}

function HowTo() {
  const [hidden, setHidden] = useState(() => localStorage.getItem(HELP_KEY) === "1");
  if (hidden)
    return (
      <button className="text-xs text-accent-ink hover:underline" onClick={() => (localStorage.removeItem(HELP_KEY), setHidden(false))}>
        How do I read this page?
      </button>
    );
  const steps = [
    ["1", "Read the headline", "It says in one sentence whether every copy will be packed before the trucks leave."],
    ["2", "Decide the red cards", "Each one is a problem that needs you. Open it, read the suggestion, then approve or change it."],
    ["3", "Leave the rest to the agents", "They read new files, ask suppliers and read the answers. The Activity tab shows what they did."],
  ];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Label>New here? Three things to know</Label>
        <button className="text-xs text-muted hover:text-ink" onClick={() => (localStorage.setItem(HELP_KEY, "1"), setHidden(true))}>
          Got it, hide this
        </button>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {steps.map(([n, title, text]) => (
          <div key={n} className="flex gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-600 text-sm font-semibold text-white">{n}</div>
            <div>
              <div className="text-sm font-medium">{title}</div>
              <div className="text-sm text-muted">{text}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** How urgent a case is, told from the forecast: P0 stops a line first, P1 is short, P2 is not short. */
type Urgency = { rank: "P0" | "P1" | "P2"; stop: string | null };
const RANK = { P0: "bg-accent-600 text-white", P1: "bg-warn-soft text-warn-ink ring-1 ring-warn/40", P2: "bg-accent-soft text-ink-2" };

function Rank({ urgency }: { urgency: Urgency }) {
  const meaning = { P0: "stops a line first", P1: "short, but another part stops the line first", P2: "not short" }[urgency.rank];
  return (
    <span title={`${urgency.rank}: ${meaning}`} className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold tracking-wide ${RANK[urgency.rank]}`}>
      {urgency.rank}
    </span>
  );
}

/** Decide by, who signs, cost: the things a decision needs, in one line. */
function Facts({ item, urgency }: { item: Case; urgency: Urgency }) {
  const rec = item.recommended;
  const signer = item.approval?.person ?? item.approval?.required_role;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {urgency.stop && <div className="rounded bg-accent-soft px-1.5 font-semibold text-bad-ink"><dt className="inline">Line stops </dt><dd className="inline">{when(urgency.stop)}</dd></div>}
      {signer && <div className="min-w-0 max-w-full truncate"><dt className="inline text-muted">Who signs </dt><dd className="inline font-semibold text-ink">{signer}</dd></div>}
      {rec && <div><dt className="inline text-muted">Cost </dt><dd className="inline font-semibold text-ink">{money(rec.cost, rec.currency)}</dd></div>}
      {rec && rec.copies_saved > 0 && <div><dt className="inline text-muted">Saves </dt><dd className="inline font-semibold text-ink">{num(rec.copies_saved)} copies</dd></div>}
    </dl>
  );
}

function ActionCard({ item, urgency, onOpen }: { item: Case; urgency: Urgency; onOpen: () => void }) {
  const rec = item.recommended;
  return (
    <Card className="border-l-4 border-l-bad p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted"><Rank urgency={urgency} /> {item.description}</div>
          <h3 className="text-lg font-semibold leading-snug">{item.card?.headline ?? item.description ?? item.material_id}</h3>
        </div>
        <StateChip state={item.state} />
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-ink/90">{item.card?.problem ?? item.summary}</p>
      <div className="mt-3 rounded-lg bg-paper p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">The agent suggests</div>
        <p className="mt-0.5 text-[15px] leading-relaxed">{item.card?.suggestion ?? rec?.title}</p>
        {rec && rec.copies_saved > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip tone="good">saves {num(rec.copies_saved)} copies</Chip>
            <Chip>{money(rec.cost, rec.currency)}</Chip>
            {rec.arrives_by && <Chip>on the dock {when(rec.arrives_by)}</Chip>}
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="rounded-lg border-l-4 border-accent-600 bg-band px-3 py-2 text-[15px] font-medium text-ink">
          <span className="font-bold text-bad-ink">Your step: </span>
          {item.needs_human ? "Decide how to proceed. The agent could not take this further." : (item.card?.your_step ?? "Review and approve.")}
        </p>
        <Button onClick={onOpen}>{item.state === "needs_human" ? "Open and decide" : "Review and approve"}</Button>
      </div>
    </Card>
  );
}

function QuietRow({ item, urgency, onOpen }: { item: Case; urgency: Urgency; onOpen: () => void }) {
  const last = [...item.messages].reverse().find((m) => m.status === "sent" || m.status === "received");
  const status =
    item.state === "waiting_for_supplier"
      ? `Asked ${last?.counterpart_name ?? "the supplier"} at ${clock(last?.sent_at)}, waiting for the answer`
      : item.state === "supplier_answered"
        ? `${last?.counterpart_name ?? "The supplier"} answered at ${clock(last?.sent_at)}, the agent is working on the next step`
        : (item.card?.your_step ?? "The agent has a suggestion ready");
  return (
    <button onClick={onOpen} className="flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left hover:bg-paper">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 font-medium">
          <Rank urgency={urgency} /> {item.card?.headline ?? item.description} <span className="text-xs font-normal text-muted">· {item.description}</span>
        </div>
        <div className="mt-0.5 truncate text-sm font-medium text-ink-2">{status}</div>
        <Facts item={item} urgency={urgency} />
      </div>
      <span className="shrink-0 text-sm text-accent-ink">Open ›</span>
    </button>
  );
}

const LEVEL = { stops_line: ["Stops a line", "bad"], watch: ["Watch", "warn"], info: ["No action", "neutral"] } as const;

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
  const [picks, setPicks] = useState<Forecast | null>(null);
  const [working, setWorking] = useState(false);
  const pickedKey = [...picked].sort().join(",");
  const asOf = data.forecast.as_of;
  useEffect(() => {
    if (!pickedKey) return setPicks(null);
    let stale = false;
    setWorking(true);
    getWhatIf(pickedKey.split(","))
      .then((result) => !stale && setPicks(result.ready ? result : null))
      .catch(() => !stale && setPicks(null))
      .finally(() => !stale && setWorking(false));
    return () => {
      stale = true;
    };
  }, [pickedKey, asOf]);
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const f = data.forecast;
  const short = f.products.filter((p) => p.short > 0);
  const atRisk = short.reduce((sum, p) => sum + p.short, 0);
  const yours = data.cases.filter((c) => c.state === "needs_approval" || c.state === "needs_human");
  const theirs = data.cases.filter((c) => !yours.includes(c));
  const stopOf = (id: string) => f.products.filter((p) => p.first_stop?.material_id === id).map((p) => p.first_stop!.at).sort()[0] ?? "z";
  yours.sort((a, b) => stopOf(a.material_id).localeCompare(stopOf(b.material_id)));
  const partName = new Map(f.components.map((c) => [c.material_id, c.description ?? c.material_id]));
  const toPack = f.products.reduce((sum, p) => sum + p.to_pack, 0);
  const gaps = new Map(f.components.map((c) => [c.material_id, c.gap]));
  const urgencyOf = (c: Case): Urgency => {
    const stop = f.products.filter((p) => p.short > 0 && p.first_stop?.material_id === c.material_id).map((p) => p.first_stop!.at).sort()[0] ?? null;
    return { rank: stop ? "P0" : (gaps.get(c.material_id) ?? 0) > 0 ? "P1" : "P2", stop };
  };
  const order = { P0: 0, P1: 1, P2: 2 };
  theirs.sort((a, b) => order[urgencyOf(a).rank] - order[urgencyOf(b).rank]);
  const sent = data.agent_work.sent_by_agents + data.agent_work.approved_by_people;

  return (
    <div className="space-y-6">
      <section>
        <h1 className={`font-display text-2xl font-semibold leading-tight tracking-tight sm:text-[32px] ${short.length ? "text-bad-ink" : "text-good-ink"}`}>
          {short.length
            ? `As things stand, ${short.map((p) => `${num(p.short)} ${editionName(p.name, p.product_id)}`).join(" and ")} copies will miss the launch.`
            : "Every copy will be packed before the trucks leave."}
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          {data.erp_forecast.will_make_it && short.length > 0
            ? "Soony's system says both editions finish in time. The delivery notes, inspection reports and supplier mails say otherwise."
            : `Based on the pack-out status of ${when(f.as_of)}.`}
        </p>
      </section>

      <DockHero data={data} picks={picked.size ? picks : null} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi
          label="Copies at risk" value={num(atRisk)} hint="will not be packed if nobody acts" tone={atRisk ? "text-bad-ink" : "text-good-ink"}
          share={toPack ? atRisk / toPack : 0} ring={atRisk ? "bad" : "good"} what="of what is left to pack"
        />
        <Kpi
          label="Waiting for you" value={String(yours.length)} hint={yours.length ? "decisions only a person may take" : "nothing needs you right now"}
          tone={yours.length ? "text-bad-ink" : "text-good-ink"}
          share={data.cases.length ? yours.length / data.cases.length : 0} ring={yours.length ? "warn" : "good"} what="of the open cases"
        />
        <Kpi
          label="Done by the agents" value={String(data.agent_work.sent_by_agents + data.agent_work.replies)}
          hint={`${data.agent_work.sent_by_agents} questions sent, ${data.agent_work.replies} answers read`}
          share={sent ? data.agent_work.sent_by_agents / sent : 0} ring="accent" what="of messages sent without you"
        />
      </div>

      {data.foreign_mail.length > 0 && (
        <Card className="border-2 border-accent-600 bg-accent-soft p-4 text-sm">
          <div className="text-base font-bold text-bad-ink">
            {data.foreign_mail.length} message{data.foreign_mail.length > 1 ? "s" : ""} left this mailbox that the agents did not send
          </div>
          <p className="mt-1 font-medium text-ink">
            Last one to {data.foreign_mail[data.foreign_mail.length - 1].counterpart_name} at {clock(data.foreign_mail[data.foreign_mail.length - 1].sent_at)}. Check who
            or what else uses the mailbox: suppliers treat every mail from it as coming from Soony.
          </p>
        </Card>
      )}

      <HowTo />

      <div className="grid items-start gap-6 xl:grid-cols-[1.7fr_1fr]">
        <div className="space-y-6">
          <section>
            <h2 className="font-display text-lg font-semibold">What needs you now</h2>
            <div className="mt-3 space-y-4">
              {yours.map((c) => (
                <ActionCard key={c.key} item={c} urgency={urgencyOf(c)} onOpen={() => onOpen(c.key)} />
              ))}
              {yours.length === 0 && (
                <Card className="p-5 text-sm text-muted">
                  {data.cases.length === 0 && data.loop.agents_on ? "The agents are working through the files. Their first suggestions appear here in a few minutes." : "Nothing. The agents will bring a decision here when one is needed."}
                </Card>
              )}
            </div>
          </section>

          {theirs.length > 0 && (
            <section>
              <h2 className="font-display text-lg font-semibold">The agents are handling</h2>
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
              <h2 className="font-display text-lg font-semibold">
                What if <span className="ml-1 font-sans text-xs font-normal text-muted">tick a fix to simulate · the number is what it saves alone</span>
              </h2>
              <Card className="mt-3 p-4">
                <Levers cases={data.cases} plan={data.plan} picked={picked} onToggle={toggle} onClear={() => setPicked(new Set())} onOpen={onOpen} result={picks} loading={working} />
              </Card>
            </section>
          )}
          <section>
            <h2 className="font-display text-lg font-semibold">
              Evidence <span className="ml-1 font-sans text-xs font-normal text-muted">where the system and the paper disagree</span>
            </h2>
            <Card className="mt-3 p-4">
              <EvidenceList findings={data.findings} />
            </Card>
          </section>
        </div>
      </div>

      <section>
        <h2 className="font-display text-lg font-semibold">When the lines stand still</h2>
        <Card className="mt-3 p-5">
          <LineTimeline forecast={f} now={data.now} partName={partName} />
        </Card>
      </section>

      <section>
        <h2 className="font-display text-lg font-semibold">Will we make it?</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
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
                  The line stops {when(p.first_stop.at)} when {partName.get(p.first_stop.material_id) ?? p.first_stop.material_id} runs out.
                </p>
              )}
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
