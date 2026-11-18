"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Badge, Btn, Empty, Field, Panel, ago, api, useApi } from "@/components/ui";

const KINDS = ["architecture", "decision", "progress", "note"];

function Project({ id, reload }: { id: string; reload: () => void }) {
  const { data, reload: r2 } = useApi<any>(`/api/projects/${id}`, 0);
  const [kind, setKind] = useState("decision");
  const [content, setContent] = useState("");
  const [err, setErr] = useState("");
  if (!data) return <Empty>Loading…</Empty>;
  const p = data.project;
  const add = async () => { setErr(""); try { await api(`/api/projects/${id}`, { method: "POST", json: { kind, content } }); setContent(""); await r2(); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-4">
      <Panel title={p.name} right={<select className="field !w-32" value={p.status} onChange={async (e) => { await api(`/api/projects/${id}`, { method: "PATCH", json: { status: e.target.value } }); r2(); reload(); }}>{["active", "paused", "done"].map((s) => <option key={s}>{s}</option>)}</select>} sub={`Created ${ago(p.createdAt)}`}>
        <p className="text-sm text-slate-300">{p.description || "No description."}</p>
      </Panel>
      <Panel title="Add to project memory" sub="Stored in the project memory layer, linked to this project">
        <div className="flex gap-2"><select className="field !w-40" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select><input className="field" placeholder="Record an architecture note, decision or progress update…" value={content} onChange={(e) => setContent(e.target.value)} onKeyDown={(e) => e.key === "Enter" && content.trim() && add()} /><Btn variant="primary" disabled={!content.trim()} onClick={add}>Add</Btn></div>
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
      </Panel>
      {KINDS.map((k) => {
        const items = data.notes.filter((n: any) => n.tags.includes(k));
        if (!items.length) return null;
        return <Panel key={k} title={`${k} (${items.length})`}><ul className="space-y-2">{items.map((n: any) => <li key={n.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-2.5 text-xs text-slate-300">{n.content}<div className="mt-1 text-[10px] text-slate-600">{ago(n.createdAt)}</div></li>)}</ul></Panel>;
      })}
      {data.notes.length === 0 && <Empty>No project memory yet.</Empty>}
    </div>
  );
}

export function ProjectsView() {
  const { data, reload } = useApi<any>("/api/projects", 0);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const create = async () => { const r = await api<any>("/api/projects", { method: "POST", json: { name, description: desc } }); setName(""); setDesc(""); await reload(); setSel(r.project.id); };
  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="New project">
          <div className="space-y-2.5"><Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Description"><textarea className="field h-16" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field><Btn variant="primary" disabled={!name.trim()} onClick={create}>Create</Btn></div>
        </Panel>
        <Panel title="Projects">
          {(data?.projects ?? []).length === 0 ? <Empty>No projects yet.</Empty> : <ul className="space-y-1.5">{data.projects.map((p: any) => <li key={p.id}><button onClick={() => setSel(p.id)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs ${sel === p.id ? "bg-cyan-400/15 text-cyan-100" : "text-slate-300 hover:bg-white/5"}`}><span>{p.name}</span><span className="flex items-center gap-2"><Badge tone={p.status === "active" ? "green" : "slate"}>{p.status}</Badge><span className="text-[10px] text-slate-500">{p.notes} notes</span></span></button></li>)}</ul>}
        </Panel>
      </div>
      <div>{sel ? <Project id={sel} reload={reload} /> : <Empty>Create or select a project. Project memory keeps architecture, decisions and progress available to JARVIS across sessions.</Empty>}</div>
    </div>
  );
}
