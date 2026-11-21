import { useEffect, useState } from "react";
import { editDraft, fileUrl, reworkCase, sendMessage, type Case, type Finding, type Message } from "./api";
import { clock, fileName, money, num, when } from "./format";
import { Button, Chip, Label, StateChip } from "./ui";

const TOOL_NAMES: Record<string, string> = {
  launch_forecast: "Ran the pack-out forecast",
  part_info: "Looked up stock, inbound, orders and suppliers",
  search_documents: "Searched the documents",
  policies: "Checked the approval policy and org chart",
  submit_decision: "Wrote the recommendation",
};

function EvidenceLinks({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...new Set(paths)].map((p) => (
        <a
          key={p}
          href={fileUrl(p)}
          target="_blank"
          rel="noreferrer"
          title={p}
          className="rounded-md border border-line bg-paper px-2 py-1 text-xs text-accent hover:underline"
        >
          {fileName(p)}
        </a>
      ))}
    </div>
  );
}

function Draft({ message, onChanged }: { message: Message; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(message.subject);
  const [body, setBody] = useState(message.body);
  const [busy, setBusy] = useState<"" | "send" | "save">("");
  const [error, setError] = useState("");
  const [showOriginal, setShowOriginal] = useState(!message.body_english);

  const run = async (kind: "send" | "save", action: () => Promise<unknown>) => {
    setBusy(kind);
    setError("");
    try {
      await action();
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="rounded-xl border-2 border-accent/30 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label>
            {message.commits === "nothing"
              ? "Question to supplier · commits nothing"
              : "Commits money or terms · only goes out when you approve"}
          </Label>
          {message.held_because && message.commits === "nothing" && (
            <div className="mt-1 text-xs text-warn">Not sent automatically: {message.held_because}</div>
          )}
          <div className="mt-1 text-sm">
            <span className="font-medium">{message.counterpart_name}</span>{" "}
            <span className="text-muted">{message.counterpart_email}</span>
          </div>
        </div>
        {message.body_english && !editing && (
          <button className="text-xs text-accent hover:underline" onClick={() => setShowOriginal(!showOriginal)}>
            {showOriginal ? "Show English" : `Show original (${message.language ?? "as sent"})`}
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded-lg border border-line px-3 py-2 text-sm font-medium"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <textarea
            className="h-64 w-full rounded-lg border border-line px-3 py-2 text-sm leading-relaxed"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-sm font-medium">{message.subject}</div>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/90">
            {showOriginal ? message.body : message.body_english}
          </pre>
          {!showOriginal && <div className="mt-2 text-xs text-muted">Translation. The supplier receives the original in their language.</div>}
        </div>
      )}
      {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button disabled={!!busy} onClick={() => run("save", () => editDraft(message.id, subject, body))}>
              {busy === "save" ? "Saving…" : "Save wording"}
            </Button>
            <Button kind="quiet" disabled={!!busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!!busy} onClick={() => run("send", () => sendMessage(message.id))}>
              {busy === "send" ? "Sending…" : `Approve and send to ${message.counterpart_name ?? "supplier"}`}
            </Button>
            <Button kind="quiet" disabled={!!busy} onClick={() => setEditing(true)}>
              Edit wording
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Mail({ message }: { message: Message }) {
  const [open, setOpen] = useState(message.direction === "in");
  const ours = message.direction === "out";
  const r = message.reading;
  return (
    <div className={`rounded-xl border border-line p-4 ${ours ? "bg-paper" : "bg-card"}`}>
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <div className="text-xs text-muted">
            {ours ? "We wrote to" : "Reply from"} {message.counterpart_name} · {clock(message.sent_at)}
          </div>
          <div className="truncate text-sm font-medium">{message.subject}</div>
        </div>
        <Chip tone={ours ? "neutral" : "good"}>
          {!ours ? "Received" : message.sent_by === "agent" ? "Sent by the agent" : message.sent_by === "human" ? "Approved and sent" : "Sent"}
        </Chip>
      </button>
      {r && (
        <div className="mt-3 rounded-lg bg-good-soft/60 p-3 text-sm">
          <Label>What the agent read in it</Label>
          <p className="mt-1">{r.summary}</p>
          {r.deliveries.map((d, i) => (
            <p key={i} className="mt-1">
              <span className="font-medium">{num(d.quantity)} pcs</span> of {d.material_id}
              {d.dock_at ? `, on the dock ${when(d.dock_at)}` : ", no dock time given yet"} ·{" "}
              {d.firm ? "firm" : `not firm: ${d.condition ?? "condition open"}`}
            </p>
          ))}
          {r.needs_from_us.length > 0 && <p className="mt-1 text-warn">They need from us: {r.needs_from_us.join("; ")}</p>}
        </div>
      )}
      {open && <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/80">{message.body}</pre>}
    </div>
  );
}

export function CasePanel({
  item,
  findings,
  onClose,
  onChanged,
}: {
  item: Case;
  findings: Finding[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reworking, setReworking] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const drafts = item.messages.filter((m) => m.status === "draft");
  const internal = item.messages.filter((m) => m.status === "internal");
  const mail = item.messages.filter((m) => m.status === "sent" || m.status === "received");
  const rec = item.recommended;
  const others = item.options.filter((_, i) => i !== item.recommended_option);
  const proof = [...new Set([...findings.flatMap((f) => f.evidence.map((e) => e.path)), ...item.evidence])];

  const rework = async () => {
    setReworking(true);
    try {
      await reworkCase(item.material_id);
      onChanged();
    } finally {
      setReworking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/30" onClick={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-paper/95 px-6 py-4 backdrop-blur">
          <div>
            <div className="text-xs text-muted">{item.material_id}</div>
            <h2 className="text-lg font-semibold leading-tight">{item.description ?? item.material_id}</h2>
            <div className="mt-1.5">
              <StateChip state={item.state} />
            </div>
          </div>
          <button className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-line/50" onClick={onClose} aria-label="Close">
            Close ✕
          </button>
        </header>

        <div className="space-y-6 px-6 py-5">
          {item.needs_human && (
            <div className="rounded-xl border-2 border-bad/40 bg-bad-soft p-4 text-sm">
              <div className="font-semibold text-bad">The agent has handed this case to you</div>
              <p className="mt-1 text-ink">{item.needs_human}</p>
              <p className="mt-1 text-muted">Nothing more is sent on this case until a person has decided.</p>
            </div>
          )}
          {item.summary && <p className="text-[15px] leading-relaxed">{item.summary}</p>}

          {rec && (
            <div className="rounded-xl bg-accent p-5 text-white">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/70">Recommendation</div>
              <div className="mt-1 text-lg font-semibold leading-snug">{rec.title}</div>
              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-white/60">Saves</div>
                  <div className="text-base font-semibold">{num(rec.copies_saved)} copies</div>
                </div>
                <div>
                  <div className="text-white/60">Costs</div>
                  <div className="text-base font-semibold">{money(rec.cost, rec.currency)}</div>
                </div>
                <div>
                  <div className="text-white/60">On the dock</div>
                  <div className="text-base font-semibold">{rec.arrives_by ? when(rec.arrives_by) : "to be confirmed"}</div>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-white/85">{item.why}</p>
              {rec.risks && <p className="mt-2 text-sm text-white/70">Risk: {rec.risks}</p>}
            </div>
          )}

          {item.approval && (
            <div>
              <Label>Who signs</Label>
              <p className="mt-1 text-sm">
                <span className="font-medium">{item.approval.person ?? item.approval.required_role}</span>
                {item.approval.person && <span className="text-muted"> · {item.approval.required_role}</span>}
              </p>
              <p className="mt-1 text-sm text-muted">{item.approval.basis}</p>
              {item.approval.note && <p className="mt-1 text-sm text-muted">{item.approval.note}</p>}
            </div>
          )}

          {item.checks.length > 0 && (
            <div className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
              <div className="font-medium">Check before you rely on this</div>
              {item.checks.map((c) => (
                <div key={c}>• {c}</div>
              ))}
            </div>
          )}

          {drafts.map((m) => (
            <Draft key={m.id} message={m} onChanged={onChanged} />
          ))}

          {mail.length > 0 && (
            <div className="space-y-2">
              <Label>Correspondence</Label>
              {mail.map((m) => (
                <Mail key={m.id} message={m} />
              ))}
            </div>
          )}

          {internal.length > 0 && (
            <div className="space-y-2">
              <Label>Notes for Soony's team · prepared, not sent</Label>
              {internal.map((m) => (
                <details key={m.id} className="rounded-xl border border-line bg-card p-4">
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">{m.counterpart_name}</span> <span className="text-muted">· {m.subject}</span>
                  </summary>
                  <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink/80">{m.body}</pre>
                </details>
              ))}
            </div>
          )}

          {(others.length > 0 || item.ruled_out.length > 0) && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-muted">What else was considered</summary>
              <div className="mt-2 space-y-2 text-sm">
                {others.map((o) => (
                  <div key={o.title} className="rounded-lg border border-line bg-card p-3">
                    <div className="font-medium">{o.title}</div>
                    <div className="text-muted">
                      Saves {num(o.copies_saved)} · {money(o.cost, o.currency)}
                    </div>
                    <div className="mt-1">{o.description}</div>
                  </div>
                ))}
                {item.ruled_out.map((r) => (
                  <div key={r} className="text-muted">
                    • {r}
                  </div>
                ))}
              </div>
            </details>
          )}

          {item.open_questions.length > 0 && (
            <div>
              <Label>Still open</Label>
              {item.open_questions.map((q) => (
                <p key={q} className="mt-1 text-sm">
                  • {q}
                </p>
              ))}
            </div>
          )}

          <div>
            <Label>Evidence · opens the original file</Label>
            <div className="mt-2 space-y-2">
              {findings.map((f) => (
                <div key={f.key} className="text-sm">
                  <div className="font-medium">{f.title}</div>
                  <div className="text-muted">{f.detail}</div>
                </div>
              ))}
              <EvidenceLinks paths={proof} />
            </div>
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-medium text-muted">How the agent got here ({item.trace.length} steps)</summary>
            <ol className="mt-2 space-y-1 text-sm text-muted">
              {item.trace.map((t, i) => {
                const args = Object.values(t.args ?? {}).flat().join(", ");
                return (
                  <li key={i}>
                    {i + 1}. {TOOL_NAMES[t.tool] ?? t.tool}
                    {args && <span className="text-ink/60"> · {args}</span>}
                  </li>
                );
              })}
            </ol>
          </details>

          <div className="flex items-center justify-between border-t border-line pt-4">
            <span className="text-xs text-muted">
              Worked at {clock(item.updated_at)} · ${item.cost_usd.toFixed(2)} of model time on this case so far. Reworked only when the
              facts change.
            </span>
            <Button kind="quiet" onClick={rework} disabled={reworking}>
              {reworking ? "Working… about a minute" : "Work this case again"}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
