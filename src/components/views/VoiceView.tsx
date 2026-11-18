"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { useBrahma } from "@/components/BrahmaProvider";
import { Badge, Btn, Dot, Field, Notice, Panel, Toggle } from "@/components/ui";
import { VoiceOrb, stateColor, stateLabel } from "@/components/VoiceOrb";
import { PERSONALITY_INFO, DEFAULT_VOICE, wakePhrases, type Personality } from "@/lib/voice/profiles";
import { LANGUAGES } from "@/lib/languages";
import { VOICE_STATES } from "@/lib/voice/machine";
import type { SelfTestItem } from "@/lib/voice/useVoice";

export function VoiceView() {
  const { voice: v, messages } = useBrahma();
  const s = v.settings;
  const [test, setTest] = useState<SelfTestItem[] | null>(null);
  const [pron, setPron] = useState<string | null>(null);
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  const personality = (p: Personality) => {
    const i = PERSONALITY_INFO[p];
    v.setSettings({ personality: p, rate: i.rate, pitch: i.pitch, voiceURI: p === "CUSTOM" ? s.voiceURI : "", lang: p === "JARVIS" || p === "FRIDAY" ? (s.lang.startsWith("en") ? s.lang : "en-GB") : s.lang });
  };
  const sorted = [...v.voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const offline = !v.online;
  const pronText = pron ?? Object.entries(s.pronunciations).map(([k, val]) => `${k}=${val}`).join("\n");

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel pad={false} className="overflow-hidden">
          <div className="relative flex flex-col items-center px-4 pb-6 pt-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/jarvis-core.jpg" alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_72%)]" />
            <div className="relative">
              <VoiceOrb state={v.state} level={v.level} size={340} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <div className="glow text-lg font-semibold tracking-[0.3em]" style={{ color: stateColor(v.state) }}>{stateLabel(v.state).toUpperCase()}</div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-slate-400">{v.machine.sessionActive ? "session active" : v.active ? `say “${s.wakeWord}”` : "mic off"}</div>
              </div>
            </div>
            <div className="relative mt-1 flex flex-wrap justify-center gap-2">
              <Btn variant="primary" onClick={v.startWake} disabled={v.active && !v.machine.sessionActive && v.state !== "ERROR" ? false : false}>◉ Enable wake word</Btn>
              <Btn onClick={v.startTalk}>🎙 Talk now</Btn>
              <Btn variant="danger" onClick={v.stop} disabled={!v.active && v.state === "IDLE"}>◼ Stop</Btn>
              <Btn onClick={() => v.testVoice()}>▶ Test voice</Btn>
            </div>
            <div className="relative mt-4 w-full max-w-md">
              <div className="mb-1 flex justify-between text-[10px] uppercase tracking-widest text-slate-500"><span>Mic level (live)</span><span>{v.mic.active ? v.mic.label || "active" : "off"}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-[width] duration-75" style={{ width: `${Math.round(v.level * 100)}%` }} /></div>
            </div>
            <div className="relative mt-4 grid w-full max-w-xl gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg border border-cyan-400/10 bg-black/30 p-2.5"><div className="text-[10px] uppercase tracking-widest text-slate-500">Hearing</div><div className="mt-1 min-h-[2.2em] italic text-cyan-100">{v.interim || (v.lastHeard ? `“${v.lastHeard.text}”` : "—")}</div>{v.lastHeard && <div className="text-[10px] text-slate-500">confidence {(v.lastHeard.confidence * 100).toFixed(0)}%</div>}</div>
              <div className="rounded-lg border border-cyan-400/10 bg-black/30 p-2.5"><div className="text-[10px] uppercase tracking-widest text-slate-500">Last reply</div><div className="mt-1 line-clamp-3 min-h-[2.2em] text-slate-200">{lastReply?.content || "—"}</div></div>
            </div>
          </div>
        </Panel>

        {v.state === "ERROR" && <Notice tone="red"><b>Voice error:</b> {v.machine.error ?? v.mic.error}. {v.mic.recoveries > 0 && `Recovery attempts: ${v.mic.recoveries}.`} Press “Enable wake word” to retry.</Notice>}
        {offline && <Notice tone="amber"><b>Offline.</b> Browser speech recognition normally needs the internet. {v.supported.onDevice ? `On-device recognition is supported here: ${v.offlineVoice}. Install the language pack in the browser if wake word fails.` : "This browser has no on-device recognition, so voice input is unavailable offline; typed commands, memory, skills and local models still work."} Local text-to-speech: {v.voices.some((x) => x.localService) ? "available" : "no local voice installed"}.</Notice>}
        {!v.supported.secure && <Notice tone="red">Microphone access requires HTTPS or localhost. This origin is not secure.</Notice>}

        <Panel title="State machine" sub={`${v.machine.history.length} recorded transitions · ${v.machine.rejected} illegal events rejected · last event ${v.machine.lastEvent}`}>
          <div className="mb-3 flex flex-wrap gap-1">
            {VOICE_STATES.map((st) => <span key={st} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${st === v.state ? "bg-cyan-400/25 text-cyan-100 shadow-[0_0_10px_rgba(34,211,238,.35)]" : "bg-slate-800/70 text-slate-500"}`}>{st}</span>)}
          </div>
          <div className="mono max-h-40 overflow-auto text-[11px] text-slate-400">
            {[...v.machine.history].reverse().map((h, i) => <div key={i}>{new Date(h.at).toLocaleTimeString()}  {h.from} <span className="text-cyan-400">—{h.event}→</span> {h.to}</div>)}
            {v.machine.history.length === 0 && <span className="text-slate-600">No transitions yet. Every transition is caused by a real mic, recogniser, network or chat event.</span>}
          </div>
        </Panel>

        <Panel title="Voice self-test" right={<Btn onClick={async () => setTest(await v.selfTest())}>Run</Btn>} sub="Checks this browser — the only place voice can be verified">
          {!test ? <p className="text-xs text-slate-500">Run the test to see which voice capabilities this browser really provides.</p> : (
            <ul className="space-y-1.5 text-xs">
              {test.map((t) => <li key={t.name} className="flex items-start gap-2"><Dot ok={t.ok} /><span className="w-52 shrink-0 text-slate-300">{t.name}</span><span className="text-slate-500">{t.detail}</span></li>)}
            </ul>
          )}
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="Voice identity">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PERSONALITY_INFO) as Personality[]).map((p) => (
              <button key={p} onClick={() => personality(p)} className={`rounded-lg border p-2.5 text-left transition ${s.personality === p ? "border-cyan-300/70 bg-cyan-400/10" : "border-slate-700 hover:border-cyan-400/40"}`}>
                <div className="text-sm font-semibold text-slate-100">{PERSONALITY_INFO[p].label}</div>
                <div className="text-[10px] text-slate-500">{PERSONALITY_INFO[p].blurb}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-3">
            <Field label={`Voice (${v.voices.length} installed)`} hint={v.voices.length ? undefined : "No voices reported yet - some browsers load them after the first interaction."}>
              <select className="field" value={s.voiceURI} onChange={(e) => v.setSettings({ voiceURI: e.target.value, ...(e.target.value ? { personality: "CUSTOM" as Personality } : {}) })}>
                <option value="">Automatic (best match for {s.personality})</option>
                {sorted.map((x) => <option key={x.voiceURI} value={x.voiceURI}>{x.name} · {x.lang}{x.localService ? " · local" : ""}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={`Speed ${s.rate.toFixed(2)}`}><input type="range" min={0.6} max={1.5} step={0.01} value={s.rate} onChange={(e) => v.setSettings({ rate: +e.target.value })} className="w-full" /></Field>
              <Field label={`Pitch ${s.pitch.toFixed(2)}`}><input type="range" min={0.5} max={1.5} step={0.01} value={s.pitch} onChange={(e) => v.setSettings({ pitch: +e.target.value })} className="w-full" /></Field>
              <Field label={`Volume ${Math.round(s.volume * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={s.volume} onChange={(e) => v.setSettings({ volume: +e.target.value })} className="w-full" /></Field>
            </div>
            <Field label={`Pause between sentences ${s.pauseMs} ms`}><input type="range" min={0} max={600} step={20} value={s.pauseMs} onChange={(e) => v.setSettings({ pauseMs: +e.target.value })} className="w-full" /></Field>
            <p className="text-[10px] text-slate-500">Voices are the browser/OS voices (Windows 11 “Natural” and Chrome neural voices when installed). No copyrighted character voice is imitated; Piper neural TTS is not part of this web build.</p>
          </div>
        </Panel>

        <Panel title="Listening">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Wake word" hint={`Also accepted: ${wakePhrases(s).slice(0, 4).join(", ")}…`}><input className="field" value={s.wakeWord} onChange={(e) => v.setSettings({ wakeWord: e.target.value })} /></Field>
              <Field label="Recognition language">
                <select className="field" value={s.lang} onChange={(e) => v.setSettings({ lang: e.target.value })}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name} ({l.nativeName})</option>)}</select>
              </Field>
            </div>
            <Field label="Microphone for level meter / VAD" hint="Browser speech recognition always uses the system default input; this selects the monitored device.">
              <select className="field" value={s.deviceId} onChange={(e) => v.setSettings({ deviceId: e.target.value })}>
                <option value="">System default</option>
                {v.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>)}
              </select>
            </Field>
            <Field label={`Silence timeout ${s.silenceTimeoutSec}s`} hint="The session ends (and the wake word is required again) after this much silence."><input type="range" min={5} max={60} step={1} value={s.silenceTimeoutSec} onChange={(e) => v.setSettings({ silenceTimeoutSec: +e.target.value })} className="w-full" /></Field>
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle checked={s.speakReplies} onChange={(x) => v.setSettings({ speakReplies: x })} label="Speak replies" />
              <Toggle checked={s.speakTyped} onChange={(x) => v.setSettings({ speakTyped: x })} label="Also speak replies to typed messages" />
              <Toggle checked={s.bargeIn} onChange={(x) => v.setSettings({ bargeIn: x })} label="Barge-in (interrupt by speaking)" />
              <Toggle checked={s.autoLang} onChange={(x) => v.setSettings({ autoLang: x })} label="Auto-pick voice language from reply script" />
              <Toggle checked={s.preferOnDevice} onChange={(x) => v.setSettings({ preferOnDevice: x })} disabled={!v.supported.onDevice} label={`Prefer on-device recognition${v.supported.onDevice ? "" : " (unsupported here)"}`} />
            </div>
          </div>
        </Panel>

        <Panel title="Pronunciation" right={<Btn onClick={() => { v.setSettings({ pronunciations: DEFAULT_VOICE.pronunciations }); setPron(null); }}>Reset</Btn>} sub="word=how it should be spoken (one per line)">
          <textarea className="field mono h-28" value={pronText} onChange={(e) => { setPron(e.target.value); const m: Record<string, string> = {}; e.target.value.split("\n").forEach((l) => { const [k, ...r] = l.split("="); if (k?.trim() && r.length) m[k.trim()] = r.join("=").trim(); }); v.setSettings({ pronunciations: m }); }} />
        </Panel>

        <Panel title="Live diagnostics">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {[
              ["Microphone", v.mic.active ? "active" : "off", v.mic.active],
              ["Permission", v.mic.permission, v.mic.permission === "granted" ? true : v.mic.permission === "denied" ? false : null],
              ["Echo cancellation", String(v.mic.echoCancellation ?? "n/a"), v.mic.echoCancellation ?? null],
              ["Noise suppression", String(v.mic.noiseSuppression ?? "n/a"), v.mic.noiseSuppression ?? null],
              ["Recognition API", v.supported.recognition ? "available" : "missing", v.supported.recognition],
              ["Speech synthesis", v.supported.synthesis ? `${v.voices.length} voices` : "missing", v.supported.synthesis],
              ["Network", v.online ? "online" : "offline", v.online],
              ["Offline recognition", v.offlineVoice, v.offlineVoice === "on-device active" ? true : v.offlineVoice === "n/a" ? null : false],
            ].map(([k, val, ok]) => <div key={String(k)} className="flex items-center justify-between gap-2"><dt className="flex items-center gap-1.5 text-slate-500"><Dot ok={ok as boolean | null} />{k}</dt><dd className="mono text-slate-300">{String(val)}</dd></div>)}
          </dl>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <Badge tone="cyan">last latency {v.metrics.lastLatencyMs ?? "—"} ms</Badge>
            <Badge tone="cyan">confidence {v.metrics.lastConfidence != null ? Math.round(v.metrics.lastConfidence * 100) + "%" : "—"}</Badge>
            <Badge tone="slate">wakes {v.metrics.wakes}</Badge><Badge tone="slate">barge-ins {v.metrics.bargeIns}</Badge><Badge tone="slate">recognizer restarts {v.metrics.restarts}</Badge>
          </div>
          {v.mic.error && <p className="mt-2 text-[11px] text-rose-300">{v.mic.error}</p>}
        </Panel>
      </div>
    </div>
  );
}
