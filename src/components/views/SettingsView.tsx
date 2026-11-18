"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Badge, Btn, Code, Dot, Empty, Field, Notice, Panel, Tabs, Toggle, ago, api, riskTone, statusTone, useApi } from "@/components/ui";

function Models() {
  const { data, reload } = useApi<any>("/api/models", 0);
  const [draft, setDraft] = useState<any>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data) return <Empty>Probing providers…</Empty>;
  const cfg = data.config;
  const save = async (config: any) => { setBusy(true); try { await api("/api/models", { method: "POST", json: { action: "save", config } }); setMsg("Saved."); await reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const pv = (id: string) => ({ ...cfg.providers[id], ...(draft[id] ?? {}) });
  const upd = (id: string, patch: any) => setDraft((d: any) => ({ ...d, [id]: { ...(d[id] ?? {}), ...patch } }));
  return (
    <div className="space-y-4">
      <Panel title="Routing" right={<><Btn onClick={async () => { await api("/api/models?refresh=1"); reload(); }}>Test connections</Btn><Btn onClick={async () => { await api("/api/models", { method: "POST", json: { action: "clear_cooldown" } }); reload(); }}>Clear cooldowns</Btn></>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Mode" hint="local-only = never call cloud providers (offline model selection)"><select className="field" value={cfg.mode} onChange={(e) => save({ mode: e.target.value })}>{["auto", "local-only", "cloud-only"].map((m) => <option key={m}>{m}</option>)}</select></Field>
          <Field label="Request timeout (ms)"><input className="field" type="number" defaultValue={cfg.timeoutMs} onBlur={(e) => save({ timeoutMs: +e.target.value })} /></Field>
          <div className="text-[11px] text-slate-500">Task routing order (first available wins, others are fallbacks):<br />{data.tasks.map((t: string) => <div key={t}><span className="text-slate-400">{t}</span>: {cfg.order[t].join(" → ")}</div>)}</div>
        </div>
        {data.diagnosis.length > 0 && <div className="mt-3"><Notice>Skipped for chat right now: {data.diagnosis.join(" · ")}</Notice></div>}
        {msg && <p className="mt-2 text-xs text-cyan-200">{msg}</p>}
      </Panel>
      <div className="grid gap-4 xl:grid-cols-2">
        {data.providers.map((p: any) => (
          <Panel key={p.id} title={p.label} right={<Badge tone={p.reachable ? "green" : p.configured ? "red" : "slate"}>{p.reachable ? "online" : p.configured ? "unreachable" : "not configured"}</Badge>} sub={<>Credentials: environment variable <span className="mono">{p.keyEnv}</span> {p.id === "ollama" ? "(optional URL)" : ""} — never stored or displayed</>}>
            <div className="space-y-3">
              <Toggle checked={pv(p.id).enabled} onChange={(v) => save({ providers: { [p.id]: { enabled: v } } })} label="Enabled" />
              {(p.id === "ollama" || p.id === "custom") && <Field label="Base URL"><input className="field mono" defaultValue={cfg.providers[p.id].baseUrl ?? p.baseUrl} onChange={(e) => upd(p.id, { baseUrl: e.target.value })} /></Field>}
              <Field label="Daily token budget (0 = unlimited)" hint="Free tiers are rate limited. When the budget is reached the router falls back to the next provider."><input className="field" type="number" defaultValue={cfg.providers[p.id].dailyTokenLimit} onChange={(e) => upd(p.id, { dailyTokenLimit: +e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                {data.tasks.map((t: string) => <Field key={t} label={`${t} model`}><input className="field mono" defaultValue={cfg.providers[p.id].models[t]} placeholder={p.resolved[t]} onChange={(e) => upd(p.id, { models: { ...(draft[p.id]?.models ?? {}), [t]: e.target.value } })} /></Field>)}
              </div>
              <div className="flex items-center gap-2"><Btn variant="primary" disabled={busy || !draft[p.id]} onClick={() => save({ providers: { [p.id]: draft[p.id] } }).then(() => setDraft((d: any) => ({ ...d, [p.id]: undefined })))}>Save {p.label}</Btn><span className="text-[11px] text-slate-500">24 h: {p.usage24h.requests} calls · {p.usage24h.prompt + p.usage24h.completion} tokens · {p.usage24h.errors} errors</span></div>
              {p.error && <p className="text-[11px] text-rose-300">{p.error}</p>}
              {p.cooldown && <p className="text-[11px] text-amber-300">Cooling down ({p.cooldown.reason}) until {new Date(p.cooldown.until).toLocaleTimeString()}</p>}
              {p.installedModels.length > 0 && <p className="text-[11px] text-slate-500">Installed/available: {p.installedModels.slice(0, 12).join(", ")}{p.installedModels.length > 12 ? "…" : ""}</p>}
              {p.id === "ollama" && !p.reachable && <p className="text-[11px] text-slate-500">Install Ollama, then run <span className="mono">ollama pull llama3.2:3b</span> (≈2 GB, fine for an i5 with 16 GB RAM). Smaller: <span className="mono">llama3.2:1b</span>.</p>}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function Permissions() {
  const { data, reload } = useApi<any>("/api/permissions", 0);
  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Capabilities" sub="Only you can change these. HIGH and CRITICAL actions additionally need a per-action approval.">
        <ul className="space-y-1.5">{data.capabilities.map((c: any) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-cyan-400/10 bg-black/20 px-3 py-2 text-xs">
            <div><span className="font-medium text-slate-100">{c.label}</span> <Badge tone={riskTone(c.risk)}>{c.risk}</Badge><div className="text-[11px] text-slate-500">{c.description}</div><div className="mono text-[10px] text-slate-600">{c.id}</div></div>
            <Toggle checked={c.granted} onChange={async (v) => { await api("/api/permissions", { method: "POST", json: { action: "grant", capability: c.id, granted: v } }); reload(); }} />
          </li>
        ))}</ul>
      </Panel>
      <div className="space-y-4">
        <Panel title="Core policy (locked in code)" sub="Not modifiable through any API, agent or evolution routine"><ul className="space-y-1 text-xs">{Object.entries(data.policy).map(([k, v]) => <li key={k} className="flex justify-between gap-3"><span className="text-slate-500">{k}</span><span className="mono text-right text-slate-300">{Array.isArray(v) ? v.join(", ") : String(v)}</span></li>)}</ul></Panel>
        <Panel title="Approvals" pad={false}>{data.approvals.length === 0 ? <div className="p-4"><Empty>No approval requests yet.</Empty></div> : <ul className="max-h-64 divide-y divide-cyan-400/5 overflow-auto text-xs">{data.approvals.map((a: any) => <li key={a.id} className="px-4 py-2"><div className="flex items-center justify-between"><span className="mono text-slate-300">{a.tool}</span><span className="flex gap-1.5"><Badge tone={riskTone(a.risk)}>{a.risk}</Badge><Badge tone={statusTone(a.status)}>{a.status}</Badge></span></div><div className="text-slate-500">{a.summary} · {ago(a.createdAt)}</div></li>)}</ul>}</Panel>
        <Panel title="Audit log" pad={false}><ul className="mono max-h-72 divide-y divide-cyan-400/5 overflow-auto text-[11px]">{data.audit.map((a: any) => <li key={a.id} className="px-4 py-1.5"><Badge tone={riskTone(a.risk)}>{a.risk}</Badge> <span className="text-slate-300">{a.actor}:{a.action}</span> <span className="text-cyan-300/70">{a.tool}</span> <span className={/denied|error|refused/.test(a.decision) ? "text-rose-300" : "text-emerald-300"}>{a.decision}</span> <span className="text-slate-600">{ago(a.ts)}</span></li>)}</ul></Panel>
      </div>
    </div>
  );
}

function Devices() {
  const { data, reload } = useApi<any>("/api/devices", 5000);
  const [name, setName] = useState("");
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-4">
        <Panel title="Pair a device" sub="Creates a bearer token (shown once) for a client such as the Android app">
          <div className="flex gap-2"><input className="field" placeholder="Device name, e.g. Pixel 8" value={name} onChange={(e) => setName(e.target.value)} /><Btn variant="primary" disabled={!name.trim()} onClick={async () => { const r = await api<any>("/api/devices", { method: "POST", json: { name, platform: "android" } }); setToken({ name: r.device.name, token: r.token }); setName(""); reload(); }}>Pair</Btn></div>
          {token && <div className="mt-3"><Notice tone="green">Token for <b>{token.name}</b> (copy now, it is never shown again):<div className="mono mt-1 break-all text-emerald-100">{token.token}</div></Notice></div>}
          <div className="mt-3"><Notice tone="slate">The Android (Kotlin) client app is <b>not</b> included in this repository. These are the real, authenticated endpoints it would use: <span className="mono">GET /api/device/poll</span>, <span className="mono">POST /api/device/result</span>, <span className="mono">POST /api/device/chat</span>, <span className="mono">GET /api/device/skills</span>, <span className="mono">GET /api/device/memory?q=</span> with <span className="mono">Authorization: Bearer jb_…</span>. Each needs the matching grant below.</Notice></div>
        </Panel>
        <Panel title="Recent device commands">{(data?.commands ?? []).length === 0 ? <Empty>No commands queued.</Empty> : <ul className="space-y-1 text-xs">{data.commands.map((c: any) => <li key={c.id} className="flex justify-between gap-2"><span className="mono text-slate-300">{c.command} {JSON.stringify(c.args).slice(0, 50)}</span><span className="flex items-center gap-2"><Badge tone={statusTone(c.status === "completed" ? "done" : c.status)}>{c.status}</Badge><span className="text-slate-600">{ago(c.createdAt)}</span></span></li>)}</ul>}</Panel>
      </div>
      <Panel title="Paired devices" sub="Capabilities are never assumed: a command is only queued if the device holds the grant">
        {(data?.devices ?? []).length === 0 ? <Empty>No devices paired.</Empty> : <ul className="space-y-3">{data.devices.map((d: any) => (
          <li key={d.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs">
            <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-semibold text-slate-100"><Dot ok={d.online} />{d.name} <span className="font-normal text-slate-500">({d.platform})</span></span><Btn variant="danger" onClick={async () => { if (confirm(`Unpair ${d.name}?`)) { await api("/api/devices", { method: "DELETE", json: { id: d.id } }); reload(); } }}>Unpair</Btn></div>
            <div className="text-[10px] text-slate-500">last seen {ago(d.lastSeen)}</div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">{data.grantOptions.map((g: any) => <Toggle key={g.id} checked={d.granted.includes(g.id)} label={g.label} onChange={async (v) => { await api("/api/devices", { method: "PATCH", json: { id: d.id, granted: v ? [...d.granted, g.id] : d.granted.filter((x: string) => x !== g.id) } }); reload(); }} />)}</div>
          </li>
        ))}</ul>}
      </Panel>
    </div>
  );
}

function Prefs() {
  const { data, reload } = useApi<any>("/api/settings", 0);
  const { data: st } = useApi<any>("/api/status", 0);
  if (!data) return <Empty>Loading…</Empty>;
  const set = async (p: any) => { await api("/api/settings", { method: "POST", json: { prefs: p } }); reload(); };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Memory preferences">
        <div className="space-y-3"><Toggle checked={data.prefs.recordExperience} onChange={(v) => set({ recordExperience: v })} label="Record lessons in experience memory (failed tools, failed validations, acquisitions)" /><Toggle checked={data.prefs.memoryInPrompts} onChange={(v) => set({ memoryInPrompts: v })} label="Include relevant non-sensitive memories in model prompts" /></div>
        <p className="mt-3 text-[11px] text-slate-500">Conversations are never stored in memory automatically. Sensitive memories are never sent to models.</p>
      </Panel>
      <Panel title="Registered tools" sub="Every tool call passes the permission manager and is audited" pad={false}>
        <ul className="max-h-96 divide-y divide-cyan-400/5 overflow-auto text-xs">{(st?.tools ?? []).map((t: any) => <li key={t.name} className="px-4 py-2"><div className="flex items-center justify-between"><span className="mono text-slate-200">{t.name}</span><Badge tone={riskTone(t.risk)}>{t.risk}</Badge></div><div className="text-slate-500">{t.description} · try: <span className="mono">{t.usage}</span></div></li>)}</ul>
      </Panel>
      <Panel title="Environment"><Code value={`# Credentials are read from environment variables only\nGROQ_API_KEY=...\nGEMINI_API_KEY=...\nOLLAMA_BASE_URL=http://127.0.0.1:11434\nCUSTOM_LLM_BASE_URL=https://.../v1   # any OpenAI-compatible server\nCUSTOM_LLM_API_KEY=...\nCUSTOM_LLM_MODEL=...\nSEARXNG_URL=https://your-searxng   # optional search backend`} /></Panel>
    </div>
  );
}

export function SettingsView() {
  const [tab, setTab] = useState<"models" | "permissions" | "devices" | "prefs">("models");
  return (
    <div className="space-y-4">
      <Tabs tabs={[["models", "Models"], ["permissions", "Permissions & audit"], ["devices", "Devices"], ["prefs", "Preferences & tools"]]} value={tab} onChange={setTab} />
      {tab === "models" && <Models />}
      {tab === "permissions" && <Permissions />}
      {tab === "devices" && <Devices />}
      {tab === "prefs" && <Prefs />}
    </div>
  );
}
