"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { useBrahma, type Msg } from "@/components/BrahmaProvider";
import { ApprovalCard } from "@/components/AppShell";
import { Badge, Btn, Empty, Panel, ago, riskTone } from "@/components/ui";
import { stateColor, stateLabel } from "@/components/VoiceOrb";

const QUICK = [
  "what can you do?", "calculate 12*(3+4)^2", "convert 5 km to mi", "remember that I prefer green tea in the morning", "what do you remember about tea",
  "list skills", "system status", "cpu usage", "security audit", "research quantum error correction", "audit skill math.evaluate",
  "learn how to count vowels in a sentence", "create folder notes", "create file notes/todo.txt: buy milk", "delete file notes/todo.txt", "self-evaluate",
];

function Bubble({ m }: { m: Msg }) {
  const { setTab } = useBrahma();
  if (m.role === "system") return <div className="fade-up mx-auto max-w-[90%] rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-100/90">{m.content}</div>;
  const mine = m.role === "user";
  return (
    <div className={`fade-up flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[88%] rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed ${mine ? "border-blue-400/30 bg-blue-500/10 text-slate-100" : "border-cyan-400/15 bg-black/30 text-slate-200"}`}>
        {!mine && (m.intent || m.engine) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {m.engine && <Badge tone="violet">{m.engine}</Badge>}
            {m.intent && <Badge tone="slate">{m.intent.replace("_", " ")}</Badge>}
            {m.meta?.model && <Badge tone="cyan" title={`${m.meta.tokens ?? "?"} tokens`}>{m.meta.model}</Badge>}
            {m.meta?.skill && <Badge tone="green">skill {m.meta.skill.slug} · {m.meta.skill.status}</Badge>}
            {m.meta?.latencyMs != null && <span className="mono text-[10px] text-slate-500">{m.meta.latencyMs} ms</span>}
          </div>
        )}
        {mine && m.voice && <div className="mb-1 text-[10px] uppercase tracking-widest text-cyan-300/70">🎙 voice</div>}
        <div className="whitespace-pre-wrap break-words">{m.content || (m.streaming ? <span className="blink text-cyan-300">▍</span> : "")}{m.streaming && m.content && <span className="blink text-cyan-300"> ▍</span>}</div>
        {!!m.tools?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.tools.filter((t, i, a) => a.findIndex((x) => x.name === t.name && x.status === t.status) === i).map((t, i) => (
              <span key={i} className="mono rounded border border-cyan-400/15 px-1.5 py-0.5 text-[10px] text-slate-400" title={t.detail}>⚙ {t.name} → <span className={t.status === "ok" ? "text-emerald-300" : t.status === "running" ? "text-amber-300" : "text-rose-300"}>{t.status}</span></span>
            ))}
          </div>
        )}
        {m.data?.map((d, i) => (
          <div key={i} className="mt-2 text-[11px]">
            {d.kind === "acquisition" && <button className="text-cyan-300 underline" onClick={() => setTab("skills")}>Open skill acquisition →</button>}
            {d.kind === "agent_run" && <button className="text-cyan-300 underline" onClick={() => setTab("agents")}>Open agent run →</button>}
            {d.kind === "research" && <button className="text-cyan-300 underline" onClick={() => setTab("research")}>Open research sources →</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConsoleView() {
  const { messages, send, busy, stage, stopGeneration, conversations, conversationId, loadConversation, newConversation, approvals, tools, voice } = useBrahma();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);
  const submit = () => { if (text.trim()) { void send(text); setText(""); } };
  const pending = approvals.filter((a) => a.status === "pending");
  const running = tools.find((t) => t.status === "running" && Date.now() - t.ts < 60_000);
  const listening = ["LISTENING", "RECORDING", "WAKE_WORD_DETECTED", "TRANSCRIBING"].includes(voice.state);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Panel pad={false} className="flex h-[calc(100vh-130px)] min-h-[520px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-cyan-400/10 px-4 py-2 text-[11px]">
          <span className="flex items-center gap-1.5 text-slate-400"><span className={listening ? "blink" : ""} style={{ color: stateColor(voice.state) }}>●</span>{listening ? "Listening" : stateLabel(voice.state)}</span>
          {busy && <Badge tone="amber"><span className="blink">●</span> Thinking · {stage || "working"}</Badge>}
          {running && <Badge tone="violet">Executing {running.name}</Badge>}
          {voice.interim && <span className="truncate italic text-cyan-200/80">“{voice.interim}”</span>}
          <span className="ml-auto text-slate-500">{conversationId ? `conversation ${conversationId.slice(0, 8)}` : "new conversation"}</span>
        </div>
        <div className="relative flex-1 space-y-3 overflow-auto p-4">
          {messages.length === 0 && (
            <div className="relative mx-auto mt-2 max-w-xl text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/jarvis-core.jpg" alt="" className="mx-auto h-56 w-full rounded-xl object-cover opacity-80 [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_75%)]" />
              <h2 className="glow -mt-6 text-xl font-semibold tracking-wide text-cyan-100">Good day. How may I assist?</h2>
              <p className="mt-2 text-xs text-slate-400">Type below, or open the Voice tab and say “Hey JARVIS”. Everything listed here is a real command.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {QUICK.map((q) => <button key={q} onClick={() => send(q)} className="rounded-full border border-cyan-400/20 px-2.5 py-1 text-[11px] text-slate-300 hover:border-cyan-300/60 hover:text-cyan-100">{q}</button>)}
              </div>
            </div>
          )}
          {messages.map((m) => <Bubble key={m.id} m={m} />)}
          {pending.map((a) => <ApprovalCard key={a.id} a={a} />)}
          <div ref={end} />
        </div>
        <div className="border-t border-cyan-400/10 p-3">
          <div className="flex items-end gap-2">
            <textarea className="field min-h-[44px] resize-none" rows={2} placeholder="Ask, command or say 'learn how to …'  (Enter to send, Shift+Enter for newline)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
            <div className="flex flex-col gap-1.5">
              <Btn variant="primary" onClick={submit} disabled={!text.trim()}>Send</Btn>
              {busy ? <Btn variant="danger" onClick={stopGeneration}>Stop</Btn> : <Btn onClick={() => (voice.active ? voice.stop() : voice.startTalk())} title="Start / stop voice conversation">{voice.active ? "◼ Mic off" : "🎙 Talk"}</Btn>}
            </div>
          </div>
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel title="Tool activity" sub="Permission-gated; every call is audited">
          {tools.length === 0 ? <Empty>No tool calls yet.</Empty> : (
            <ul className="max-h-56 space-y-1.5 overflow-auto">
              {tools.slice(0, 14).map((t, i) => (
                <li key={i} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="mono text-slate-300">{t.name}</span>
                  <span className="flex items-center gap-1.5">{t.risk !== "-" && <Badge tone={riskTone(t.risk)}>{t.risk}</Badge>}<span className={t.status === "ok" ? "text-emerald-300" : t.status === "running" ? "text-amber-300" : "text-rose-300"}>{t.status}</span><span className="text-slate-600">{ago(new Date(t.ts))}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Conversations" right={<Btn onClick={newConversation}>+ New</Btn>}>
          {conversations.length === 0 ? <Empty>History appears here.</Empty> : (
            <ul className="max-h-72 space-y-1 overflow-auto">
              {conversations.map((c) => (
                <li key={c.id}><button onClick={() => loadConversation(c.id)} className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs ${c.id === conversationId ? "bg-cyan-400/15 text-cyan-100" : "text-slate-400 hover:bg-white/5"}`}>{c.title}<span className="ml-2 text-[10px] text-slate-600">{ago(c.updatedAt)}</span></button></li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-slate-600">Secrets in messages are redacted before storage. Conversations are not written to memory automatically.</p>
        </Panel>
      </div>
    </div>
  );
}
