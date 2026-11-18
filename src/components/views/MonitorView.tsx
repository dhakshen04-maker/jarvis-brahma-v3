"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { useBrahma } from "@/components/BrahmaProvider";
import { Badge, Bar, Btn, Dot, Empty, Notice, Panel, Stat, Tabs, ago, api, riskTone, statusTone, useApi } from "@/components/ui";

function Spark({ data, color = "#22d3ee" }: { data: number[]; color?: string }) {
  if (data.length < 2) return <div className="h-10 text-[10px] text-slate-600">collecting…</div>;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${100 - Math.min(100, Math.max(0, v))}`).join(" ");
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-10 w-full"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function Live() {
  const { voice: v } = useBrahma();
  const { data } = useApi<any>("/api/monitor", 3000);
  const [hist, setHist] = useState<{ cpu: number[]; ram: number[] }>({ cpu: [], ram: [] });
  useEffect(() => { if (data) setHist((h) => ({ cpu: [...h.cpu.slice(-59), data.resources.cpuPercent], ram: [...h.ram.slice(-59), data.resources.ramPercent] })); }, [data]);
  if (!data) return <Empty>Reading system counters…</Empty>;
  const r = data.resources;
  const t = data.activeTasks;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Panel title="CPU & memory" sub={`${data.info.platform} ${data.info.arch} · ${data.info.cpuModel}`}>
        <div className="space-y-3">
          <div><div className="flex justify-between text-xs"><span className="text-slate-400">CPU ({r.cores} cores)</span><span className="mono text-cyan-100">{r.cpuPercent}%</span></div><Bar value={r.cpuPercent} /><Spark data={hist.cpu} /></div>
          <div><div className="flex justify-between text-xs"><span className="text-slate-400">RAM</span><span className="mono text-cyan-100">{r.ramUsedMb} / {r.ramTotalMb} MB ({r.ramPercent}%)</span></div><Bar value={r.ramPercent} /><Spark data={hist.ram} color="#818cf8" /></div>
          <div className="grid grid-cols-3 gap-2"><Stat label="Server RSS" value={`${r.serverRssMb}M`} /><Stat label="Load 1m" value={r.loadAvg[0]} /><Stat label="Uptime" value={`${Math.round(r.uptimeSec / 3600)}h`} /></div>
          <p className="text-[10px] text-slate-600">Values are sampled from OS counters on the machine running the server. GPU metrics are not available.</p>
        </div>
      </Panel>
      <Panel title="Model status" sub="Live probes, 24 h usage">
        <ul className="space-y-2">
          {data.providers.map((p: any) => (
            <li key={p.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-2.5 text-xs">
              <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-semibold text-slate-100"><Dot ok={p.reachable} />{p.label}</span><Badge tone={p.reachable ? "green" : p.configured ? "red" : "slate"}>{p.reachable ? "online" : p.configured ? "unreachable" : "not configured"}</Badge></div>
              <div className="mt-1 text-[10px] text-slate-500">{p.reachable ? `chat → ${p.resolved.chat}` : p.error ?? `set ${p.keyEnv}`} · {p.usage24h.requests} calls, {p.usage24h.prompt + p.usage24h.completion} tokens, {p.usage24h.errors} errors{p.cooldown ? ` · cooling down (${p.cooldown.reason})` : ""}</div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Network" sub={`Browser: ${v.online ? "online" : "offline"}`}>
        <ul className="space-y-1.5 text-xs">{data.network.checks.map((c: any) => <li key={c.host} className="flex items-center justify-between"><span className="flex items-center gap-2 text-slate-300"><Dot ok={c.ok} />{c.host}</span><span className="mono text-slate-500">{c.ok ? `${c.ms} ms` : "unreachable"}</span></li>)}</ul>
        <p className="mt-2 text-[11px] text-slate-500">Server connectivity {data.network.online ? "available" : "NOT available"} (probed {ago(new Date(data.network.at))}).</p>
      </Panel>
      <Panel title="Microphone & audio (this browser)">
        <dl className="space-y-1.5 text-xs">
          {[["Voice state", v.state, null], ["Microphone", v.mic.active ? v.mic.label || "active" : "off", v.mic.active], ["Permission", v.mic.permission, v.mic.permission === "granted" ? true : v.mic.permission === "denied" ? false : null], ["Input devices", String(v.devices.length), v.devices.length > 0], ["Output voices", `${v.voices.length} (${v.voices.filter((x) => x.localService).length} local)`, v.voices.length > 0], ["Echo cancellation", String(v.mic.echoCancellation ?? "n/a"), v.mic.echoCancellation ?? null], ["Level", `${Math.round(v.level * 100)}%`, null]].map(([k, val, ok]) => <div key={String(k)} className="flex items-center justify-between gap-2"><dt className="flex items-center gap-2 text-slate-500"><Dot ok={ok as boolean | null} />{k}</dt><dd className="mono truncate text-slate-300">{String(val)}</dd></div>)}
        </dl>
      </Panel>
      <Panel title="Active tasks">
        <div className="grid grid-cols-2 gap-2"><Stat label="Agent tasks" value={t.agentTasks.length} /><Stat label="Acquisitions" value={t.acquisitions.length} /><Stat label="Pending approvals" value={t.pendingApprovals.length} tone={t.pendingApprovals.length ? "text-amber-300" : undefined} /><Stat label="Sandbox" value={`${t.sandbox.active}/${t.sandbox.maxConcurrent}`} sub={`${t.sandbox.queued} queued`} /></div>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-400">{t.agentTasks.map((x: any) => <li key={x.id}>⬡ {x.agent}: {x.title}</li>)}{t.acquisitions.map((x: any) => <li key={x.id}>✦ {x.request.slice(0, 50)} ({x.phase})</li>)}</ul>
      </Panel>
      <Panel title="Memory"><div className="grid grid-cols-3 gap-2">{Object.entries(data.memory.byLayer).map(([k, n]) => <Stat key={k} label={k.replace("_", "-")} value={n as number} />)}</div></Panel>
      <Panel title="Error & event log" className="xl:col-span-2" pad={false}>
        <ul className="mono max-h-72 divide-y divide-cyan-400/5 overflow-auto text-[11px]">
          {data.errors.length === 0 && <li className="p-3 text-slate-600">No events logged.</li>}
          {data.errors.map((e: any) => <li key={e.id} className="flex gap-2 px-3 py-1.5"><span className={e.level === "error" ? "text-rose-300" : e.level === "warn" ? "text-amber-300" : "text-slate-500"}>{e.level.toUpperCase()}</span><span className="text-slate-500">{new Date(e.ts).toLocaleTimeString()}</span><span className="text-cyan-300/80">{e.source}</span><span className="text-slate-300">{e.message}</span></li>)}
        </ul>
      </Panel>
      <Panel title="Audit log" pad={false}>
        <ul className="mono max-h-72 divide-y divide-cyan-400/5 overflow-auto text-[11px]">
          {data.audit.map((a: any) => <li key={a.id} className="px-3 py-1.5"><Badge tone={riskTone(a.risk)}>{a.risk}</Badge> <span className="text-slate-300">{a.action}</span> <span className="text-cyan-300/70">{a.tool}</span> <span className={a.decision === "denied" || a.decision === "error" ? "text-rose-300" : "text-emerald-300"}>{a.decision}</span> <span className="text-slate-600">{ago(a.ts)}</span></li>)}
        </ul>
      </Panel>
    </div>
  );
}

function Evolution() {
  const { data, reload } = useApi<any>("/api/evolution", 0);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data) return <Empty>Loading metrics…</Empty>;
  const x = data.indicators;
  const act = async (body: any) => { setBusy(true); setMsg(""); try { const r = await api<any>("/api/evolution", { method: "POST", json: body }); setMsg(JSON.stringify(r).slice(0, 240)); await reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const pct = (n: number | null) => (n == null ? "n/a" : `${n}%`);
  return (
    <div className="space-y-4">
      <Notice tone="cyan">Evolution measures real behaviour and proposes improvements. Nothing is applied without your approval, and it has no code path that can change permissions, the core policy or the sandbox.</Notice>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Tasks ok" value={pct(x.tasks.successRatePct)} sub={`${x.tasks.total} in ${data.windowDays}d`} />
        <Stat label="Skill runs ok" value={pct(x.skills.successRatePct)} sub={`${x.skills.runs} runs`} />
        <Stat label="Tool calls ok" value={pct(x.tools.successRatePct)} sub={`${x.tools.total} calls`} />
        <Stat label="Agent runs verified" value={pct(x.agents.verifiedRatePct)} sub={`${x.agents.runs} runs`} />
        <Stat label="Voice latency avg" value={x.voice.samples ? `${x.voice.avgLatencyMs}ms` : "n/a"} sub={`p95 ${x.voice.p95LatencyMs || "—"} · ${x.voice.samples} turns`} />
        <Stat label="Recognition conf." value={x.voice.recognitionSamples ? x.voice.avgConfidence : "n/a"} sub={`${x.voice.recognitionSamples} samples`} />
        <Stat label="Memory top score" value={x.memory.retrievals ? x.memory.avgTopScore : "n/a"} sub={`${x.memory.retrievals} hits · ${x.memory.misses} misses`} />
        <Stat label="Model error rate" value={pct(x.model.errorRatePct)} sub={`${x.model.calls} calls · ${x.model.avgLatencyMs || "—"} ms`} />
        <Stat label="CPU avg" value={x.resources.samples ? `${x.resources.cpuAvgPct}%` : "n/a"} sub={`${x.resources.samples} samples`} />
        <Stat label="RAM avg" value={x.resources.samples ? `${x.resources.ramAvgPct}%` : "n/a"} />
        <Stat label="Capability gaps" value={x.capabilityGaps} sub="unhandled requests" tone={x.capabilityGaps ? "text-amber-300" : undefined} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Suggestions" right={<Btn variant="primary" disabled={busy} onClick={() => act({ action: "analyze" })}>Analyze now</Btn>}>
          {msg && <p className="mb-2 break-words text-[11px] text-cyan-200/80">{msg}</p>}
          {data.suggestions.length === 0 ? <Empty>No suggestions. Run an analysis after using skills, tools and voice.</Empty> : (
            <ul className="space-y-2">{data.suggestions.map((s: any) => (
              <li key={s.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs">
                <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-100">{s.title}</span><Badge tone={statusTone(s.status)}>{s.status}</Badge></div>
                <p className="mt-1 text-slate-400">{s.rationale}</p><div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600"><Badge tone="violet">{s.type}</Badge>{ago(s.createdAt)}</div>
                {s.result && <p className="mono mt-1 text-[10px] text-slate-500">{JSON.stringify(s.result).slice(0, 160)}</p>}
                <div className="mt-2 flex gap-2">{s.status === "proposed" && <><Btn disabled={busy} onClick={() => act({ action: "decide", id: s.id, decision: "approve" })}>Approve</Btn><Btn variant="danger" disabled={busy} onClick={() => act({ action: "decide", id: s.id, decision: "reject" })}>Reject</Btn></>}{s.status === "approved" && <Btn variant="primary" disabled={busy} onClick={() => act({ action: "apply", id: s.id })}>Apply</Btn>}</div>
              </li>
            ))}</ul>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Skill reliability">{data.skillReliability.length === 0 ? <Empty>No skill runs recorded yet.</Empty> : <ul className="space-y-1.5 text-xs">{data.skillReliability.map((s: any) => <li key={s.slug}><div className="flex justify-between"><span className="mono text-slate-300">{s.slug}</span><span className="text-slate-400">{s.successRate}% of {s.runs} · {s.status}</span></div><Bar value={s.successRate} /></li>)}</ul>}</Panel>
          <Panel title="Version history" pad={false}><ul className="mono max-h-64 divide-y divide-cyan-400/5 overflow-auto text-[11px]">{data.versionHistory.map((v: any, i: number) => <li key={i} className="px-3 py-1.5"><span className="text-slate-300">{v.slug} v{v.version}</span> <Badge tone={statusTone(v.status)}>{v.status}</Badge> {v.active && <Badge tone="cyan">active</Badge>} <span className="text-slate-600">{v.origin} · {v.changelog}</span></li>)}</ul></Panel>
        </div>
      </div>
    </div>
  );
}

const lvl: Record<string, string> = { implemented: "green", partial: "amber", not_implemented: "red" };
const chk: Record<string, string> = { pass: "green", fail: "red", manual: "amber", needs_model: "violet" };

function StatusBoard() {
  const { data } = useApi<any>("/api/status", 0);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRes(await api("/api/status", { method: "POST" })); } finally { setBusy(false); } };
  return (
    <div className="space-y-4">
      <Panel title="Acceptance checks" right={<Btn variant="primary" disabled={busy} onClick={run}>{busy ? "Running (≈20 s)…" : "Run self-check"}</Btn>} sub="Executes the server-verifiable tests against this running system. Voice tests need a browser; model tests need a provider.">
        {!res ? <p className="text-xs text-slate-500">Not run yet. Results below are live, not cached claims.</p> : (
          <ul className="space-y-2">{res.results.map((c: any) => <li key={c.id} className="flex gap-3 rounded-lg border border-cyan-400/10 bg-black/20 p-2.5 text-xs"><span className="mono w-12 shrink-0 text-slate-500">TEST {c.id}</span><div className="flex-1"><div className="flex items-center justify-between gap-2"><span className="text-slate-200">{c.title}</span><Badge tone={chk[c.status]}>{c.status.replace("_", " ")}</Badge></div><p className="mt-0.5 text-slate-500">{c.detail}</p></div></li>)}</ul>
        )}
      </Panel>
      <Panel title="Milestones" sub="Level is declared by the developers; evidence is computed live">
        {!data ? <Empty>Loading…</Empty> : <ul className="space-y-2">{data.milestones.map((m: any) => <li key={m.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-100">M{m.id} · {m.title}</span><Badge tone={lvl[m.level]}>{m.level.replace("_", " ")}</Badge></div><p className="mt-1 text-slate-400">{m.evidence}</p><p className="mt-0.5 text-amber-200/70">Limits: {m.limits}</p></li>)}</ul>}
      </Panel>
    </div>
  );
}

export function MonitorView() {
  const [tab, setTab] = useState<"live" | "evolution" | "status">("live");
  return (
    <div className="space-y-4">
      <Tabs tabs={[["live", "Live system"], ["evolution", "Self-evaluation & evolution"], ["status", "Status & acceptance"]]} value={tab} onChange={setTab} />
      {tab === "live" && <Live />}
      {tab === "evolution" && <Evolution />}
      {tab === "status" && <StatusBoard />}
    </div>
  );
}
