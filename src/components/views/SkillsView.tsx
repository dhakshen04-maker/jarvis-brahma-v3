"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { Badge, Btn, Code, Dot, Empty, Field, Notice, Panel, Stat, Tabs, Toggle, ago, api, statusTone, useApi } from "@/components/ui";

const PHASES = ["IDENTIFY", "RESEARCH", "DECOMPOSE", "DEVELOP", "SANDBOX", "VALIDATE", "REGISTER", "IMPROVE"];
const TEMPLATE_CODE = `function run(input) {\n  if (!input || typeof input.n !== 'number') throw new Error('n must be a number');\n  return { result: input.n * 2 };\n}`;
const TEMPLATE_TESTS = `[\n  {"name":"doubles","input":{"n":4},"expect":{"result":8}},\n  {"name":"negative","input":{"n":-3},"expect":{"result":-6}},\n  {"name":"rejects text","input":{"n":"x"},"expectError":"n must be a number"}\n]`;

function Report({ r }: { r: any }) {
  if (!r) return <p className="text-xs text-slate-500">Never validated.</p>;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge><span className="text-slate-400">{r.summary.testsPassed}/{r.summary.testsTotal} tests · {r.summary.checksPassed}/{r.summary.checksTotal} checks · {r.resources.maxDurationMs} ms · {r.resources.maxHeapMb} MB heap · ran {ago(r.ranAt)}</span></div>
      <ul className="space-y-1">{r.checks.map((c: any) => <li key={c.name} className="flex gap-2"><Dot ok={c.passed} /><span className="w-44 shrink-0 text-slate-300">{c.name}</span><span className="text-slate-500">{c.detail}</span></li>)}</ul>
      <ul className="space-y-1 border-t border-cyan-400/10 pt-2">{r.tests.map((t: any) => <li key={t.name} className="flex gap-2"><Dot ok={t.passed} /><span className="w-44 shrink-0 text-slate-300">{t.name}</span><span className="text-slate-500">{t.detail}</span></li>)}</ul>
      {r.findings?.length > 0 && <div className="text-amber-300/90">{r.findings.map((f: any, i: number) => <div key={i}>⚠ {f.severity}: {f.message}</div>)}</div>}
    </div>
  );
}

