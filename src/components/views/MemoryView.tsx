"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Badge, Btn, Empty, Field, Notice, Panel, Stat, Toggle, ago, api, useApi } from "@/components/ui";

const LAYER_TONE: Record<string, string> = { short_term: "amber", long_term: "cyan", project: "violet", skill: "green", experience: "red", knowledge: "slate" };

function Item({ m, reload }: { m: any; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [content, setContent] = useState(m.content);
  const [title, setTitle] = useState(m.title);
  const [hist, setHist] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const save = async () => { try { await api(`/api/memory/${m.id}`, { method: "PATCH", json: { content, title } }); setEdit(false); setErr(""); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <li className="fade-up rounded-lg border border-cyan-400/10 bg-black/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5"><Badge tone={LAYER_TONE[m.layer]}>{m.layer.replace("_", "-")}</Badge>{m.sensitive && <Badge tone="red">sensitive</Badge>}{m.shared && <Badge tone="green">shared with devices</Badge>}{m.score != null && <Badge tone="cyan">relevance {m.score}</Badge>}<span className="text-[10px] text-slate-500">v{m.version} · {"★".repeat(m.importance)} · {m.source} · {ago(m.updatedAt)}{m.expiresAt ? ` · expires ${ago(m.expiresAt).replace(" ago", "")}` : ""}</span></div>
        <div className="flex gap-1">
          <Btn variant="ghost" onClick={() => setEdit(!edit)}>Edit</Btn>
          <Btn variant="ghost" onClick={async () => setHist(hist ? null : (await api<any>(`/api/memory/${m.id}`)).history)}>History</Btn>
          <Btn variant="ghost" onClick={async () => { await api(`/api/memory/${m.id}`, { method: "PATCH", json: { shared: !m.shared } }); reload(); }}>{m.shared ? "Unshare" : "Share"}</Btn>
          <Btn variant="danger" onClick={async () => { if (confirm(`Permanently delete "${m.title}"?`)) { await api(`/api/memory/${m.id}`, { method: "DELETE" }); reload(); } }}>Delete</Btn>
        </div>
      </div>
      {edit ? (
        <div className="mt-2 space-y-2"><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} /><textarea className="field h-28" value={content} onChange={(e) => setContent(e.target.value)} />{err && <p className="text-xs text-rose-300">{err}</p>}<div className="flex gap-2"><Btn variant="primary" onClick={save}>Save (new version)</Btn><Btn onClick={() => setEdit(false)}>Cancel</Btn></div></div>
      ) : (<><div className="mt-1.5 text-sm font-medium text-slate-100">{m.title}</div><p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-400">{m.content.length > 420 ? m.content.slice(0, 420) + "…" : m.content}</p></>)}
      {m.tags?.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{m.tags.map((t: string) => <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">#{t}</span>)}</div>}
      {hist && <ul className="mono mt-2 space-y-1 border-t border-cyan-400/10 pt-2 text-[11px] text-slate-400">{hist.map((h) => <li key={h.id}>v{h.version} · {ago(h.createdAt)} · {h.title}: {h.content.slice(0, 120)}{h.content.length > 120 ? "…" : ""}</li>)}</ul>}
    </li>
  );
}

export function MemoryView() {
  const [layer, setLayer] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, reload } = useApi<any>(`/api/memory?${layer ? `layer=${layer}&` : ""}${query ? `q=${encodeURIComponent(query)}` : ""}`, 0);
  const [f, setF] = useState({ layer: "long_term", title: "", content: "", tags: "", importance: 3 });
  const [res, setRes] = useState<any>(null);
  const [allowSensitive, setAllowSensitive] = useState(false);
  const add = async (force = false) => {
    try {
      const r = await api<any>("/api/memory", { method: "POST", json: { ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), allowSensitive, force } });
      setRes(r.created === false ? { warn: r.note ?? "already stored" } : { ok: true }); setF({ ...f, title: "", content: "", tags: "" }); setAllowSensitive(false); reload();
    } catch (e) { setRes({ err: (e as Error).message }); }
  };
  const stats = data?.stats;
  const layers: any[] = data?.layers ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
          <button onClick={() => setLayer("")} className="text-left"><Stat label="All" value={stats?.total ?? "…"} tone={layer === "" ? "text-cyan-200" : "text-slate-300"} /></button>
          {layers.map((l) => <button key={l.id} onClick={() => setLayer(l.id)} className="text-left" title={l.description}><Stat label={l.id.replace("_", "-")} value={stats?.byLayer?.[l.id] ?? 0} tone={layer === l.id ? "text-cyan-200" : "text-slate-300"} /></button>)}
        </div>
        <div className="flex gap-2"><input className="field" placeholder="Search by meaning or keyword (hashed-vector + keyword relevance)…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setQuery(q)} /><Btn onClick={() => setQuery(q)}>Search</Btn>{query && <Btn variant="ghost" onClick={() => { setQ(""); setQuery(""); }}>Clear</Btn>}</div>
        {layer && <p className="text-[11px] text-slate-500">{layers.find((l) => l.id === layer)?.description}</p>}
        {data && data.items.length === 0 ? <Empty>{query ? "Nothing relevant found." : "No memories in this layer yet. Say “remember that …” in the Console or add one here."}</Empty> : <ul className="space-y-2">{data?.items.map((m: any) => <Item key={m.id} m={m} reload={reload} />)}</ul>}
      </div>
      <div className="space-y-4">
        <Panel title="Add memory">
          <div className="space-y-2.5">
            <Field label="Layer"><select className="field" value={f.layer} onChange={(e) => setF({ ...f, layer: e.target.value })}>{layers.map((l) => <option key={l.id} value={l.id}>{l.id.replace("_", "-")} — {l.description}</option>)}</select></Field>
            <Field label="Title (optional)"><input className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Content"><textarea className="field h-24" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Tags (comma separated)"><input className="field" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field><Field label={`Importance ${f.importance}`}><input type="range" min={1} max={5} value={f.importance} onChange={(e) => setF({ ...f, importance: +e.target.value })} className="w-full" /></Field></div>
            <Btn variant="primary" disabled={!f.content.trim()} onClick={() => add()}>Store</Btn>
            {res?.ok && <p className="text-xs text-emerald-300">Stored.</p>}{res?.warn && <p className="text-xs text-amber-300">{res.warn}.</p>}
            {res?.err && (<div className="space-y-2"><Notice tone="amber">{res.err}</Notice>
              {/sensitive/i.test(res.err) && <Toggle checked={allowSensitive} onChange={setAllowSensitive} label="I understand - store it anyway as sensitive" />}
              {/sensitive/i.test(res.err) && allowSensitive && <Btn onClick={() => add()}>Store as sensitive</Btn>}
              {/near-duplicate/i.test(res.err) && <Btn onClick={() => add(true)}>Store anyway</Btn>}</div>)}
          </div>
          <p className="mt-3 text-[10px] text-slate-500">Secrets, API keys and card numbers are refused unless you override. Sensitive memories are never sent to models and are excluded from exports by default. Nothing from conversations is stored automatically.</p>
        </Panel>
        <Panel title="Export & retention">
          <div className="flex flex-wrap gap-2"><a className="btn" href="/api/memory?export=1">⬇ Export JSON</a><a className="btn" href="/api/memory?export=1&sensitive=1">⬇ Include sensitive</a></div>
          <p className="mt-2 text-[11px] text-slate-500">{stats ? `${stats.total} memories · ${stats.sensitive} sensitive.` : ""} Short-term memories expire automatically after 24 h. Deleting removes the memory and its version history permanently.</p>
        </Panel>
      </div>
    </div>
  );
}
