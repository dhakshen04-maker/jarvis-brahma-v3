"use client";
/**
 * Voice engine hook. Real browser APIs only:
 *  - getUserMedia + AudioContext analyser (echo cancellation / noise suppression requested) -> live level + VAD
 *  - SpeechRecognition (continuous, interim) -> wake word, utterances, confidence, barge-in
 *  - speechSynthesis -> sentence-streamed speech with voice profiles, pronunciation map and pauses
 * Every state change is an event passed through the pure reducer in machine.ts.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { initialMachine, reduceVoice, type VoiceEventType, type VoiceMachineState } from "@/lib/voice/machine";
import { DEFAULT_VOICE, cleanForSpeech, loadVoiceSettings, matchWake, pickVoice, saveVoiceSettings, splitSentences, type VoiceSettings } from "@/lib/voice/profiles";
import { detectLanguage } from "@/lib/languages";

interface SRAlt { transcript: string; confidence: number }
interface SRResult { isFinal: boolean; length: number; [i: number]: SRAlt }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SRInstance {
  continuous: boolean; interimResults: boolean; lang: string; maxAlternatives: number; processLocally?: boolean;
  onresult: ((e: SREvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; onstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type SRCtor = new () => SRInstance;
type W = Window & { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor; webkitAudioContext?: typeof AudioContext };

export interface VoiceCallbacks {
  onUtterance: (text: string, meta: { confidence: number; at: number }) => void;
  onBargeIn: () => void;
}

export interface SelfTestItem { name: string; ok: boolean | null; detail: string }

const COMMAND_WORDS = /^(stop|cancel|wait|enough|quiet|silence|jarvis|pause|shut up)$/i;
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

export function useVoice(cbRef: MutableRefObject<VoiceCallbacks>) {
  const [m, setM] = useState<VoiceMachineState>(() => initialMachine(0));
  const mRef = useRef(m);
  const [settings, setSettingsState] = useState<VoiceSettings>(DEFAULT_VOICE);
  const sRef = useRef(settings);
  const [level, setLevel] = useState(0);
  const [interim, setInterim] = useState("");
  const [lastHeard, setLastHeard] = useState<{ text: string; confidence: number } | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState({ permission: "unknown", active: false, label: "", trackState: "none", echoCancellation: undefined as boolean | undefined, noiseSuppression: undefined as boolean | undefined, error: "", recoveries: 0 });
  const [online, setOnline] = useState(true);
  const [offlineVoice, setOfflineVoice] = useState<"n/a" | "on-device active" | "on-device unavailable">("n/a");
  const [active, setActive] = useState(false);
  const [metrics, setMetrics] = useState({ lastLatencyMs: null as number | null, lastConfidence: null as number | null, wakes: 0, bargeIns: 0, restarts: 0 });
  const [supported, setSupported] = useState({ recognition: false, synthesis: false, media: false, audioContext: false, secure: true, onDevice: false });

  const fns = useRef({} as Record<string, (...a: never[]) => unknown>);
  const rec = useRef<SRInstance | null>(null);
  const want = useRef(false);
  const wakeMode = useRef(false);
  const forceLocal = useRef(false);
  const restartTimes = useRef<number[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const actx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef(0);
  const lastSpeechAt = useRef(Date.now());
  const wakeFired = useRef("");
  const utteranceAt = useRef(0);
  const pendingMetrics = useRef<Array<{ name: string; value: number; labels: Record<string, string> }>>([]);
  const metricTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sp = useRef({ queue: [] as string[], speaking: false, ended: false, started: false, buffer: "", gen: 0, current: "", recent: [] as string[], t0: 0, reported: false });

  const fire = useCallback((type: VoiceEventType, detail?: string) => {
    const next = reduceVoice(mRef.current, { type, detail, at: Date.now() });
    mRef.current = next;
    setM(next);
    return next;
  }, []);

  const metric = useCallback((name: string, value: number) => {
    pendingMetrics.current.push({ name, value, labels: { lang: sRef.current.lang, mode: wakeMode.current ? "wake" : "talk" } });
    if (!metricTimer.current) {
      metricTimer.current = setTimeout(() => {
        const events = pendingMetrics.current.splice(0);
        metricTimer.current = null;
        fetch("/api/metrics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) }).catch(() => undefined);
      }, 1500);
    }
  }, []);

  const setSettings = useCallback((patch: Partial<VoiceSettings>) => {
    const next = { ...sRef.current, ...patch };
    sRef.current = next;
    setSettingsState(next);
    saveVoiceSettings(next);
  }, []);

  // ---------------- speech synthesis ----------------
  const speakOne = (text: string) => {
    const s = sRef.current;
    const gen = sp.current.gen;
    const lang = s.autoLang ? detectLanguage(text, s.lang.startsWith("ta") || s.lang.startsWith("hi") ? "en-GB" : s.lang) : s.lang;
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(window.speechSynthesis.getVoices(), s, lang);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
    u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume;
    sp.current.speaking = true;
    sp.current.current = text;
    u.onstart = () => {
      if (gen === sp.current.gen && !sp.current.reported && sp.current.t0) {
        sp.current.reported = true;
        const ms = Math.round(performance.now() - sp.current.t0);
        setMetrics((x) => ({ ...x, lastLatencyMs: ms }));
        metric("voice.latency_ms", ms);
      }
    };
    const done = () => {
      if (gen !== sp.current.gen) return;
      sp.current.speaking = false;
      sp.current.recent = [...sp.current.recent.slice(-2), text];
      setTimeout(() => { if (gen === sp.current.gen) (fns.current.pump as () => void)(); }, sRef.current.pauseMs);
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  };

  fns.current.pump = () => {
    if (sp.current.speaking) return;
    const next = sp.current.queue.shift();
    if (next) speakOne(next);
    else (fns.current.maybeFinish as () => void)();
  };

  fns.current.maybeFinish = () => {
    const s = sp.current;
    if (s.ended && !s.speaking && s.queue.length === 0) {
      s.ended = false;
      const st = mRef.current.state;
      if (st === "SPEAKING" || st === "UNDERSTANDING" || st === "THINKING" || st === "EXECUTING") fire("RESPONSE_END");
      lastSpeechAt.current = Date.now();
    }
  };

  const enqueue = (sentence: string) => {
    const clean = cleanForSpeech(sentence, sRef.current.pronunciations);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    sp.current.queue.push(clean);
    if (!sp.current.started) {
      sp.current.started = true;
      const st = mRef.current.state;
      if (st === "UNDERSTANDING" || st === "THINKING" || st === "EXECUTING") fire("RESPONSE_START");
    }
    (fns.current.pump as () => void)();
  };

  const speaker = {
    begin: (t0: number) => {
      sp.current.gen++;
      Object.assign(sp.current, { queue: [], speaking: false, ended: false, started: false, buffer: "", t0, reported: false });
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    push: (text: string) => {
      sp.current.buffer += text;
      const { sentences, rest } = splitSentences(sp.current.buffer);
      sp.current.buffer = rest;
      sentences.forEach(enqueue);
    },
    end: () => {
      if (sp.current.buffer.trim()) enqueue(sp.current.buffer);
      sp.current.buffer = "";
      sp.current.ended = true;
      (fns.current.maybeFinish as () => void)();
    },
    cancel: () => {
      sp.current.gen++;
      Object.assign(sp.current, { queue: [], speaking: false, ended: false, started: false, buffer: "" });
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    },
  };

  const shouldSpeak = (viaVoice: boolean) => supported.synthesis && sRef.current.speakReplies && (viaVoice || sRef.current.speakTyped || mRef.current.sessionActive);

  const testVoice = useCallback((text?: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const s = sRef.current;
    const t = cleanForSpeech(text ?? "Good evening. All systems are nominal. How may I assist you?", s.pronunciations);
    const u = new SpeechSynthesisUtterance(t);
    const v = pickVoice(window.speechSynthesis.getVoices(), s, detectLanguage(t, s.lang));
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = s.rate; u.pitch = s.pitch; u.volume = s.volume;
    window.speechSynthesis.speak(u);
  }, []);

  // ---------------- microphone ----------------
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === "audioinput"));
    } catch { /* ignore */ }
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    stream.current = null;
    analyser.current = null;
    actx.current?.close().catch(() => undefined);
    actx.current = null;
    setLevel(0);
    setMic((x) => ({ ...x, active: false, trackState: "stopped" }));
  }, []);

  fns.current.startMic = async () => {
    if (stream.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMic((x) => ({ ...x, error: "Microphone API unavailable - the page must be served over HTTPS or localhost" }));
      fire("ERROR", "microphone API unavailable");
      return false;
    }
    try {
      const id = sRef.current.deviceId;
      const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      stream.current = st;
      const track = st.getAudioTracks()[0];
      const ts = track.getSettings();
      track.onended = () => (fns.current.micLost as (r: string) => void)("microphone disconnected");
      const Ctx = window.AudioContext ?? (window as W).webkitAudioContext!;
      const ctx = new Ctx();
      actx.current = ctx;
      const src = ctx.createMediaStreamSource(st);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      analyser.current = an;
      setMic((x) => ({ ...x, permission: "granted", active: true, label: track.label, trackState: track.readyState, echoCancellation: ts.echoCancellation, noiseSuppression: ts.noiseSuppression, error: "" }));
      refreshDevices();
      (fns.current.levelLoop as () => void)();
      return true;
    } catch (e) {
      const err = e as DOMException;
      const denied = err.name === "NotAllowedError" || err.name === "SecurityError";
      setMic((x) => ({ ...x, permission: denied ? "denied" : x.permission, active: false, error: `${err.name}: ${err.message}` }));
      fire("ERROR", denied ? "microphone permission denied" : `microphone error: ${err.name}`);
      metric("voice.error", 1);
      return false;
    }
  };

  fns.current.levelLoop = () => {
    const buf = new Uint8Array(512);
    let floor = 0.01, voiceSince = 0, lastLoud = 0, transcribingSince = 0, shown = 0;
    const tick = () => {
      const an = analyser.current;
      if (!an) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      if (rms < floor * 1.5 + 0.01) floor = floor * 0.97 + rms * 0.03;
      const loud = rms > floor * 2.2 + 0.015;
      const now = performance.now();
      const st = mRef.current.state;
      if (loud) { if (!voiceSince) voiceSince = now; lastLoud = now; lastSpeechAt.current = Date.now(); } else voiceSince = 0;
      if (loud && voiceSince && now - voiceSince > 220 && st === "LISTENING") fire("SPEECH_START");
      if (st === "RECORDING" && lastLoud && now - lastLoud > 1000) { fire("SPEECH_END"); transcribingSince = now; }
      if (st === "TRANSCRIBING") { if (!transcribingSince) transcribingSince = now; if (now - transcribingSince > 7000) { fire("TRANSCRIPT_EMPTY"); transcribingSince = 0; setInterim(""); } } else transcribingSince = 0;
      const lv = Math.min(1, Math.max(0, (rms - floor) * 9));
      if (Math.abs(lv - shown) > 0.03) { shown = lv; setLevel(lv); }
      raf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  };

  fns.current.micLost = (reason: string) => {
    setMic((x) => ({ ...x, active: false, trackState: "ended", error: reason }));
    fire("ERROR", reason);
    metric("voice.error", 1);
    (fns.current.scheduleRecover as () => void)();
  };

  fns.current.scheduleRecover = () => {
    if (recoverTimer.current || !want.current) return;
    const attempt = mRef.current.history.filter((h) => h.event === "RECOVER").length;
    setMic((x) => ({ ...x, recoveries: x.recoveries + 1 }));
    if (attempt >= 3) return;
    recoverTimer.current = setTimeout(async () => {
      recoverTimer.current = null;
      stopMic();
      const ok = await (fns.current.startMic as () => Promise<boolean>)();
      if (ok) {
        fire("RECOVER");
        (fns.current.startRec as () => void)();
      } else if (want.current && mRef.current.state === "ERROR") (fns.current.scheduleRecover as () => void)();
    }, 2000);
  };

  // ---------------- recognition ----------------
  const bargeIn = (reason: string) => {
    if (mRef.current.state !== "SPEAKING") return false;
    speaker.cancel();
    fire("BARGE_IN", reason);
    setMetrics((x) => ({ ...x, bargeIns: x.bargeIns + 1 }));
    metric("voice.barge_in", 1);
    cbRef.current.onBargeIn();
    fire("INTERRUPT_HANDLED");
    return true;
  };

  const isEcho = (heard: string) => {
    const hw = words(heard);
    if (hw.length < 2) return false;
    const spoken = new Set(words([sp.current.current, ...sp.current.recent].join(" ")));
    return hw.filter((w) => spoken.has(w)).length / hw.length >= 0.6;
  };

  const dispatchUtterance = (text: string, confidence: number) => {
    const st = mRef.current.state;
    if (st === "RECORDING") fire("SPEECH_END");
    fire("TRANSCRIPT_FINAL");
    setInterim("");
    setLastHeard({ text, confidence });
    setMetrics((x) => ({ ...x, lastConfidence: confidence }));
    if (confidence > 0) metric("voice.confidence", confidence);
    utteranceAt.current = performance.now();
    lastSpeechAt.current = Date.now();
    cbRef.current.onUtterance(text, { confidence, at: utteranceAt.current });
  };

  const handleResult = (e: SREvent) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const alt = r[0];
      const raw = (alt?.transcript ?? "").trim();
      if (!raw) continue;
      lastSpeechAt.current = Date.now();
      let st = mRef.current.state;

      if (st === "SPEAKING") {
        if (!sRef.current.bargeIn) continue;
        const w = words(raw);
        const isCmd = w.length === 1 && COMMAND_WORDS.test(w[0]);
        if ((w.length >= 2 && !isEcho(raw)) || isCmd) {
          bargeIn(isCmd ? "command word" : "speech detected");
          if (r.isFinal && !isCmd) dispatchUtterance(raw, alt.confidence ?? 0);
          else if (!isCmd) fire("SPEECH_START");
        }
        continue;
      }
      if (st === "UNDERSTANDING" || st === "THINKING" || st === "EXECUTING") {
        if (r.isFinal && words(raw).length === 1 && COMMAND_WORDS.test(words(raw)[0])) { cbRef.current.onBargeIn(); speaker.cancel(); fire("STOP"); fire("SESSION_START"); }
        continue;
      }

      const wake = matchWake(raw, sRef.current);
      if (st === "IDLE" || st === "OFFLINE") {
        if (!wake) continue;
        const key = `${i}:${raw.slice(0, 12)}`;
        if (wakeFired.current !== key) {
          wakeFired.current = key;
          fire("WAKE_DETECTED");
          setMetrics((x) => ({ ...x, wakes: x.wakes + 1 }));
          metric("voice.wake", 1);
          chime();
        }
        st = mRef.current.state;
        if (st === "WAKE_WORD_DETECTED" && !(r.isFinal && wake.rest)) fire("SESSION_READY");
        st = mRef.current.state;
      } else if (st === "LISTENING" && wake && !wake.rest && !r.isFinal) {
        continue;
      }

      const text = (wake ? wake.rest : raw).trim();
      if (!r.isFinal) {
        if (text) {
          setInterim(text);
          if (mRef.current.state === "LISTENING") fire("SPEECH_START");
        }
        continue;
      }
      if (!text) {
        const s2 = mRef.current.state;
        if (s2 === "RECORDING" || s2 === "TRANSCRIBING") fire("TRANSCRIPT_EMPTY");
        setInterim("");
        continue;
      }
      dispatchUtterance(text, alt.confidence ?? 0);
    }
  };

  fns.current.startRec = () => {
    const w = window as W;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) { fire("ERROR", "SpeechRecognition is not supported by this browser (use Chrome or Edge)"); return; }
    try { rec.current?.abort(); } catch { /* ignore */ }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.lang = sRef.current.lang;
    if (sRef.current.preferOnDevice || forceLocal.current) { try { r.processLocally = true; } catch { /* unsupported */ } }
    r.onstart = () => { if (forceLocal.current) setOfflineVoice("on-device active"); };
    r.onresult = handleResult;
    r.onerror = (ev) => {
      const code = ev.error;
      if (code === "no-speech" || code === "aborted") return;
      if (code === "not-allowed" || code === "service-not-allowed") {
        want.current = false; setActive(false);
        setMic((x) => ({ ...x, permission: "denied", error: "Speech recognition permission denied" }));
        fire("ERROR", "microphone / speech permission denied");
        metric("voice.error", 1);
      } else if (code === "audio-capture") {
        fire("ERROR", "no microphone available");
        metric("voice.error", 1);
        (fns.current.scheduleRecover as () => void)();
      } else if (code === "network") {
        fire("NETWORK_LOST");
        if (supported.onDevice) { forceLocal.current = true; }
      } else if (code === "language-not-supported") {
        setOfflineVoice("on-device unavailable");
        forceLocal.current = false;
        fire("NETWORK_LOST");
      }
    };
    r.onend = () => {
      if (!want.current) return;
      const now = Date.now();
      restartTimes.current = [...restartTimes.current.filter((t) => now - t < 10_000), now];
      setMetrics((x) => ({ ...x, restarts: x.restarts + 1 }));
      const delay = restartTimes.current.length > 8 ? 3000 : mRef.current.state === "ERROR" ? 1500 : 250;
      setTimeout(() => { if (want.current && mRef.current.state !== "ERROR") (fns.current.startRec as () => void)(); }, delay);
    };
    rec.current = r;
    try { r.start(); } catch { /* already started */ }
  };

  const chime = () => {
    try {
      const ctx = actx.current ?? new (window.AudioContext ?? (window as W).webkitAudioContext!)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(660, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.22);
    } catch { /* audio blocked */ }
  };

  // ---------------- public controls ----------------
  const begin = async (wake: boolean) => {
    if (want.current) { wakeMode.current = wake || wakeMode.current; if (!wake) { fire("SESSION_START"); lastSpeechAt.current = Date.now(); } return; }
    const ok = await (fns.current.startMic as () => Promise<boolean>)();
    if (!ok) return;
    want.current = true;
    wakeMode.current = wake;
    setActive(true);
    if (mRef.current.state === "ERROR") fire("RECOVER");
    if (!wake) fire("SESSION_START");
    lastSpeechAt.current = Date.now();
    (fns.current.startRec as () => void)();
  };

  const stop = useCallback(() => {
    want.current = false;
    wakeMode.current = false;
    forceLocal.current = false;
    setActive(false);
    setInterim("");
    try { rec.current?.abort(); } catch { /* ignore */ }
    rec.current = null;
    speaker.cancel();
    fire("STOP");
    stopMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWake = useCallback(() => begin(true), []); // eslint-disable-line react-hooks/exhaustive-deps
  const startTalk = useCallback(() => begin(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- lifecycle ----------------
  useEffect(() => {
    const w = window as W;
    const loaded = loadVoiceSettings();
    sRef.current = loaded;
    setSettingsState(loaded);
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    setSupported({
      recognition: !!SR, synthesis: "speechSynthesis" in window, media: !!navigator.mediaDevices?.getUserMedia,
      audioContext: !!(window.AudioContext ?? w.webkitAudioContext), secure: window.isSecureContext, onDevice: !!SR && "processLocally" in SR.prototype,
    });
    setOnline(navigator.onLine);
    if (!navigator.onLine) fire("NETWORK_LOST");
    const loadVoices = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    loadVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadVoices);
    const goOffline = () => { setOnline(false); fire("NETWORK_LOST"); if (want.current && "processLocally" in (SR?.prototype ?? {})) { forceLocal.current = true; (fns.current.startRec as () => void)(); } };
    const goOnline = () => { setOnline(true); forceLocal.current = false; setOfflineVoice("n/a"); fire("NETWORK_RESTORED"); if (want.current) (fns.current.startRec as () => void)(); };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    const onDev = () => refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDev);
    navigator.permissions?.query({ name: "microphone" as PermissionName }).then((p) => {
      setMic((x) => ({ ...x, permission: p.state }));
      p.onchange = () => setMic((x) => ({ ...x, permission: p.state }));
    }).catch(() => undefined);
    refreshDevices();
    const timer = setInterval(() => {
      const mm = mRef.current;
      if (mm.state === "LISTENING" && mm.sessionActive && Date.now() - lastSpeechAt.current > sRef.current.silenceTimeoutSec * 1000) {
        fire("SILENCE_TIMEOUT");
        setInterim("");
        if (!wakeMode.current) {
          want.current = false; setActive(false);
          try { rec.current?.abort(); } catch { /* ignore */ }
          stopMic();
        }
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDev);
      window.speechSynthesis?.removeEventListener?.("voiceschanged", loadVoices);
      want.current = false;
      try { rec.current?.abort(); } catch { /* ignore */ }
      window.speechSynthesis?.cancel();
      stopMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selfTest = useCallback(async (): Promise<SelfTestItem[]> => {
    const w = window as W;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    const items: SelfTestItem[] = [];
    items.push({ name: "Secure context (HTTPS/localhost)", ok: window.isSecureContext, detail: window.isSecureContext ? "microphone access allowed" : "getUserMedia is blocked on insecure origins" });
    items.push({ name: "Speech recognition API", ok: !!SR, detail: SR ? (w.SpeechRecognition ? "SpeechRecognition" : "webkitSpeechRecognition") : "not available - use Chrome or Edge" });
    items.push({ name: "On-device recognition", ok: !!SR && "processLocally" in SR.prototype, detail: SR && "processLocally" in SR.prototype ? "supported (offline wake word possible once the language pack is installed)" : "not supported by this browser - recognition needs the internet" });
    items.push({ name: "Speech synthesis API", ok: "speechSynthesis" in window, detail: `${voices.length} voice(s) installed` });
    const local = voices.filter((v) => v.localService);
    items.push({ name: "Offline text-to-speech", ok: local.length > 0, detail: local.length ? `${local.length} local voice(s), e.g. ${local[0].name}` : "no local voices: speech needs the internet" });
    const neural = voices.filter((v) => /natural|neural|online/i.test(v.name));
    items.push({ name: "Neural voices", ok: neural.length > 0, detail: neural.length ? neural.slice(0, 3).map((v) => v.name).join(", ") : "none detected (standard voices will be used)" });
    items.push({ name: "Microphone API", ok: !!navigator.mediaDevices?.getUserMedia, detail: `${devices.length} input device(s) listed` });
    items.push({ name: "AudioContext (level/VAD)", ok: !!(window.AudioContext ?? w.webkitAudioContext), detail: "used for level metering and voice activity detection" });
    items.push({ name: "Echo cancellation", ok: mic.active ? mic.echoCancellation ?? null : null, detail: mic.active ? `echoCancellation=${String(mic.echoCancellation)}, noiseSuppression=${String(mic.noiseSuppression)}` : "start listening to verify" });
    try {
      const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
      items.push({ name: "Microphone permission", ok: p.state === "granted" ? true : p.state === "denied" ? false : null, detail: p.state });
    } catch { items.push({ name: "Microphone permission", ok: null, detail: "permission query unsupported" }); }
    items.push({ name: "Network", ok: navigator.onLine, detail: navigator.onLine ? "online" : "offline" });
    return items;
  }, [voices, devices, mic]);

  return { state: m.state, machine: m, level, interim, lastHeard, settings, setSettings, supported, voices, devices, mic, online, offlineVoice, active, metrics, fire, speaker, shouldSpeak, startWake, startTalk, stop, testVoice, selfTest, mark: (t: number) => { utteranceAt.current = t; } };
}