export function SkillForm({ categories, onSubmit, initial, submitLabel = "Create & validate" }: { categories: string[]; onSubmit: (b: any) => Promise<any>; initial?: any; submitLabel?: string }) {
  const [f, setF] = useState<Record<string, string>>({ name: "", slug: "", category: "General problem-solving", description: "", code: TEMPLATE_CODE, inputSchema: '{"type":"object","properties":{"n":{"type":"number"}},"required":["n"]}', outputSchema: '{"type":"object","properties":{"result":{"type":"number"}},"required":["result"]}', tests: TEMPLATE_TESTS, triggers: "", limitations: "", ...initial });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    setErr(""); setRes(null); setBusy(true);
    try {
      const body = { name: f.name, slug: f.slug, category: f.category, description: f.description, code: f.code, inputSchema: JSON.parse(f.inputSchema || "{}"), outputSchema: JSON.parse(f.outputSchema || "{}"), tests: JSON.parse(f.tests || "[]"), triggers: f.triggers.split("\n").map((s: string) => s.trim()).filter(Boolean), limitations: f.limitations };
      setRes(await onSubmit(body));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name"><input className="field" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Slug (unique id)"><input className="field mono" placeholder="custom.my_skill" value={f.slug} onChange={(e) => set("slug", e.target.value)} /></Field>
        <Field label="Category" hint="Type a new name to create a category"><input className="field" list="cats" value={f.category} onChange={(e) => set("category", e.target.value)} /><datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></Field>
      </div>
      <Field label="Description"><input className="field" value={f.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <Field label="Implementation: synchronous JavaScript defining run(input)" hint="Forbidden: require, import, process, eval, Function, constructor, globalThis, fetch, timers. Code that fails the static scan is never executed."><textarea className="field mono h-40" value={f.code} onChange={(e) => set("code", e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Input schema (JSON)"><textarea className="field mono h-20" value={f.inputSchema} onChange={(e) => set("inputSchema", e.target.value)} /></Field>
        <Field label="Output schema (JSON)"><textarea className="field mono h-20" value={f.outputSchema} onChange={(e) => set("outputSchema", e.target.value)} /></Field>
      </div>
      <Field label="Test cases (JSON array: name, input, expect | expectError)" hint="VERIFIED needs ≥3 tests including an error case; all tests must pass."><textarea className="field mono h-32" value={f.tests} onChange={(e) => set("tests", e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Natural-language triggers (regex with named groups, one per line)"><textarea className="field mono h-16" placeholder="^double (?<n>\d+)$" value={f.triggers} onChange={(e) => set("triggers", e.target.value)} /></Field>
        <Field label="Known limitations"><textarea className="field h-16" value={f.limitations} onChange={(e) => set("limitations", e.target.value)} /></Field>
      </div>
      <Btn variant="primary" onClick={go} disabled={busy || !f.name || !f.slug || !f.code}>{busy ? "Validating in sandbox…" : submitLabel}</Btn>
      {err && <Notice tone="red">{err}</Notice>}
      {res?.report && <Report r={res.report} />}
      {res?.log && <p className="text-xs text-slate-400">Acquisition status: {res.status}</p>}
    </div>
  );
}

function Detail({ id, onChange, hasModel, onDeleted }: { id: string; onChange: () => void; hasModel: boolean; onDeleted: () => void }) {
  const { data, reload } = useApi<any>(`/api/skills/${id}`, 0);
  const [input, setInput] = useState("");
  const [out, setOut] = useState<any>(null);
  const [untested, setUntested] = useState(false);
  const [msg, setMsg] = useState("");
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<{ code: string; tests: string } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => { setOut(null); setMsg(""); setDraft(null); setInput(""); }, [id]);
  if (!data) return <Panel><p className="text-xs text-slate-500">Loading…</p></Panel>;
  const s = data.skill;
  const active = data.versions.find((v: any) => v.id === data.activeVersionId);
  const example = JSON.stringify(active?.tests?.find((t: any) => !t.expectError)?.input ?? {}, null, 2);
  const act = async (action: string, extra: any = {}) => {
    setBusy(action); setMsg("");
    try { const r = await api<any>(`/api/skills/${id}`, { method: "POST", json: { action, ...extra } }); if (action === "run") setOut(r); else setMsg(`${action}: ${JSON.stringify(r).slice(0, 200)}`); await reload(); onChange(); }
    catch (e) { setMsg(`${action} failed: ${(e as Error).message}`); } finally { setBusy(""); }
  };
  return (
    <div className="space-y-4">
      <Panel title={s.name} right={<><Badge tone={statusTone(s.status)}>{s.status}</Badge><Toggle checked={s.enabled} onChange={(v) => act("toggle", { enabled: v })} label="Active" />{!s.builtin && <Btn variant="danger" onClick={async () => { if (confirm(`Delete skill ${s.slug} and all its versions?`)) { try { await api(`/api/skills/${id}`, { method: "DELETE" }); onDeleted(); } catch (e) { setMsg((e as Error).message); } } }}>Delete</Btn>}</>} sub={<span className="mono">{s.slug} · v{s.version} · {s.category}</span>}>
        <p className="text-sm text-slate-300">{s.description}</p>
        {s.limitations && <p className="mt-2 text-xs text-amber-200/80">Limitations: {s.limitations}</p>}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {[["Execution", s.executionMethod], ["Implementation", s.implementation], ["Dependencies", s.dependencies.join(", ") || "none"], ["Permissions", s.permissions.join(", ") || "sandbox only"], ["Created", ago(s.createdAt)], ["Updated", ago(s.updatedAt)], ["Runs", `${s.usageCount} (${s.successCount} ok / ${s.failureCount} failed)`], ["Tests defined", s.testsCount]].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-2"><dt className="text-slate-500">{k}</dt><dd className="mono truncate text-slate-300" title={String(v)}>{String(v)}</dd></div>)}
        </dl>
        {s.triggers.length > 0 && <div className="mt-3"><div className="text-[10px] uppercase tracking-widest text-slate-500">Natural-language triggers</div>{s.triggers.map((t: string, i: number) => <div key={i} className="mono truncate text-[11px] text-cyan-200/80">{t}</div>)}</div>}
      </Panel>

      <Panel title="Run in sandbox" right={<Toggle checked={untested} onChange={setUntested} label="allow untested" />}>
        <textarea className="field mono h-24" placeholder={example} value={input} onChange={(e) => setInput(e.target.value)} />
        <div className="mt-2 flex items-center gap-2">
          <Btn variant="primary" disabled={busy === "run"} onClick={() => { try { void act("run", { input: JSON.parse(input || example), allowUntested: untested }); } catch (e) { setMsg(`Invalid JSON: ${(e as Error).message}`); } }}>▶ Run</Btn>
          {out && <Badge tone={out.ok ? "green" : "red"}>{out.ok ? `ok · ${out.durationMs} ms` : "error"}</Badge>}
        </div>
        {out && <div className="mt-2"><Code value={out.ok ? out.output : out.error} /></div>}
      </Panel>

      <Panel title="Validation report" right={<Btn disabled={!!busy} onClick={() => act("test")}>{busy === "test" ? "Testing…" : "Re-run tests"}</Btn>}><Report r={s.validation} /></Panel>

      <Panel title={`Versions (${data.versions.length})`} sub="Updates never replace the active version silently">
        <ul className="space-y-2 text-xs">
          {data.versions.map((v: any) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-400/10 bg-black/20 px-3 py-2">
              <div><span className="mono text-slate-200">v{v.version}</span> <Badge tone={statusTone(v.status)}>{v.status}</Badge> {v.id === data.activeVersionId && <Badge tone="cyan">active</Badge>} <span className="ml-1 text-slate-500">{v.origin} · {v.changelog} · {ago(v.createdAt)}</span></div>
              <div className="flex gap-1.5">
                <Btn disabled={!!busy} onClick={() => act("test", { versionId: v.id })}>Test</Btn>
                {v.id !== data.activeVersionId && (v.status === "TESTED" || v.status === "VERIFIED") && <><Btn onClick={() => act("promote", { versionId: v.id })}>Promote</Btn><Btn onClick={() => act("rollback", { versionId: v.id })}>Roll back to</Btn></>}
              </div>
            </li>
          ))}
        </ul>
        {msg && <p className="mt-2 break-words text-[11px] text-cyan-200/80">{msg}</p>}
      </Panel>

      <Panel title="Edit as draft / improve" right={<Btn onClick={() => setShowCode(!showCode)}>{showCode ? "Hide" : "Show"} code & schemas</Btn>}>
        {showCode && <div className="mb-3 space-y-2"><Code value={active?.code ?? ""} max={6000} /><div className="grid gap-2 sm:grid-cols-2"><Code value={s.inputSchema} /><Code value={s.outputSchema} /></div></div>}
        {!draft ? <Btn onClick={() => setDraft({ code: active?.code ?? "", tests: JSON.stringify(active?.tests ?? [], null, 2) })}>Start a draft from the active version</Btn> : (
          <div className="space-y-2">
            <textarea className="field mono h-40" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
            <textarea className="field mono h-28" value={draft.tests} onChange={(e) => setDraft({ ...draft, tests: e.target.value })} />
            <Btn variant="primary" disabled={!!busy} onClick={() => { try { void act("draft", { code: draft.code, tests: JSON.parse(draft.tests), changelog: "Manual draft" }); } catch (e) { setMsg(`Invalid tests JSON: ${(e as Error).message}`); } }}>Create draft & test</Btn>
          </div>
        )}
        <div className="mt-4 border-t border-cyan-400/10 pt-3">
          <Field label="Improve with the coding model (creates a draft; never replaces silently)" hint={hasModel ? undefined : "Needs a language model - none reachable right now."}>
            <div className="flex gap-2"><input className="field" placeholder="What should be better or what went wrong?" value={feedback} onChange={(e) => setFeedback(e.target.value)} /><Btn disabled={!hasModel || !feedback || !!busy} onClick={() => act("improve", { feedback })}>Improve</Btn></div>
          </Field>
        </div>
      </Panel>
    </div>
  );
}

function Acquire({ categories, onChange, hasModel }: { categories: string[]; onChange: () => void; hasModel: boolean }) {
  const { data, reload } = useApi<any>("/api/skills", 2500);
  const [req, setReq] = useState("");
  const [err, setErr] = useState("");
  const list: any[] = data?.acquisitions ?? [];
  const start = async () => { setErr(""); try { await api("/api/skills", { method: "POST", json: { action: "acquire", request: req } }); setReq(""); await reload(); onChange(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-4">
      <Panel title="Skill acquisition protocol" sub="IDENTIFY → RESEARCH → DECOMPOSE → DEVELOP → SANDBOX → VALIDATE → REGISTER → IMPROVE">
        {!hasModel && <div className="mb-3"><Notice>No language model is reachable, so DEVELOP cannot generate code. The pipeline will research, then pause as <b>blocked</b>; you can submit your own implementation below and it will be sandboxed and validated identically. Configure GROQ_API_KEY / GEMINI_API_KEY or Ollama to enable generation.</Notice></div>}
        <div className="flex gap-2"><input className="field" placeholder="Describe a capability, e.g. “count the vowels in a sentence” or “convert Roman numerals to numbers”" value={req} onChange={(e) => setReq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && req.length > 4 && start()} /><Btn variant="primary" disabled={req.trim().length < 5} onClick={start}>Acquire</Btn></div>
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
        <p className="mt-2 text-[11px] text-slate-500">Requests that need network, files or OS access are refused as skills (skills are sandboxed pure computation) and must be built as reviewed tool integrations.</p>
      </Panel>
      {list.length === 0 && <Empty>No acquisitions yet.</Empty>}
      {list.map((a) => <AcqCard key={a.id} a={a} categories={categories} onChange={() => { reload(); onChange(); }} />)}
    </div>
  );
}

function AcqCard({ a, categories, onChange }: { a: any; categories: string[]; onChange: () => void }) {
  const [open, setOpen] = useState(a.status === "running" || a.status === "blocked");
  const idx = PHASES.indexOf(a.phase);
  return (
    <Panel title={a.request} right={<Badge tone={statusTone(a.status)}>{a.status}</Badge>} sub={`${ago(a.createdAt)} · phase ${a.phase}${a.data?.reused ? ` · reused ${a.data.reused}` : ""}`}>
      <div className="mb-2 flex gap-1">{PHASES.map((p, i) => <div key={p} title={p} className={`h-1.5 flex-1 rounded-full ${i < idx || (i === idx && a.status === "completed") ? "bg-cyan-400" : i === idx ? (a.status === "running" ? "blink bg-amber-400" : a.status === "failed" || a.status === "blocked" ? "bg-rose-400" : "bg-cyan-400") : "bg-slate-800"}`} />)}</div>
      <div className="flex flex-wrap gap-1 text-[9px] uppercase tracking-wider text-slate-500">{PHASES.map((p) => <span key={p} className={p === a.phase ? "text-cyan-300" : ""}>{p}</span>)}</div>
      {a.error && <p className="mt-2 text-xs text-rose-300">{a.error}</p>}
      <button className="mt-2 text-[11px] text-cyan-300 underline" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} log</button>
      {open && <ul className="mono mt-2 max-h-52 space-y-0.5 overflow-auto text-[11px]">{a.log.map((l: any, i: number) => <li key={i} className={l.level === "error" ? "text-rose-300" : l.level === "warn" ? "text-amber-300" : "text-slate-400"}>[{l.phase}] {l.message}</li>)}</ul>}
      {a.data?.research?.sources?.length > 0 && open && <div className="mt-2 text-[11px] text-slate-500">Sources: {a.data.research.sources.map((s: any) => `${s.title} (${s.reliability})`).join(" · ")}</div>}
      {a.status === "blocked" && a.phase === "DEVELOP" && <ManualBlock a={a} categories={categories} onChange={onChange} />}
    </Panel>
  );
}

function ManualBlock({ a, categories, onChange }: { a: any; categories: string[]; onChange: () => void }) {
  const spec = a.data?.spec ?? {};
  return (
    <div className="mt-3 rounded-lg border border-amber-400/25 p-3">
      <div className="mb-2 text-xs font-semibold text-amber-200">Provide an implementation manually — it goes through the same sandbox and validation</div>
      <SkillForm categories={categories} initial={{ name: spec.name ?? a.request.slice(0, 50), slug: spec.slug ?? "", category: spec.category ?? "General problem-solving", description: spec.description ?? a.request }} submitLabel="Submit to pipeline" onSubmit={async (b) => { const r = await api(`/api/skills/acquire/${a.id}`, { method: "POST", json: b }); onChange(); return { ...r, report: null }; }} />
    </div>
  );
}

export function SkillsView() {
  const { data, reload } = useApi<any>("/api/skills", 6000);
  const [tab, setTab] = useState<"library" | "acquire" | "create">("library");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [st, setSt] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const skills: any[] = data?.skills ?? [];
  const cats: string[] = (data?.categories ?? []).map((c: any) => c.name);
  const filtered = useMemo(() => skills.filter((s) => (!cat || s.category === cat) && (!st || s.status === st) && (!q || `${s.name} ${s.slug} ${s.description}`.toLowerCase().includes(q.toLowerCase()))), [skills, q, cat, st]);
  const count = (x: string) => skills.filter((s) => s.status === x).length;
  const [newCat, setNewCat] = useState("");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><Tabs tabs={[["library", "Library"], ["acquire", "Acquire new skill"], ["create", "Author manually"]]} value={tab} onChange={setTab} />
        <div className="grid grid-cols-5 gap-2"><Stat label="Verified" value={count("VERIFIED")} tone="text-emerald-300" /><Stat label="Tested" value={count("TESTED")} /><Stat label="Experimental" value={count("EXPERIMENTAL") + count("DEVELOPING")} tone="text-slate-300" /><Stat label="Failed" value={count("FAILED")} tone="text-rose-300" /><Stat label="Categories" value={cats.length} /></div>
      </div>
      {tab === "library" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <div className="space-y-3">
            <div className="flex gap-2"><input className="field" placeholder="Search skills…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="field !w-40" value={st} onChange={(e) => setSt(e.target.value)}><option value="">All status</option>{["VERIFIED", "TESTED", "EXPERIMENTAL", "DEVELOPING", "FAILED", "DISABLED"].map((x) => <option key={x}>{x}</option>)}</select></div>
            <select className="field" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories ({cats.length})</option>{cats.map((c) => <option key={c} value={c}>{c} ({skills.filter((s) => s.category === c).length})</option>)}</select>
            <div className="flex gap-2"><input className="field" placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><Btn disabled={!newCat.trim()} onClick={async () => { await api("/api/skills", { method: "POST", json: { action: "category", name: newCat } }); setNewCat(""); reload(); }}>Add</Btn></div>
            {filtered.length === 0 && <Empty>{data ? "No skills match." : "Loading… (built-in skills are validated on first load)"}</Empty>}
            <ul className="max-h-[70vh] space-y-2 overflow-auto pr-1">
              {filtered.map((s) => (
                <li key={s.id}><button onClick={() => setSel(s.id)} className={`w-full rounded-lg border p-3 text-left transition ${sel === s.id ? "border-cyan-300/60 bg-cyan-400/10" : "border-cyan-400/10 bg-black/20 hover:border-cyan-400/40"}`}>
                  <div className="flex items-start justify-between gap-2"><span className="text-sm font-semibold text-slate-100">{s.name}</span><Badge tone={statusTone(s.status)}>{s.status}</Badge></div>
                  <div className="mono mt-0.5 text-[11px] text-cyan-300/70">{s.slug} · v{s.version}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-slate-500">{s.description}</div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-slate-500"><span>{s.category}</span><span>{s.testsCount} tests</span><span>{s.usageCount} runs</span><span>{s.validation ? `validated ${ago(s.testedAt)}` : "not validated"}</span></div>
                </button></li>
              ))}
            </ul>
          </div>
          <div>{sel ? <Detail id={sel} onChange={reload} hasModel={!!data?.modelAvailable} onDeleted={() => { setSel(null); reload(); }} /> : <Empty>Select a skill to inspect its implementation status, validation report, versions and sandbox runner.</Empty>}</div>
        </div>
      )}
      {tab === "acquire" && <Acquire categories={cats} onChange={reload} hasModel={!!data?.modelAvailable} />}
      {tab === "create" && <Panel title="Author a skill manually" sub="Same validation pipeline as generated skills - status is earned, never assigned"><SkillForm categories={cats} onSubmit={async (b) => { const r = await api("/api/skills", { method: "POST", json: b }); reload(); return r; }} /></Panel>}
    </div>
  );
}
