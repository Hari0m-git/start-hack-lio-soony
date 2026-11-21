import { useCallback, useEffect, useMemo, useState } from "react";
import {
  accessKey,
  getOverview,
  setAccessKey,
  Unauthorized,
  type Case,
  type CaseState,
  type Forecast,
  type Overview,
  type ProductForecast,
} from "./api";
import { CasePanel } from "./CasePanel";
import { clock, countdown, fileName, hoursBetween, money, num, when } from "./format";
import { Button, Card, Chip, Label, StateChip } from "./ui";

const REFRESH_MS = 20_000;
const ORDER: CaseState[] = ["needs_approval", "supplier_answered", "proposed", "waiting_for_supplier"];
type View = "evidence" | "erp" | "acted";
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: "erp", label: "What the ERP says", hint: "Stock and inbound exactly as booked in the system." },
  { id: "evidence", label: "What the evidence says", hint: "Only what the paperwork supports, if nobody acts." },
  { id: "acted", label: "If the open actions land", hint: "Adds goods that arrive once someone acts, and conditional supplier promises." },
];

function Gate({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="text-xl font-semibold tracking-tight">Foredock</div>
        <p className="mt-1 text-sm text-muted">This desk shows Soony's data. Enter your team's access key.</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setAccessKey(key.trim());
            onDone();
          }}
        >
          <input
            autoFocus
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Access key"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
          <Button disabled={!key.trim()}>Open the desk</Button>
        </form>
      </Card>
    </div>
  );
}

function Edition({ p, parts }: { p: ProductForecast; parts: Map<string, string> }) {
  const total = p.day_one_demand || p.packed + p.to_pack;
  const pct = (n: number) => `${(100 * n) / total}%`;
  const ok = p.short <= 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-medium">{p.name?.replace(/^.*? – /, "") ?? p.product_id}</div>
        <div className={`text-sm font-semibold ${ok ? "text-good" : "text-bad"}`}>
          {ok ? `Complete ${p.finished_at ? when(p.finished_at) : ""}` : `${num(p.short)} copies short`}
        </div>
      </div>
      <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-line">
        <div className="bg-ink/70" style={{ width: pct(p.packed) }} title={`Packed: ${num(p.packed)}`} />
        <div className="bg-good" style={{ width: pct(p.packed_by_deadline) }} title={`Will be packed: ${num(p.packed_by_deadline)}`} />
        <div className="bg-bad" style={{ width: pct(p.short) }} title={`Short: ${num(p.short)}`} />
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-xs text-muted">
        <span>
          {num(p.packed)} packed · {num(p.to_pack)} to go at {num(p.rate_per_hour)}/h
        </span>
        {p.first_stop && (
          <span className={ok ? "" : "font-medium text-bad"}>
            Line stops {when(p.first_stop.at)} · {parts.get(p.first_stop.material_id) ?? p.first_stop.material_id}
          </span>
        )}
      </div>
    </div>
  );
}

