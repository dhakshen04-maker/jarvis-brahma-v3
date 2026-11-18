"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Badge, Btn, Code, Empty, Field, Notice, Panel, Tabs, Toggle, ago, api, useApi } from "@/components/ui";

const relTone = (r: string) => ({ high: "green", medium: "cyan", low: "amber", unknown: "red" } as Record<string, string>)[r] ?? "slate";

function Sources({ list }: { list: any[] }) {
  return (
    <ul className="space-y-2">
      {list.map((s: any, i: number) => (
        <li key={s.id ?? s.url} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2"><a href={s.url} target="_blank" rel="noreferrer noopener" className="font-medium text-cyan-200 hover:underline">[{s.n ?? i + 1}] {s.title || s.url}</a><span className="flex items-center gap-1.5"><Badge tone={relTone(s.reliability)}>{s.reliability} · {s.score ?? s.reliabilityScore}</Badge>{(s.injectionFlags?.length ?? 0) > 0 && <Badge tone="red" title={s.injectionFlags.join(", ")}>injection patterns neutralised</Badge>}</span></div>
          <div className="mono text-[10px] text-slate-500">{s.domain}{s.fetchedAt ? ` · fetched ${ago(s.fetchedAt)}` : ""}</div>
          <p className="mt-1 text-slate-400">{s.excerpt}</p>
          {s.reasons?.length > 0 && <p className="mt-1 text-[10px] text-slate-500">Why: {s.reasons.join("; ")}</p>}
        </li>
      ))}
    </ul>
  );
}

