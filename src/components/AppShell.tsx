"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { TABS, useBrahma } from "@/components/BrahmaProvider";
import { Badge, Btn, Dot, riskTone, useApi } from "@/components/ui";
import { stateColor, stateLabel } from "@/components/VoiceOrb";
import { ConsoleView } from "@/components/views/ConsoleView";
import { VoiceView } from "@/components/views/VoiceView";
import { SkillsView } from "@/components/views/SkillsView";
import { MemoryView } from "@/components/views/MemoryView";
import { AgentsView } from "@/components/views/AgentsView";
import { ResearchView } from "@/components/views/ResearchView";
import { ProjectsView } from "@/components/views/ProjectsView";
import { MonitorView } from "@/components/views/MonitorView";
import { SettingsView } from "@/components/views/SettingsView";

function ApprovalCard({ a }: { a: any }) {
  const { decide } = useBrahma();
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (d: "approve" | "deny") => {
    setBusy(true);
    setErr("");
    try { await decide(a.id, d, confirm); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="fade-up rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-slate-300">{a.tool}</span>
        <Badge tone={riskTone(a.risk)}>{a.risk}</Badge>
      </div>
      <p className="mt-1.5 text-slate-200">{a.summary}</p>
      <p className="mt-1 text-[10px] text-slate-500">Single-use, bound to these exact arguments, expires {new Date(a.expiresAt).toLocaleTimeString()}.</p>
      {a.risk === "CRITICAL" && <input className="field mt-2" placeholder='Type CONFIRM to enable approval' value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      {err && <p className="mt-1 text-rose-300">{err}</p>}
      <div className="mt-2 flex gap-2">
        <Btn variant="primary" disabled={busy || (a.risk === "CRITICAL" && confirm !== "CONFIRM")} onClick={() => act("approve")}>Approve</Btn>
        <Btn variant="danger" disabled={busy} onClick={() => act("deny")}>Deny</Btn>
      </div>
    </div>
  );
}

export function ApprovalTray() {
  const { approvals } = useBrahma();
  const pending = approvals.filter((a) => a.status === "pending");
  const [open, setOpen] = useState(false);
  if (pending.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-[340px] max-w-[92vw]">
      {open && <div className="panel mb-2 max-h-[60vh] space-y-2 overflow-auto p-3">{pending.map((a) => <ApprovalCard key={a.id} a={a} />)}</div>}
      <Btn variant="primary" className="w-full !py-2" onClick={() => setOpen(!open)}>⚠ {pending.length} action{pending.length > 1 ? "s" : ""} awaiting your approval</Btn>
    </div>
  );
}

export { ApprovalCard };

export function AppShell() {
  const { tab, setTab, voice, busy, stage } = useBrahma();
  const { data: models } = useApi<any>("/api/models", 45000);
  const up = (models?.providers ?? []).filter((p: any) => p.reachable);
  const [nav, setNav] = useState(false);
  const { data: auth } = useApi<any>("/api/auth", 0);
  const [hideWarn, setHideWarn] = useState(false);
  const color = stateColor(voice.state);
  return (
    <div className="relative z-10 flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-30 w-56 shrink-0 border-r border-cyan-400/10 bg-[#030813]/95 backdrop-blur transition-transform md:static md:translate-x-0 ${nav ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="px-5 pb-4 pt-5">
          <div className="glow text-lg font-bold tracking-[0.28em] text-cyan-200">JARVIS</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.32em] text-slate-500">BRAHMA · adaptive intelligence</div>
        </div>
        <nav className="space-y-0.5 px-2">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => { setTab(t.id); setNav(false); }} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition ${tab === t.id ? "bg-cyan-400/15 text-cyan-100 shadow-[inset_2px_0_0_#22d3ee]" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}>
              <span className="w-4 text-center text-base text-cyan-300/80">{t.glyph}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="absolute inset-x-3 bottom-4 rounded-lg border border-cyan-400/10 bg-black/30 p-3 text-[11px]">
          <div className="flex items-center justify-between"><span className="text-slate-500">Voice</span><span className="font-semibold" style={{ color }}>{stateLabel(voice.state)}</span></div>
          <div className="mt-1 flex items-center justify-between"><span className="text-slate-500">Models</span><span className={up.length ? "text-emerald-300" : "text-amber-300"}>{up.length ? `${up.length} online` : "none online"}</span></div>
          <div className="mt-1 flex items-center justify-between"><span className="text-slate-500">Network</span><span className={voice.online ? "text-emerald-300" : "text-amber-300"}>{voice.online ? "online" : "offline"}</span></div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-cyan-400/10 bg-[#030813]/80 px-4 py-2.5 backdrop-blur">
          <button className="rounded-md border border-cyan-400/20 px-2 py-1 text-cyan-200 md:hidden" onClick={() => setNav(!nav)} aria-label="Menu">☰</button>
          <h1 className="text-sm font-semibold tracking-wide text-slate-200">{TABS.find((t) => t.id === tab)?.label}</h1>
          <div className="ml-auto flex items-center gap-2">
            {busy && <Badge tone="amber"><span className="blink">●</span> {stage || "working"}</Badge>}
            <button onClick={() => setTab("voice")} title="Open voice controls">
              <Badge tone={voice.state === "ERROR" ? "red" : voice.state === "OFFLINE" ? "slate" : "cyan"}><span style={{ color }}>●</span> {stateLabel(voice.state)}</Badge>
            </button>
            <span className="hidden items-center gap-1.5 text-[11px] text-slate-400 sm:flex"><Dot ok={up.length > 0} /> {up.length ? up.map((p: any) => p.label.split(" ")[0]).join(", ") : "no model"}</span>
          </div>
        </header>
        {auth && auth.protected === false && !hideWarn && (
          <div className="flex items-start justify-between gap-3 border-b border-amber-400/20 bg-amber-400/5 px-4 py-1.5 text-[11px] text-amber-200/90">
            <span>⚠ Open access: this console has no login, so anyone who can reach this URL can use it, change permissions and approve actions. Set the <span className="mono">BRAHMA_ACCESS_KEY</span> environment variable to lock it.</span>
            <button className="shrink-0 text-amber-300 underline" onClick={() => setHideWarn(true)}>dismiss</button>
          </div>
        )}
        <main className="min-w-0 flex-1 p-4 md:p-6">
          {tab === "console" && <ConsoleView />}
          {tab === "voice" && <VoiceView />}
          {tab === "skills" && <SkillsView />}
          {tab === "memory" && <MemoryView />}
          {tab === "agents" && <AgentsView />}
          {tab === "research" && <ResearchView />}
          {tab === "projects" && <ProjectsView />}
          {tab === "monitor" && <MonitorView />}
          {tab === "settings" && <SettingsView />}
        </main>
      </div>
      <ApprovalTray />
    </div>
  );
}
