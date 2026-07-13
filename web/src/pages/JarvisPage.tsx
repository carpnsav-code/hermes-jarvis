/**
 * JarvisPage — fullscreen voice assistant dashboard ("Jarvis AI").
 *
 * A black, orb-centric UI inspired by the classic Jarvis look: an animated
 * plasma orb, a status line ("Available…", "Listening…", "Thinking…",
 * "Speaking…"), a push-to-talk mic button, and a Chat view with the full
 * transcript.
 *
 * Connectivity: speaks the same JSON-RPC WebSocket dialect as the Ink TUI
 * via GatewayClient (/api/ws) — `session.create` on mount, `prompt.submit`
 * per turn, streaming `message.delta` events, `message.complete` to finish.
 *
 * Speech:
 *  - Output: Web Speech synthesis. Sentences are spoken incrementally as
 *    deltas stream in (markdown is stripped first), so long answers start
 *    reading aloud before generation finishes.
 *  - Input: Web Speech recognition (Chrome/Edge/Safari). Falls back to the
 *    text composer when the API is unavailable.
 */

import {
  Home,
  MessageCircle,
  Mic,
  Minus,
  SendHorizonal,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { Markdown } from "@/components/Markdown";
import { fetchJSON } from "@/lib/api";
import { GatewayClient } from "@/lib/gatewayClient";
import { extractSpeakable, sanitizeForSpeech } from "@/lib/jarvis-speech";
import { cn } from "@/lib/utils";

/* ─────────────────── minimal SpeechRecognition typing ─────────────────── */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ────────────────────────────── orb canvas ────────────────────────────── */

type OrbMood = "idle" | "listening" | "thinking" | "speaking";

const MOOD_ENERGY: Record<OrbMood, number> = {
  idle: 0.35,
  listening: 0.8,
  thinking: 0.6,
  speaking: 1,
};

function OrbCanvas({ mood, size }: { mood: OrbMood; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const moodRef = useRef<OrbMood>(mood);
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Deterministic pseudo-random layer params (stable across re-renders).
    const blobs = Array.from({ length: 7 }, (_, i) => ({
      speed: 0.25 + (i % 3) * 0.22 + i * 0.05,
      dir: i % 2 === 0 ? 1 : -1,
      phase: (i * Math.PI * 2) / 7,
      dist: 0.18 + (i % 4) * 0.11,
      radius: 0.34 + (i % 3) * 0.12,
      hue: 192 + (i % 4) * 6,
    }));

    let raf = 0;
    let energy = MOOD_ENERGY.idle;
    const start = performance.now();

    const frame = (now: number) => {
      const t = (now - start) / 1000;
      // Ease energy toward the current mood so transitions feel organic.
      energy += (MOOD_ENERGY[moodRef.current] - energy) * 0.04;

      const w = size;
      const h = size;
      const cx = w / 2;
      const cy = h / 2;
      const pulse =
        1 +
        0.025 * Math.sin(t * 1.7) +
        energy * 0.035 * Math.sin(t * 6.3 + Math.sin(t * 2.1));
      const R = w * 0.34 * pulse;

      ctx.clearRect(0, 0, w, h);

      // Outer halo.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 1.45);
      halo.addColorStop(0, `rgba(60,180,255,${0.16 + energy * 0.1})`);
      halo.addColorStop(1, "rgba(0,20,40,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.45, 0, Math.PI * 2);
      ctx.fill();

      // Sphere body + swirling plasma, clipped to the disc.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      const base = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      base.addColorStop(0, "rgba(190,240,255,0.95)");
      base.addColorStop(0.45, "rgba(40,150,220,0.9)");
      base.addColorStop(1, "rgba(4,40,80,1)");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      for (const b of blobs) {
        const a = b.phase + t * b.speed * b.dir * (0.6 + energy);
        const wob = 1 + 0.25 * Math.sin(t * 1.3 + b.phase * 3);
        const bx = cx + Math.cos(a) * R * b.dist * wob;
        const by = cy + Math.sin(a * 1.18) * R * b.dist;
        const br = R * b.radius * (0.85 + 0.3 * Math.sin(t * 2 + b.phase));
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${b.hue},100%,72%,${0.24 + energy * 0.16})`);
        g.addColorStop(1, "hsla(200,100%,50%,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }

      // Rotating filament arcs.
      for (let i = 0; i < 3; i++) {
        const a0 = t * (0.5 + i * 0.3) * (i % 2 ? -1 : 1) + i * 2.1;
        ctx.strokeStyle = `rgba(150,230,255,${0.12 + energy * 0.12})`;
        ctx.lineWidth = R * 0.05;
        ctx.shadowColor = "rgba(120,220,255,0.8)";
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          R * (0.55 + i * 0.14),
          R * (0.3 + i * 0.1),
          a0,
          0.4,
          2.4,
        );
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Bright core.
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.4);
      core.addColorStop(0, `rgba(235,252,255,${0.6 + energy * 0.3})`);
      core.addColorStop(1, "rgba(120,210,255,0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      ctx.restore();

      // Rim light.
      ctx.strokeStyle = `rgba(110,205,255,${0.35 + energy * 0.25})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/* ─────────────────────────────── page ─────────────────────────────── */

type JarvisStatus =
  | "connecting"
  | "available"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

const STATUS_LABEL: Record<JarvisStatus, string> = {
  connecting: "Connecting…",
  available: "Available…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Connection error",
};

export default function JarvisPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<"home" | "chat">("home");
  const [status, setStatus] = useState<JarvisStatus>("connecting");
  const [errorDetail, setErrorDetail] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [interim, setInterim] = useState("");
  const [composer, setComposer] = useState("");
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [micSupported, setMicSupported] = useState(true);

  const gwRef = useRef<GatewayClient | null>(null);
  const sessionRef = useRef<string>("");
  const statusRef = useRef<JarvisStatus>("connecting");
  const ttsRef = useRef(true);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    ttsRef.current = ttsEnabled;
  }, [ttsEnabled]);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = useRef(false);

  // Unspoken tail of the streaming assistant message.
  const speechBufRef = useRef("");
  // Server-TTS pipeline: coalesced text chunks awaiting synthesis, the
  // audio element currently playing, a prefetch slot for the next chunk,
  // and a generation counter that cancels the pump loop on interrupt.
  const chunkBufRef = useRef("");
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0);
  const serverTtsDownRef = useRef(false);
  const prefetchRef = useRef<{
    text: string;
    promise: Promise<string | null>;
  } | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  /* voice selection */
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const prefs = [
        "Google UK English Male",
        "Daniel",
        "Microsoft Ryan",
        "Microsoft Guy",
        "Google US English",
      ];
      voiceRef.current =
        prefs
          .map((p) => voices.find((v) => v.name.startsWith(p)))
          .find(Boolean) ??
        voices.find((v) => v.lang.startsWith("en")) ??
        voices[0];
    };
    pick();
    window.speechSynthesis.addEventListener("voiceschanged", pick);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", pick);
  }, []);

  /**
   * Ask the dashboard server to synthesize with the configured TTS provider
   * (ElevenLabs / Edge / OpenAI — ``tts.`` in config.yaml). Returns a data:
   * URL, or null so the caller falls back to the browser's built-in voice.
   */
  const synthesizeServer = useCallback(
    async (text: string): Promise<string | null> => {
      if (serverTtsDownRef.current) return null;
      try {
        const res = await fetchJSON<{ data_url?: string }>(
          "/api/audio/speak",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          },
        );
        return res?.data_url || null;
      } catch {
        serverTtsDownRef.current = true;
        return null;
      }
    },
    [],
  );

  const speakWithBrowser = useCallback(
    (text: string, gen: number) =>
      new Promise<void>((resolve) => {
        if (!("speechSynthesis" in window)) {
          resolve();
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        if (voiceRef.current) u.voice = voiceRef.current;
        u.rate = 1.04;
        u.pitch = 0.95;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
        // A cancel()ed utterance never fires onend in some browsers — poll
        // so an interrupt can't wedge the pump loop.
        const guard = setInterval(() => {
          if (gen !== genRef.current || !window.speechSynthesis.speaking) {
            clearInterval(guard);
            resolve();
          }
        }, 250);
      }),
    [],
  );

  /** Sequentially synthesize + play queued chunks, prefetching the next
   *  chunk's audio while the current one plays. */
  const pumpSpeech = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    const gen = genRef.current;
    while (queueRef.current.length > 0 && gen === genRef.current) {
      const text = queueRef.current.shift();
      if (!text) continue;
      if (statusRef.current !== "listening") setStatus("speaking");
      const current =
        prefetchRef.current?.text === text
          ? prefetchRef.current.promise
          : synthesizeServer(text);
      const next = queueRef.current[0];
      prefetchRef.current = next
        ? { text: next, promise: synthesizeServer(next) }
        : null;
      const dataUrl = await current;
      if (gen !== genRef.current) break;
      if (dataUrl) {
        await new Promise<void>((resolve) => {
          const audio = new Audio(dataUrl);
          audioElRef.current = audio;
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        });
      } else {
        await speakWithBrowser(text, gen);
      }
    }
    playingRef.current = false;
    if (gen === genRef.current) {
      setStatus((s) => (s === "speaking" ? "available" : s));
    }
  }, [speakWithBrowser, synthesizeServer]);

  const flushSpeechChunks = useCallback(() => {
    if (chunkBufRef.current) {
      queueRef.current.push(chunkBufRef.current);
      chunkBufRef.current = "";
    }
    void pumpSpeech();
  }, [pumpSpeech]);

  // Coalesce sentences into ~140-char chunks: the first flushes immediately
  // so speech starts fast; later ones batch to keep TTS requests (and
  // ElevenLabs cost) reasonable.
  const enqueueSpeech = useCallback(
    (sentences: string[]) => {
      if (!ttsRef.current) return;
      for (const s of sentences) {
        if (!s) continue;
        chunkBufRef.current = chunkBufRef.current
          ? `${chunkBufRef.current} ${s}`
          : s;
        const idle = !playingRef.current && queueRef.current.length === 0;
        if (idle || chunkBufRef.current.length >= 140) flushSpeechChunks();
      }
    },
    [flushSpeechChunks],
  );

  const stopSpeaking = useCallback(() => {
    genRef.current += 1;
    speechBufRef.current = "";
    chunkBufRef.current = "";
    queueRef.current = [];
    prefetchRef.current = null;
    const audio = audioElRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* already stopped */
      }
      audioElRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    playingRef.current = false;
    setStatus((s) => (s === "speaking" ? "available" : s));
  }, []);

  useEffect(() => {
    if (!ttsEnabled) stopSpeaking();
  }, [ttsEnabled, stopSpeaking]);

  /* gateway lifecycle */
  useEffect(() => {
    const gw = new GatewayClient();
    gwRef.current = gw;
    let disposed = false;
    const offs: Array<() => void> = [];

    const isMine = (sid?: string) => sid && sid === sessionRef.current;

    offs.push(
      gw.on<{ text?: string }>("message.delta", (ev) => {
        if (!isMine(ev.session_id)) return;
        const text = ev.payload?.text ?? "";
        if (!text) return;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + text };
          } else {
            next.push({ role: "assistant", text, streaming: true });
          }
          return next;
        });
        speechBufRef.current += text;
        const { sentences, rest } = extractSpeakable(speechBufRef.current);
        speechBufRef.current = rest;
        enqueueSpeech(sentences);
      }),
      gw.on<{ text?: string }>("message.complete", (ev) => {
        if (!isMine(ev.session_id)) return;
        const finalText = ev.payload?.text ?? "";
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            next[next.length - 1] = {
              role: "assistant",
              text: finalText || last.text,
            };
          } else if (finalText) {
            next.push({ role: "assistant", text: finalText });
          }
          return next;
        });
        // Nothing streamed (e.g. tool-only turn summarised at the end):
        // speak the final text; otherwise flush the unspoken tail.
        const tail = speechBufRef.current;
        speechBufRef.current = "";
        const toSpeak = sanitizeForSpeech(tail);
        const hadStream =
          tail.length > 0 ||
          playingRef.current ||
          queueRef.current.length > 0 ||
          chunkBufRef.current.length > 0;
        if (toSpeak) enqueueSpeech([toSpeak]);
        else if (!hadStream && finalText)
          enqueueSpeech([sanitizeForSpeech(finalText)]);
        flushSpeechChunks();
        setStatus(() =>
          playingRef.current || queueRef.current.length > 0
            ? "speaking"
            : "available",
        );
      }),
      gw.on<{ message?: string }>("error", (ev) => {
        if (!isMine(ev.session_id)) return;
        const msg = ev.payload?.message || "agent error";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: `⚠ ${msg}` },
        ]);
        setStatus("available");
      }),
    );

    (async () => {
      try {
        await gw.connect();
        const res = await gw.request<{ session_id: string }>(
          "session.create",
          { cols: 100, title: "Jarvis voice session" },
        );
        if (disposed) return;
        sessionRef.current = res.session_id;
        setStatus("available");
      } catch (err) {
        if (disposed) return;
        setStatus("error");
        setErrorDetail(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      offs.forEach((off) => off());
      const sid = sessionRef.current;
      if (sid) {
        gw.request("session.close", { session_id: sid }).catch(() => {});
      }
      gw.close();
      gwRef.current = null;
      stopSpeaking();
      recognitionRef.current?.abort();
    };
    // All three deps are stable useCallbacks — this effect runs once.
  }, [enqueueSpeech, flushSpeechChunks, stopSpeaking]);

  /* sending */
  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      const gw = gwRef.current;
      const sid = sessionRef.current;
      if (!text || !gw || !sid) return;
      stopSpeaking();
      setMessages((prev) => [...prev, { role: "user", text }]);
      setStatus("thinking");
      try {
        await gw.request("prompt.submit", { session_id: sid, text });
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: `⚠ ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
        setStatus("available");
      }
    },
    [stopSpeaking],
  );

  /* mic */
  const stopListening = useCallback(() => {
    listeningRef.current = false;
    recognitionRef.current?.stop();
    setInterim("");
    setStatus((s) => (s === "listening" ? "available" : s));
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setMicSupported(false);
      return;
    }
    stopSpeaking();
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = navigator.language || "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    listeningRef.current = true;
    setStatus("listening");
    setInterim("");

    let finalTranscript = "";
    rec.onresult = (ev) => {
      let interimText = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript;
        else interimText += r[0].transcript;
      }
      setInterim(interimText || finalTranscript);
    };
    rec.onerror = () => {
      listeningRef.current = false;
      setInterim("");
      setStatus((s) => (s === "listening" ? "available" : s));
    };
    rec.onend = () => {
      const wasListening = listeningRef.current;
      listeningRef.current = false;
      setInterim("");
      if (statusRef.current === "listening") setStatus("available");
      const text = finalTranscript.trim();
      if (wasListening && text) void send(text);
    };
    try {
      rec.start();
    } catch {
      listeningRef.current = false;
      setStatus("available");
    }
  }, [send, stopSpeaking]);

  const toggleMic = useCallback(() => {
    if (listeningRef.current) stopListening();
    else startListening();
  }, [startListening, stopListening]);

  /* chat autoscroll */
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, view]);

  const mood: OrbMood =
    status === "listening"
      ? "listening"
      : status === "thinking"
        ? "thinking"
        : status === "speaking"
          ? "speaking"
          : "idle";

  const busy = status === "thinking";
  const listening = status === "listening";

  const tabButton = (
    tab: "home" | "chat",
    label: string,
    Icon: typeof Home,
  ) => (
    <button
      type="button"
      onClick={() => setView(tab)}
      className={cn(
        "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs transition-colors",
        view === tab
          ? "bg-cyan-500/20 text-cyan-100"
          : "text-slate-200 hover:bg-white/10",
      )}
    >
      <Icon className="h-3.5 w-3.5 text-cyan-300" />
      {label}
    </button>
  );

  // Portal to <body>: the page normally renders inside the dashboard's
  // <main>, whose stacking context would let the sidebar paint on top of
  // this fullscreen overlay.
  return createPortal(
    <div className="fixed inset-0 z-[110] flex flex-col bg-black text-white">
      {/* title bar */}
      <header className="flex h-12 shrink-0 items-center px-4">
        <div className="flex-1 text-sm font-semibold tracking-wide">
          Jarvis AI
        </div>
        <nav className="flex items-center gap-2">
          {tabButton("home", "Home", Home)}
          {tabButton("chat", "Chat", MessageCircle)}
        </nav>
        <div className="flex flex-1 items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setTtsEnabled((v) => !v)}
            title={ttsEnabled ? "Mute voice" : "Unmute voice"}
            className="text-slate-200 hover:text-white"
          >
            {ttsEnabled ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </button>
          <Minus className="h-4 w-4 text-slate-300" aria-hidden="true" />
          <Square className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
          <button
            type="button"
            onClick={() => navigate("/sessions")}
            title="Exit Jarvis"
            className="rounded bg-red-600 p-0.5 text-white hover:bg-red-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* home view */}
      {view === "home" && (
        <main className="flex flex-1 flex-col items-center justify-center gap-6 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (status === "speaking") stopSpeaking();
              else if (!busy && !listening) toggleMic();
            }}
            title="Orb — click to talk, or to stop speaking"
            className="focus:outline-none"
          >
            <OrbCanvas mood={mood} size={420} />
          </button>

          <div className="flex min-h-16 flex-col items-center gap-2 px-6 text-center">
            <p className="text-sm text-slate-100">
              {status === "error"
                ? `${STATUS_LABEL.error}${errorDetail ? ` — ${errorDetail}` : ""}`
                : STATUS_LABEL[status]}
            </p>
            {interim && (
              <p className="max-w-xl text-sm text-cyan-200">“{interim}”</p>
            )}
            {!micSupported && (
              <p className="max-w-xl text-xs text-amber-200">
                Voice input isn’t supported in this browser — use the Chat tab
                to type instead. Responses are still read aloud.
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={toggleMic}
            disabled={status === "connecting" || status === "error"}
            title={listening ? "Stop listening" : "Start listening"}
            className={cn(
              "mb-10 flex h-16 w-16 items-center justify-center rounded-full border transition-all",
              listening
                ? "border-cyan-300 bg-cyan-500/30 shadow-[0_0_35px_rgba(56,189,248,0.7)]"
                : "border-white/25 bg-white/5 hover:border-cyan-300/60 hover:bg-cyan-500/10",
              (status === "connecting" || status === "error") &&
                "cursor-not-allowed",
            )}
          >
            <Mic
              className={cn(
                "h-7 w-7",
                listening ? "text-cyan-100" : "text-white",
              )}
            />
          </button>
        </main>
      )}

      {/* chat view */}
      {view === "chat" && (
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-4 pb-4">
          <div className="flex-1 space-y-4 overflow-y-auto py-4">
            {messages.length === 0 && (
              <p className="pt-16 text-center text-sm text-slate-300">
                No messages yet — press the mic on Home or type below.
              </p>
            )}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-cyan-600/80 px-4 py-2 text-sm whitespace-pre-wrap">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-cyan-400/20 bg-slate-900/80 px-4 py-2">
                    <Markdown content={m.text} streaming={m.streaming} />
                  </div>
                </div>
              ),
            )}
            <div ref={transcriptEndRef} />
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(composer);
              setComposer("");
            }}
          >
            <button
              type="button"
              onClick={toggleMic}
              disabled={status === "connecting" || status === "error"}
              title={listening ? "Stop listening" : "Start listening"}
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border",
                listening
                  ? "border-cyan-300 bg-cyan-500/30"
                  : "border-white/25 bg-white/5 hover:bg-cyan-500/10",
              )}
            >
              <Mic className="h-4 w-4" />
            </button>
            <input
              value={interim || composer}
              onChange={(e) => setComposer(e.target.value)}
              placeholder={
                status === "connecting"
                  ? "Connecting to Hermes…"
                  : "Ask Jarvis anything…"
              }
              disabled={status === "connecting" || status === "error"}
              className="h-10 flex-1 rounded-full border border-white/20 bg-white/5 px-4 text-sm text-white placeholder:text-slate-400 focus:border-cyan-400/70 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!composer.trim() || busy}
              title="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-70"
            >
              <SendHorizonal className="h-4 w-4" />
            </button>
          </form>
          <p className="pt-2 text-center text-xs text-slate-400">
            {STATUS_LABEL[status]}
          </p>
        </main>
      )}
    </div>,
    document.body,
  );
}
