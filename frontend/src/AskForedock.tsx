import { useEffect, useRef, useState, type ReactNode } from "react";
import { askForedock, fileUrl, type AssistantReply, type ReplyLanguage, type VoiceAvailability } from "./api";

import { useVoice } from "./useVoice";

const LANGUAGES = { en: "English", de: "Deutsch", zh: "简体中文", pl: "Polski", ko: "한국어" };
const STARTERS = [
  "Which line stops first, and why?",
  "What needs a decision from me right now?",
  "Which single fix saves the most copies?",
  "What have the suppliers answered so far?",
];

type Entry = { question: string; reply: AssistantReply };

/** The answer as text with its bold marks and bullet lines shown as such. */
function Rich({ text }: { text: string }) {
  const bold = (line: string): ReactNode[] =>
    line.split(/([*][*][^*]+[*][*])/).map((part, i) => (part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.replaceAll("`", "")));
  return (
    <div className="space-y-1.5">
      {text.split("\n").filter((line) => line.trim()).map((line, i) => {
        const bullet = /^\s*[-•*]\s+/.exec(line);
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-600" />
            <span>{bold(line.slice(bullet[0].length))}</span>
          </div>
        ) : (
          <p key={i}>{bold(line.replace(/^#+\s*/, ""))}</p>
        );
      })}
    </div>
  );
}

const quiet = "rounded-full border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink hover:bg-band disabled:opacity-50";

export function AskForedock({ caseKey, onOpen, onClose, verified, availability }: {
  caseKey: string | null;
  onOpen: (key: string) => void;
  onClose?: () => void;
  verified: boolean;
  availability: VoiceAvailability;
}) {
  const [transcribeOnly, setTranscribeOnly] = useState(false);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState<ReplyLanguage | null>(null);
  const [detected, setDetected] = useState<ReplyLanguage | null>(null);
  const voice = useVoice(setError);
  const pending = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => box.current?.focus(), []);

  // Keep the newest message in view: the question as soon as it is asked, then the answer.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [entries.length, asking, busy, error, voice.stage]);

  function cancelTurn() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setAsking(null);
  }

  async function submit(text: string, replyLanguage: ReplyLanguage | null, speak: boolean) {
    const question = text.trim();
    if (!question || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setAsking(question);
    setDraft("");
    setError("");
    try {
      const reply = await askForedock({
        message: question, conversation_id: entries.at(-1)?.reply.conversation_id ?? null,
        case_key: caseKey, language: replyLanguage,
      }, request.signal);
      if (request.signal.aborted) return;
      setEntries((old) => [...old, { question, reply }]);
      setDetected(null);
      if (speak) void voice.play(reply, reply.language ?? replyLanguage, availability.speak);
    } catch (failure) {
      if (request.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Could not get an answer.");
      setDraft((typed) => typed || question); // give the question back so it can be sent again
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
        setAsking(null);
        box.current?.focus();
      }
    }
  }

  function startRecording(review: boolean) {
    setError("");
    setTranscribeOnly(review);
    void voice.start(language, !review, (text, found) => {
      if (!text) { setError("No speech was detected. Try again a little closer to the microphone."); return; }
      setDetected(found);
      if (review) { setDraft(text); box.current?.focus(); } else void submit(text, language ?? found, true);
    });
  }

  function newChat() {
    cancelTurn(); voice.cancel(); setEntries([]); setDraft(""); setDetected(null); setError("");
    box.current?.focus();
  }

  const idle = voice.stage === "idle";
  const empty = entries.length === 0 && !asking;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-band px-4 py-3">
        <div className="min-w-0">
          <div className="font-display text-base font-semibold">Ask Foredock</div>
          <div className="truncate text-xs text-muted">
            {verified ? "Signed in with your own key" : "Shared key"} · answers from the desk's data · cannot send or approve
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" className={quiet} disabled={empty && !draft && !error} onClick={newChat}>New chat</button>
          {onClose && (
            <button type="button" aria-label="Close Ask Foredock" className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-muted hover:bg-line/60 hover:text-ink" onClick={onClose}>
              ×
            </button>
          )}
        </div>
      </header>

      <div ref={log} role="log" aria-live="polite" className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
        {empty && (
          <div>
            <p className="text-muted">
              Ask about the launch in your own words{availability.transcribe ? ", by typing or by voice" : ""}. Try one of these:
            </p>
            <div className="mt-3 grid gap-2">
              {STARTERS.map((q) => (
                <button key={q} type="button" disabled={busy} className="rounded-xl border border-line bg-card px-3 py-2 text-left font-medium text-ink hover:border-accent-600 hover:bg-accent-soft" onClick={() => void submit(q, language, false)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map(({ question, reply }) => (
          <div key={reply.answer_id} className="space-y-2">
            <p className="w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent-600 px-3.5 py-2 font-medium text-white [margin-left:auto]">{question}</p>
            <div data-answer className="mr-6 rounded-2xl rounded-bl-md bg-band px-3.5 py-3 leading-relaxed text-ink ring-1 ring-line">
              <Rich text={reply.answer} />
              {(reply.cases.length > 0 || reply.evidence.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
                  {reply.cases.map((key) => (
                    <button key={key} type="button" className="rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white hover:bg-accent-700" onClick={() => onOpen(key)}>
                      Open case {key.replace(/^part:/, "")} ›
                    </button>
                  ))}
                  {reply.evidence.map((path) => (
                    <a key={path} title={path} className="rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-accent-ink hover:underline" href={fileUrl(path)} target="_blank" rel="noreferrer">
                      {path.split("/").pop()}
                    </a>
                  ))}
                </div>
              )}
              {(availability.transcribe || availability.speak) && (
                <button type="button" className="mt-2 text-xs font-semibold text-accent-ink hover:underline disabled:opacity-50" disabled={!idle || busy} onClick={() => void voice.play(reply, reply.language ?? language, availability.speak)}>
                  ▶ Play answer
                </button>
              )}
            </div>
          </div>
        ))}

        {asking && (
          <div className="space-y-2">
            <p className="w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent-600 px-3.5 py-2 font-medium text-white [margin-left:auto]">{asking}</p>
            <div role="status" className="mr-6 flex w-fit items-center gap-2 rounded-2xl rounded-bl-md bg-band px-3.5 py-3 text-muted ring-1 ring-line">
              <span className="wave" aria-hidden><i /><i /><i /></span> Looking it up…
            </div>
          </div>
        )}
        {error && <p role="alert" className="rounded-xl bg-accent-soft px-3 py-2 font-medium text-bad-ink">{error}</p>}
      </div>

      {!idle && (
        <div role="status" className="flex items-center justify-between gap-3 border-t border-line bg-accent-soft px-4 py-2 text-sm font-medium text-bad-ink">
          <span className="flex items-center gap-2">
            {voice.stage === "recording" && <span className="wave" aria-hidden><i /><i /><i /><i /></span>}
            {voice.stage === "opening" && "Waiting for the microphone…"}
            {voice.stage === "recording" && (transcribeOnly ? "Listening… press Stop when you are done" : "Listening… pause to send")}
            {voice.stage === "transcribing" && "Writing down what you said…"}
            {voice.stage === "playing" && "Reading the answer aloud…"}
          </span>
          <span className="flex shrink-0 gap-1.5">
            {voice.stage === "recording" && <button type="button" className={quiet} onClick={voice.stopRecording}>{transcribeOnly ? "Stop" : "Stop and ask"}</button>}
            <button type="button" className={quiet} onClick={voice.cancel}>{voice.stage === "playing" ? "Stop playback" : "Cancel"}</button>
          </span>
        </div>
      )}

      <form className="border-t border-line p-3" onSubmit={(event) => { event.preventDefault(); void submit(draft, language ?? detected, false); }}>
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="ask-foredock-question">Your question</label>
          <textarea
            id="ask-foredock-question" ref={box} value={draft} maxLength={2000} rows={2}
            placeholder="Ask a question… (Enter sends, Shift+Enter starts a new line)"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-card px-3 py-2 text-sm placeholder:text-muted"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit(draft, language ?? detected, false);
              }
            }}
          />
          {busy ? (
            <button type="button" className="rounded-xl border border-line bg-card px-4 py-2.5 text-sm font-semibold text-ink hover:bg-band" onClick={cancelTurn}>Cancel</button>
          ) : (
            <button className="rounded-xl bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-40" disabled={!idle || !draft.trim()}>Send</button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {availability.transcribe && (
              <>
                <button type="button" disabled={busy || !idle} className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-paper hover:opacity-90 disabled:opacity-40" onClick={() => startRecording(false)}>🎙 Ask by voice</button>
                <button type="button" disabled={busy || !idle} className={quiet} title="Speak, then check the text before sending" onClick={() => startRecording(true)}>Dictate</button>
              </>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Reply in
            <select value={language ?? ""} disabled={!idle || busy} className="rounded-lg border border-line bg-card px-2 py-1 text-xs text-ink" onChange={(event) => setLanguage((event.target.value || null) as ReplyLanguage | null)}>
              <option value="">the language asked{detected && !language ? ` (${LANGUAGES[detected]})` : ""}</option>
              {Object.entries(LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
        </div>
      </form>
    </section>
  );
}