function CaseCard({ item, stops, onOpen }: { item: Case; stops?: string; onOpen: () => void }) {
  const rec = item.recommended;
  const tone = item.state === "needs_approval" ? "border-l-bad" : item.state === "waiting_for_supplier" ? "border-l-line" : "border-l-warn";
  return (
    <button
      onClick={onOpen}
      className={`w-full rounded-xl border border-l-4 border-line ${tone} bg-card p-4 text-left transition-shadow hover:shadow-md`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold leading-tight">{item.description ?? item.material_id}</div>
          <div className="text-xs text-muted">
            {item.material_id}
            {stops && ` · stops a line ${when(stops)}`}
          </div>
        </div>
        <StateChip state={item.state} />
      </div>
      {rec && (
        <>
          <div className="mt-3 text-sm">
            <span className="text-muted">Recommended: </span>
            {rec.title}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip tone="good">saves {num(rec.copies_saved)} copies</Chip>
            <Chip>{money(rec.cost, rec.currency)}</Chip>
            {item.approval && <Chip>{item.approval.person ?? item.approval.required_role} signs</Chip>}
          </div>
        </>
      )}
    </button>
  );
}

export default function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("evidence");
  // The open case lives in the address, so a case can be shared as a link.
  const [open, setOpenState] = useState<string | null>(() => decodeURIComponent(location.hash.slice(1)) || null);
  const setOpen = (key: string | null) => {
    setOpenState(key);
    history.replaceState(null, "", key ? `#${encodeURIComponent(key)}` : location.pathname);
  };
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await getOverview());
      setLocked(false);
      setError("");
    } catch (e) {
      if (e instanceof Unauthorized) setLocked(true);
      else setError(e instanceof Error ? e.message : "The desk cannot reach its server.");
    }
  }, []);

  useEffect(() => {
    load();
    const refresh = setInterval(load, REFRESH_MS);
    const second = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(second);
    };
  }, [load]);

  const parts = useMemo(
    () => new Map((data?.forecast.components ?? []).map((c) => [c.material_id, c.description ?? c.material_id])),
    [data],
  );

  if (locked) return <Gate onDone={load} />;
  if (!data)
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted">{error || "Opening the desk…"}</div>;

  const forecasts: Record<View, Forecast> = { evidence: data.forecast, erp: data.erp_forecast, acted: data.forecast_if_acted };
  const f = forecasts[view];
  const truth = data.forecast;
  if (!truth.ready)
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-muted">
        <div>
          <div className="text-base font-medium text-ink">Reading Soony's files…</div>
          <p className="mt-1">
            {data.files} files mirrored, {data.documents_read} documents read so far. {truth.reason}
          </p>
        </div>
      </div>
    );

  const short = truth.products.filter((p) => p.short > 0);
  const erpFine = data.erp_forecast.will_make_it;
  const hoursLeft = hoursBetween(data.now, truth.deadline) - (tick * 0.5) / 60;
  const stopOf = (materialId: string) =>
    truth.products.filter((p) => p.first_stop?.material_id === materialId).map((p) => p.first_stop!.at).sort()[0];
  const cases = [...data.cases].sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (stopOf(a.material_id) ?? "z").localeCompare(stopOf(b.material_id) ?? "z"),
  );
  const waiting = cases.filter((c) => c.state === "needs_approval").length;
  const opened = cases.find((c) => c.key === open);
  const quiet = data.findings.filter((x) => x.level !== "stops_line");

  return (
    <div className="mx-auto max-w-6xl px-5 pb-16">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line py-5">
        <div>
          <div className="text-xl font-semibold tracking-tight">Foredock</div>
          <div className="text-sm text-muted">Soony · Grand Heist 6 launch · know before the dock</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted">Trucks leave {when(truth.deadline)}</div>
          <div className="text-2xl font-semibold tabular-nums">{countdown(hoursLeft)}</div>
        </div>
      </header>

      <section className="py-6">
        <h1 className={`text-2xl font-semibold leading-tight tracking-tight sm:text-3xl ${short.length ? "text-bad" : "text-good"}`}>
          {short.length
            ? `On the evidence, the launch is short: ${short.map((p) => `${num(p.short)} ${p.name?.replace(/^.*? – /, "").replace(/ \(.*/, "") ?? p.product_id}`).join(" and ")}.`
            : "On the evidence, every copy is packed before the trucks leave."}
        </h1>
        <p className="mt-2 text-[15px] text-muted">
          {erpFine && short.length > 0
            ? "The ERP says both editions finish in time. The paperwork disagrees."
            : `Pack-out status as of ${when(truth.as_of)}, ${truth.hours_available} packing hours left.`}{" "}
          {waiting > 0 && (
            <span className="font-medium text-ink">
              {waiting} decision{waiting > 1 ? "s" : ""} wait{waiting > 1 ? "" : "s"} for you.
            </span>
          )}
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Label>Will we make it</Label>
              <div className="flex rounded-lg border border-line bg-paper p-0.5 text-xs">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    title={v.hint}
                    onClick={() => setView(v.id)}
                    className={`rounded-md px-2.5 py-1.5 font-medium transition-colors ${view === v.id ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-5 space-y-5">
              {f.products.map((p) => (
                <Edition key={p.product_id} p={p} parts={parts} />
              ))}
            </div>
            <p className="mt-4 text-xs text-muted">
              {VIEWS.find((v) => v.id === view)!.hint}
              {data.priority.order.length > 0 && data.priority.basis && (
                <>
                  {" "}
                  Priority from Soony's memo: <span className="italic">{data.priority.basis}</span>
                </>
              )}
            </p>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-5 pt-5">
              <Label>Parts for the copies still to pack</Label>
            </div>
            <div className="overflow-x-auto">
              <table className="mt-3 w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2 font-medium">Part</th>
                    <th className="px-3 py-2 text-right font-medium">Needed</th>
                    <th className="px-3 py-2 text-right font-medium">ERP stock</th>
                    <th className="px-3 py-2 text-right font-medium">Usable</th>
                    <th className="px-3 py-2 text-right font-medium">Inbound</th>
                    <th className="px-5 py-2 text-right font-medium">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {truth.components.map((c) => {
                    const wrong = Math.round(c.erp_stock) !== Math.round(c.usable_stock);
                    return (
                      <tr key={c.material_id} className="border-b border-line/60 last:border-0">
                        <td className="px-5 py-2.5">
                          <div className="font-medium">{c.description}</div>
                          <div className="text-xs text-muted">{c.material_id}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{num(c.need)}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${wrong ? "text-muted line-through" : ""}`}>{num(c.erp_stock)}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${wrong ? "font-semibold text-bad" : ""}`}>{num(c.usable_stock)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {num(c.inbound_counted)}
                          {c.inbound_needing_action > 0 && (
                            <div className="text-xs text-warn">+{num(c.inbound_needing_action)} if someone acts</div>
                          )}
                        </td>
                        <td className={`px-5 py-2.5 text-right font-semibold tabular-nums ${c.gap > 0 ? "text-bad" : "text-good"}`}>
                          {c.gap > 0 ? num(c.gap) : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line px-5 py-3 text-xs text-muted">{truth.assumptions.join(" ")}</p>
          </Card>
        </div>

        <div className="space-y-5 lg:col-span-2">
          <div>
            <Label>What can stop a line</Label>
            <div className="mt-3 space-y-3">
              {cases.map((c) => (
                <CaseCard key={c.key} item={c} stops={stopOf(c.material_id)} onOpen={() => setOpen(c.key)} />
              ))}
              {cases.length === 0 && (
                <Card className="p-4 text-sm text-muted">
                  {data.loop.running ? "The agents are working the cases. This takes about two minutes." : "Nothing threatens the launch right now."}
                </Card>
              )}
            </div>
          </div>

          {quiet.length > 0 && (
            <Card className="p-5">
              <Label>Also noticed · not stopping a line</Label>
              <ul className="mt-3 space-y-2 text-sm">
                {quiet.map((x) => (
                  <li key={x.key} title={x.detail}>
                    {x.title}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5">
            <Label>New in the portal</Label>
            <ul className="mt-3 space-y-1.5 text-sm">
              {data.drops.slice(0, 8).map((d) => (
                <li key={d.ts + d.path} className="flex justify-between gap-3">
                  <span className="truncate" title={d.path}>
                    {fileName(d.path)}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {d.kind} · {clock(d.ts)}
                  </span>
                </li>
              ))}
              {data.drops.length === 0 && <li className="text-muted">Nothing new since the desk started watching.</li>}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              Watching {data.files} files, {data.documents_read} documents read
              {data.last_sync && `, last check ${clock(data.last_sync.started_at)}`}.
              {data.mail_address && ` Mailbox: ${data.mail_address}.`}
              {data.needs_review.length > 0 && ` ${data.needs_review.length} reading${data.needs_review.length > 1 ? "s" : ""} flagged for a human check.`}
              {data.loop.last_tick?.errors?.length ? ` Last pass reported: ${data.loop.last_tick.errors.join("; ")}` : ""}
            </p>
          </Card>
        </div>
      </div>

      {error && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-white">{error}</div>}
      {opened && (
        <CasePanel
          item={opened}
          findings={data.findings.filter((x) => x.material_id === opened.material_id)}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
