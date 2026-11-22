import { useState } from "react";
import { fileUrl, type Finding, type Overview } from "./api";
import { clock, fileName, num } from "./format";
import { Chip, Label } from "./ui";

const isImage = (path: string) => /\.(png|jpe?g|webp)$/i.test(path);

/** A finding as a card with two sides: what the system shows, and the paper it was checked against. */
export function FlipEvidence({ finding }: { finding: Finding }) {
  const [flipped, setFlipped] = useState(false);
  const contradiction = finding.level !== "info";
  const scan = finding.evidence.find((e) => isImage(e.path));
  const edge = contradiction ? "border-bad/50 shadow-[0_0_0_3px_var(--color-bad-soft)]" : "border-accent/40 shadow-[0_0_0_3px_var(--color-accent-soft)]";
  const side = `rounded-xl border bg-card p-4 ${edge}`;
  return (
    <div className="flip mb-3">
      <div className={`flip-inner ${flipped ? "flipped" : ""}`}>
        <div className={side} inert={flipped} aria-hidden={flipped}>
          <div className="flex items-center justify-between gap-2">
            <Label>What we found</Label>
            <Chip tone={contradiction ? "bad" : "neutral"}>{contradiction ? "System and paper disagree" : "Checked · no action needed"}</Chip>
          </div>
          <div className="mt-2 font-medium">{finding.title}</div>
          {finding.units > 0 && <div className="mt-1 text-muted">{num(finding.units)} pieces affected</div>}
          <button className="mt-3 text-sm font-medium text-accent-ink hover:underline" onClick={() => setFlipped(true)}>
            Turn over: see the source ›
          </button>
        </div>
        <div className={side} inert={!flipped} aria-hidden={!flipped}>
          <Label>The source</Label>
          {scan && (
            <a href={fileUrl(scan.path)} target="_blank" rel="noreferrer" className="mt-2 block">
              <img
                src={fileUrl(scan.path)}
                loading="lazy"
                alt={`Scan of ${fileName(scan.path)}, the document this finding was checked against`}
                className="max-h-64 w-full rounded-lg border border-line bg-white object-contain"
              />
            </a>
          )}
          <p className="mt-2 text-muted">{finding.detail}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {finding.evidence.map((e) => (
              <a
                key={e.path}
                href={fileUrl(e.path)}
                target="_blank"
                rel="noreferrer"
                title={e.path}
                className="rounded-md border border-line bg-paper px-2 py-1 text-xs text-accent-ink hover:underline"
              >
                {fileName(e.path)}
              </a>
            ))}
          </div>
          <button className="mt-3 text-sm font-medium text-accent-ink hover:underline" onClick={() => setFlipped(false)}>
            ‹ Turn back
          </button>
        </div>
      </div>
    </div>
  );
}

/** The seven steps of one pass, with what the last pass did at each. The nodes pulse while a pass runs. */
export function AgentLoop({ data }: { data: Overview }) {
  const last = data.loop.last_tick as (Record<string, unknown> & { at: string }) | null;
  const count = (key: string) => {
    const value = last?.[key];
    return Array.isArray(value) ? value.length : typeof value === "number" ? value : 0;
  };
  const short = data.forecast.products.reduce((sum, p) => sum + p.short, 0);
  const steps: [string, string, string][] = [
    ["Watch", num(count("drops")), "new or changed files"],
    ["Read", num(count("files_read")), "files read"],
    ["Reconcile", num(data.agent_work.findings), "findings open"],
    ["Forecast", num(short), "copies short"],
    ["Decide", num(count("cases_worked")), "cases worked"],
    ["Act", num(count("sent_automatically")), "questions sent"],
    ["Listen", num(count("replies")), "replies read"],
  ];
  return (
    <div>
      <ol className="grid grid-cols-2 gap-x-2 gap-y-5 sm:grid-cols-4 lg:grid-cols-7">
        {steps.map(([name, value, what], i) => (
          <li key={name} className="relative flex flex-col items-center text-center">
            {i > 0 && <span className="absolute right-1/2 top-5 hidden h-px w-full bg-line lg:block" aria-hidden />}
            <span
              className={`relative z-[1] flex h-10 w-10 items-center justify-center rounded-full border border-coral bg-accent-soft font-display text-sm font-semibold text-accent-ink ${data.loop.running ? "node-live" : ""}`}
              style={data.loop.running ? { animationDelay: `${i * 0.18}s` } : undefined}
            >
              {i + 1}
            </span>
            <span className="mt-2 text-sm font-semibold">{name}</span>
            <span className="font-display text-xl font-semibold">{value}</span>
            <span className="text-xs text-muted">{what}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted">
        {data.loop.running ? "A pass is running now." : last ? `Figures from the last pass at ${clock(last.at)}.` : "No pass has run yet."}{" "}
        {data.loop.agents_on ? "A pass runs every two minutes." : "The agents are switched off on this copy of the desk."}
      </p>
    </div>
  );
}
