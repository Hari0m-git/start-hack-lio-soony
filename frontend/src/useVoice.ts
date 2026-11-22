import { useEffect, useRef, useState } from "react";
import { speakAnswer, transcribeClip, type AssistantReply, type ReplyLanguage } from "./api";

const RATE = 16000;
const MAX_SECONDS = 20;
const SILENCE_MS = 850;
const SPEECH_RMS = 0.018;
const LOCALES = { en: "en-US", de: "de-DE", zh: "zh-CN", pl: "pl-PL", ko: "ko-KR" };

async function wav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const source = await context.decodeAudioData(await recording.arrayBuffer());
    const frames = Math.min(RATE * MAX_SECONDS, Math.floor(source.duration * RATE));
    const render = new OfflineAudioContext(1, frames, RATE);
    const input = render.createBufferSource();
    input.buffer = source;
    input.connect(render.destination);
    input.start();
    const samples = (await render.startRendering()).getChannelData(0);
    const bytes = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(bytes);
    const label = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
    };
    label(0, "RIFF");
    view.setUint32(4, bytes.byteLength - 8, true);
    label(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    label(36, "data");
    view.setUint32(40, frames * 2, true);
    for (let index = 0; index < frames; index++) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample * 32767, true);
    }
    return new Blob([bytes], { type: "audio/wav" });
  } finally {
    await context.close();
  }
}

function watchForPause(stream: MediaStream, onPause: () => void): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let speechFrames = 0;
  let lastSpeech: number | null = null;

  const timer = window.setInterval(() => {
    if (context.state !== "running") return;
    analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const now = performance.now();
    if (Math.sqrt(energy / samples.length) >= SPEECH_RMS) {
      speechFrames += 1;
      if (lastSpeech !== null || speechFrames >= 3) lastSpeech = now;
      return;
    }
    speechFrames = 0;
    if (lastSpeech !== null && now - lastSpeech >= SILENCE_MS) onPause();
  }, 50);

  void context.resume().catch(() => {});
  return () => {
    window.clearInterval(timer);
    source.disconnect();
    void context.close().catch(() => {});
  };
}

type Session = {
  request: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setTimeout>;
  stopListening?: () => void;
  audio?: HTMLAudioElement;
  url?: string;
  speech?: SpeechSynthesisUtterance;
};

function release(session: Session) {
  session.request.abort();
  clearTimeout(session.timer);
  session.stopListening?.();
  session.stopListening = undefined;
  if (session.recorder?.state === "recording") session.recorder.stop();
  session.stream?.getTracks().forEach((track) => track.stop());
  session.audio?.pause();
  if (session.speech) window.speechSynthesis.cancel();
  if (session.url) URL.revokeObjectURL(session.url);
}

export function useVoice(onError: (error: string) => void) {
  const current = useRef<Session | null>(null);
  const [stage, setStage] = useState<"idle" | "opening" | "recording" | "transcribing" | "playing">("idle");

  function cancel() {
    const session = current.current;
    current.current = null;
    if (session) release(session);
    setStage("idle");
  }

  useEffect(() => () => {
    if (current.current) release(current.current);
  }, []);

  function fail(session: Session, error: unknown) {
    if (current.current !== session || session.request.signal.aborted) return;
    cancel();
    onError(error instanceof Error ? error.message : "Voice is unavailable.");
  }

  async function start(language: ReplyLanguage | null, endOnPause: boolean, onTranscript: (text: string, language: ReplyLanguage | null) => void) {
    if (current.current) return;
    window.speechSynthesis?.getVoices();
    const session: Session = { request: new AbortController() };
    current.current = session;
    setStage("opening");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Microphone recording requires a supported browser and HTTPS or localhost.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      session.stream = stream;
      if (session.request.signal.aborted) {
        release(session);
        return;
      }
      const recorder = new MediaRecorder(stream);
      session.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onerror = () => fail(session, new Error("Microphone recording failed."));
      recorder.onstop = async () => {
        clearTimeout(session.timer);
        session.stopListening?.();
        session.stopListening = undefined;
        stream.getTracks().forEach((track) => track.stop());
        if (session.request.signal.aborted) return;
        setStage("transcribing");
        try {
          const clip = await wav(new Blob(chunks, { type: recorder.mimeType }));
          if (session.request.signal.aborted) return;
          const transcript = await transcribeClip(clip, language, session.request.signal);
          if (!session.request.signal.aborted) {
            cancel();
            onTranscript(transcript.text, transcript.language);
          }
        } catch (error) {
          fail(session, error);
        }
      };
      recorder.start();
      setStage("recording");
      const stop = () => {
        if (recorder.state === "recording") recorder.stop();
      };
      session.timer = setTimeout(stop, MAX_SECONDS * 1000);
      if (endOnPause) {
        try {
          session.stopListening = watchForPause(stream, stop);
        } catch {
          // Manual stop and the recording cap still work without Web Audio.
        }
      }
    } catch (error) {
      fail(session, error);
    }
  }

  async function play(reply: AssistantReply, language: ReplyLanguage | null, useAzure: boolean) {
    if (current.current) return;
    const session: Session = { request: new AbortController() };
    current.current = session;
    setStage("playing");
    try {
      if (useAzure && language && reply.answer.length <= 1500) {
        try {
          const blob = await speakAnswer(reply, language, session.request.signal);
          if (session.request.signal.aborted) return;
          session.url = URL.createObjectURL(blob);
          session.audio = new Audio(session.url);
          await session.audio.play();
          if (session.request.signal.aborted) return;
          session.audio.onended = cancel;
          session.audio.onerror = () => fail(session, new Error("Could not play the answer."));
          if (session.audio.ended) cancel();
          return;
        } catch {
          if (session.request.signal.aborted) return;
        }
      }

      const synth = window.speechSynthesis;
      const locale = language ? LOCALES[language] : navigator.language;
      const local = synth?.getVoices().filter((item) => item.localService) ?? [];
      const baseLanguage = locale.toLowerCase().split("-")[0];
      const chosen = local.find((item) => item.lang.toLowerCase() === locale.toLowerCase())
        ?? local.find((item) => item.lang.toLowerCase().split("-")[0] === baseLanguage);
      if (!chosen) throw new Error("No matching on-device voice is available. Choose an installed language or configure Azure playback.");
      const speech = new SpeechSynthesisUtterance(reply.answer);
      speech.voice = chosen;
      speech.lang = chosen.lang;
      speech.onend = () => { if (current.current === session) cancel(); };
      speech.onerror = () => fail(session, new Error("Playback was blocked or unavailable. Click Play answer to retry."));
      session.speech = speech;
      synth.speak(speech);
    } catch (error) {
      fail(session, error);
    }
  }

  return { stage, start, stopRecording: () => {
    if (current.current?.recorder?.state === "recording") current.current.recorder.stop();
  }, cancel, play };
}
