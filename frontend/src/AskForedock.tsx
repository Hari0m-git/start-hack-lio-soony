import { useEffect, useRef, useState } from "react";
import { askForedock, fileUrl, type AssistantReply, type ReplyLanguage, type VoiceAvailability } from "./api";

import { useVoice } from "./useVoice";

const LANGUAGES = { en: "English", de: "Deutsch", zh: "简体中文", pl: "Polski", ko: "한국어" };

type Entry = { question: string; reply: AssistantReply };

export function AskForedock({ caseKey, onOpen, verified, availability }: {
  caseKey: string | null;
  onOpen: (key: string) => void;
  verified: boolean;
  availability: VoiceAvailability;
}) {
  const [open, setOpen] = useState(true);
  const [transcribeOnly, setTranscribeOnly] = useState(false);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState<ReplyLanguage | null>(null);
  const [detected, setDetected] = useState<ReplyLanguage | null>(null);
  const voice = useVoice(setError);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  function cancelTurn() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }

  async function submit(text: string, replyLanguage: ReplyLanguage | null, speak: boolean) {
    const question = text.trim();
    if (!question || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      const reply = await askForedock({
        message: question, conversation_id: entries.at(-1)?.reply.conversation_id ?? null,
        case_key: caseKey, language: replyLanguage,
      }, request.signal);
      if (request.signal.aborted) return;
      setEntries((old) => [...old, { question, reply }]);
      setDraft("");
      setDetected(null);
      if (speak) void voice.play(reply, reply.language ?? replyLanguage, availability.speak);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not get an answer.");
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function startRecording(review: boolean) {
    setError("");
    setTranscribeOnly(review);
    void voice.start(language, !review, (text, found) => {
      if (!text) { setError("No speech was detected."); return; }
      setDraft(text);
      setDetected(found);
      if (!review) void submit(text, language ?? found, true);
    });
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" aria-expanded={open} className="font-semibold" onClick={() => { if (open) { voice.cancel(); cancelTurn(); } setOpen(!open); }}>Ask Foredock</button>
        <span className="text-xs text-muted">{verified ? "Personal key · Read only" : "Shared key · Read only"}</span>
      </div>
      {open && <div className="mt-4 grid gap-3">
        <button type="button" className="justify-self-end text-sm text-accent" onClick={() => {
          cancelTurn(); voice.cancel(); setEntries([]); setDraft(""); setDetected(null); setError("");
        }}>New chat</button>
        <div role="log" className="grid max-h-80 gap-3 overflow-y-auto">
          {entries.map(({ question, reply }) => <div key={reply.answer_id} className="grid gap-2">
            <p className="rounded-lg bg-line/30 p-2">{question}</p>
            <p className="whitespace-pre-wrap">{reply.answer}</p>
            {availability.transcribe && <button type="button" className="justify-self-start text-sm text-accent"
              disabled={voice.stage !== "idle" || busy}
              onClick={() => void voice.play(reply, reply.language ?? language, availability.speak)}>Play answer</button>}
            {reply.evidence.map((path) => <a key={path} className="text-sm text-accent underline"
              href={fileUrl(path)} target="_blank" rel="noreferrer">{path}</a>)}
            {reply.cases.map((key) => <button key={key} type="button" className="justify-self-start text-sm text-accent"
              onClick={() => onOpen(key)}>Open {key}</button>)}
          </div>)}
        </div>
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void submit(draft, language ?? detected, false); }}>
          <label className="text-sm" htmlFor="ask-foredock-question">Question</label>
          <textarea id="ask-foredock-question" value={draft} maxLength={2000} disabled={busy}
            className="rounded-md border border-line p-2" onChange={(event) => setDraft(event.target.value)} />
          <label className="text-sm">
            Reply language{" "}
            <select value={language ?? ""} disabled={voice.stage !== "idle" || busy} className="rounded border border-line p-1"
              onChange={(event) => setLanguage((event.target.value || null) as ReplyLanguage | null)}>
              <option value="">Auto</option>
              {Object.entries(LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
          {detected && !language && <p role="status" className="text-sm text-muted">Detected {LANGUAGES[detected]}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {availability.transcribe && voice.stage === "idle" && <>
              <button type="button" disabled={busy} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => startRecording(false)}>🎙 Ask by voice</button>
              <button type="button" disabled={busy} className="rounded-full border border-line px-4 py-2 text-sm disabled:opacity-50" onClick={() => startRecording(true)}>Transcribe</button>
            </>}
            {voice.stage === "opening" && <span role="status">Waiting for microphone…</span>}
            {voice.stage === "recording" && !transcribeOnly && <span role="status" className="flex items-center gap-2 text-sm font-medium text-bad"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-bad" />Listening… pause to send</span>}
            {voice.stage === "recording" && <button type="button" onClick={voice.stopRecording}>
              {transcribeOnly ? "Stop and transcribe" : "Stop and ask"}
            </button>}
            {busy && <span role="status">Getting your answer…</span>}
            {voice.stage === "transcribing" && <span role="status">Transcribing…</span>}
            {voice.stage !== "idle" && <button type="button" onClick={voice.cancel}>
              {voice.stage === "playing" ? "Stop playback" : "Cancel audio"}
            </button>}
            <button className="rounded-md bg-ink px-3 py-2 text-sm text-white disabled:opacity-50" disabled={busy || voice.stage !== "idle" || !draft.trim()}>Send</button>
            {busy && <button type="button" onClick={cancelTurn}>Cancel</button>}
          </div>
        </form>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>}
    </section>
  );
}