function Lab({ list, reload }: { list: any[]; reload: () => void }) {
  const [f, setF] = useState({ hypothesis: "The sum of the first n odd numbers equals n squared", code: "function run(input) {\n  var s = 0;\n  for (var i = 0; i < input.n; i++) s += 2 * i + 1;\n  return { sum: s, square: input.n * input.n };\n}", input: '{"n": 12}', expect: '{"sum": 144, "square": 144}' });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const run = async () => {
    setErr(""); setBusy("run");
    try { await api("/api/research", { method: "POST", json: { action: "experiment", hypothesis: f.hypothesis, code: f.code, input: JSON.parse(f.input || "{}"), expect: f.expect.trim() ? JSON.parse(f.expect) : undefined } }); reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  const design = async () => {
    setErr(""); setBusy("design");
    try { const d = await api<any>("/api/research", { method: "POST", json: { action: "design", hypothesis: f.hypothesis } }); setF({ ...f, code: d.code, input: JSON.stringify(d.input ?? {}), expect: d.expect ? JSON.stringify(d.expect) : "" }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Scientist lab" sub="Hypothesis → predicted outcome → sandboxed experiment → verdict. Supported results become verified knowledge; failures become lessons.">
        <div className="space-y-3">
          <Field label="Hypothesis"><input className="field" value={f.hypothesis} onChange={(e) => setF({ ...f, hypothesis: e.target.value })} /></Field>
          <Field label="Experiment (synchronous JS: run(input))"><textarea className="field mono h-36" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Input (JSON)"><textarea className="field mono h-16" value={f.input} onChange={(e) => setF({ ...f, input: e.target.value })} /></Field><Field label="Predicted output (JSON subset)"><textarea className="field mono h-16" value={f.expect} onChange={(e) => setF({ ...f, expect: e.target.value })} /></Field></div>
          <div className="flex gap-2"><Btn variant="primary" disabled={!!busy} onClick={run}>{busy === "run" ? "Running…" : "Run experiment"}</Btn><Btn disabled={!!busy} onClick={design} title="Needs a language model">{busy === "design" ? "Designing…" : "Design with model"}</Btn></div>
          {err && <Notice tone="red">{err}</Notice>}
        </div>
      </Panel>
      <Panel title="Experiment log">
        {list.length === 0 ? <Empty>No experiments yet.</Empty> : (
          <ul className="space-y-2">{list.map((e: any) => (
            <li key={e.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="text-slate-200">{e.hypothesis}</span><Badge tone={e.outcome === "supported" ? "green" : e.outcome === "refuted" ? "red" : e.outcome === "error" ? "red" : "amber"}>{e.outcome}</Badge></div><p className="mt-1 text-slate-500">{e.notes}</p><div className="mt-1 text-[10px] text-slate-600">{ago(e.createdAt)}</div></li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}

export function ResearchView() {
  const { data, reload } = useApi<any>("/api/research", 0);
  const [tab, setTab] = useState<"research" | "sources" | "lab">("research");
  const [topic, setTopic] = useState("");
  const [store, setStore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState("");
  const [page, setPage] = useState<any>(null);
  const go = async () => { setBusy(true); setErr(""); setRes(null); try { setRes(await api("/api/research", { method: "POST", json: { action: "topic", topic, store } })); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const fetchUrl = async () => { setErr(""); setPage(null); try { setPage(await api("/api/research", { method: "POST", json: { action: "fetch", url } })); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-4">
      <Tabs tabs={[["research", "Research"], ["sources", `Sources (${data?.sources?.length ?? 0})`], ["lab", "Lab"]]} value={tab} onChange={setTab} />
      {tab === "research" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Panel title="Research a topic" sub="Search → fetch (SSRF-safe) → rate sources → screen for prompt injection → compare → summarise with citations">
              <div className="flex gap-2"><input className="field" placeholder="e.g. how do transformers use attention" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && topic.length > 2 && go()} /><Btn variant="primary" disabled={busy || topic.trim().length < 3} onClick={go}>{busy ? "Researching…" : "Research"}</Btn></div>
              <div className="mt-2"><Toggle checked={store} onChange={setStore} label="Store the result in knowledge memory" /></div>
              {err && <div className="mt-3"><Notice tone="red">{err}</Notice></div>}
            </Panel>
            {res && (
              <Panel title="Findings" right={<Badge tone={res.summaryMethod === "llm" ? "violet" : "slate"}>{res.summaryMethod === "llm" ? "model summary" : res.summaryMethod === "extractive" ? "extractive summary" : "no summary"}</Badge>}>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{res.summary}</p>
                <p className="mt-2 text-[11px] text-slate-500">Cross-check: {res.comparison.note} (term agreement {res.comparison.agreement})</p>
                {res.warnings.length > 0 && <div className="mt-2 space-y-1">{res.warnings.slice(0, 6).map((w: string, i: number) => <p key={i} className="text-[11px] text-amber-300/90">⚠ {w}</p>)}</div>}
                {res.sources.length > 0 && <div className="mt-3"><Sources list={res.sources} /></div>}
                <Notice tone="slate">{res.operationalNote}</Notice>
              </Panel>
            )}
          </div>
          <div className="space-y-4">
            {res?.knowledgeMap && (
              <Panel title="Knowledge map" sub="Foundational concepts, sections and practical tools extracted from the sources">
                {[["Concepts", res.knowledgeMap.concepts], ["Sections", res.knowledgeMap.sections], ["Tools mentioned", res.knowledgeMap.tools]].map(([l, items]: any) => <div key={l} className="mb-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">{l}</div><div className="mt-1 flex flex-wrap gap-1">{items.length ? items.map((c: string) => <span key={c} className="rounded border border-cyan-400/15 px-1.5 py-0.5 text-[11px] text-slate-300">{c}</span>) : <span className="text-[11px] text-slate-600">none found</span>}</div></div>)}
              </Panel>
            )}
            <Panel title="Inspect a web page" sub="Fetch one URL and see its reliability rating and injection screening">
              <div className="flex gap-2"><input className="field" placeholder="https://docs.python.org/3/library/json.html" value={url} onChange={(e) => setUrl(e.target.value)} /><Btn disabled={!url} onClick={fetchUrl}>Fetch</Btn></div>
              {page && <div className="mt-3 space-y-2 text-xs"><div className="flex items-center gap-2"><Badge tone={relTone(page.reliability.level)}>{page.reliability.level} · {page.reliability.score}</Badge>{page.injection.risky && <Badge tone="red">{page.injection.flags.join(", ")}</Badge>}</div><div className="font-medium text-slate-200">{page.title}</div><p className="text-slate-500">{page.excerpt}</p><p className="text-[10px] text-slate-600">{page.reliability.reasons.join("; ")}</p></div>}
              <p className="mt-2 text-[10px] text-slate-600">Private, loopback and cloud-metadata addresses are always blocked.</p>
            </Panel>
          </div>
        </div>
      )}
      {tab === "sources" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Panel title="Source registry">{(data?.sources ?? []).length ? <Sources list={data.sources} /> : <Empty>No sources collected yet.</Empty>}</Panel>
          <Panel title="Research reports">{(data?.reports ?? []).length ? <ul className="space-y-2">{data.reports.map((r: any) => <li key={r.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs"><div className="flex justify-between gap-2"><span className="font-medium text-slate-200">{r.topic}</span><Badge tone={r.operational ? "green" : "slate"}>{r.operational ? "operational" : "knowledge only"}</Badge></div><p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-500">{r.summary}</p><div className="mt-1 text-[10px] text-slate-600">{ago(r.createdAt)} · {r.sourceIds.length} sources</div></li>)}</ul> : <Empty>No reports yet.</Empty>}</Panel>
        </div>
      )}
      {tab === "lab" && <Lab list={data?.experiments ?? []} reload={reload} />}
      {data === null && <Code value="Loading…" />}
    </div>
  );
}
