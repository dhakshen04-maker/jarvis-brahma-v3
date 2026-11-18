"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { Badge, Btn, Empty, Panel, Stat, ago, api, statusTone, useApi } from "@/components/ui";

const EXAMPLES = ["audit skill math.evaluate", "research the history of the Turing test", "diagnose system health", "build a skill to reverse the words in a sentence", "plan a four week study schedule for linear algebra and then review it"];

function RunDetail({ id }: { id: string }) {
  const { data } = useApi<any>(`/api/agents?run=${id}`, 1500);
  const [msgs, setMsgs] = useState(false);
  if (!data) return <Empty>Loading run…</Empty>;
  const { run, tasks, messages } = data;
  const res = run.result;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(run.status)}>{run.status.replace("_", " ")}</Badge><Badge tone="violet">{run.template}</Badge>{res?.verified != null && <Badge tone={res.verified ? "green" : "amber"}>{res.verified ? "verified by critic" : "not verified"}</Badge>}<span className="text-xs text-slate-400">{run.goal}</span></div>
      <div className="overflow-auto rounded-lg border border-cyan-400/10">
        <table className="w-full min-w-[640px] text-left text-[11px]">
          <thead className="bg-black/30 text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="p-2">Task</th><th className="p-2">Agent</th><th className="p-2">Depends on</th><th className="p-2">Status</th><th className="p-2">Result</th></tr></thead>
          <tbody>
            {tasks.map((t: any) => (
              <tr key={t.id} className="border-t border-cyan-400/10 align-top">
                <td className="p-2 text-slate-200">{t.title}{t.optional && <span className="ml-1 text-slate-600">(optional)</span>}</td>
                <td className="p-2"><Badge tone="cyan">{t.agent}</Badge>{t.input?.degraded && <div className="mt-1"><Badge tone="amber">degraded fallback</Badge></div>}</td>
                <td className="mono p-2 text-slate-500">{t.dependsOn.join(", ") || "—"}</td>
                <td className="p-2"><Badge tone={statusTone(t.status)}>{t.status}</Badge><div className="text-[10px] text-slate-600">attempt {t.attempts}</div></td>
                <td className="p-2 text-slate-400">{t.error ? <span className="text-rose-300">{t.error}</span> : t.result?.summary}{t.result?.confidence != null && <span className="ml-1 text-slate-600">conf {t.result.confidence}</span>}{t.result?.issues?.length > 0 && <ul className="mt-1 list-disc pl-4 text-amber-200/80">{t.result.issues.slice(0, 4).map((i: string, k: number) => <li key={k}>{i}</li>)}</ul>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {res?.lines && <div className="rounded-lg border border-cyan-400/10 bg-black/20 p-3 text-xs"><div className="mb-1 text-[10px] uppercase tracking-widest text-cyan-300/80">Final report</div>{res.lines.map((l: string, i: number) => <div key={i} className="text-slate-300">{l}</div>)}{res.issues?.length > 0 && <div className="mt-2 text-amber-200/80">{res.issues.map((l: string, i: number) => <div key={i}>• {l}</div>)}</div>}</div>}
      <Btn variant="ghost" onClick={() => setMsgs(!msgs)}>{msgs ? "Hide" : "Show"} structured messages ({messages.length})</Btn>
      {msgs && <ul className="mono max-h-56 space-y-1 overflow-auto text-[10px] text-slate-400">{messages.map((m: any) => <li key={m.id}>{new Date(m.createdAt).toLocaleTimeString()} <span className="text-cyan-300">{m.fromAgent} → {m.toAgent}</span> [{m.kind}] {JSON.stringify(m.payload).slice(0, 160)}</li>)}</ul>}
    </div>
  );
}

export function AgentsView() {
  const { data, reload } = useApi<any>("/api/agents", 4000);
  const [goal, setGoal] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const start = async () => { setErr(""); try { const r = await api<any>("/api/agents", { method: "POST", json: { goal } }); setSel(r.id); setGoal(""); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-4">
      <Panel title="Delegate a task" sub="The orchestrator plans a dependency graph, assigns agents, retries, reassigns and only reports ‘verified’ when the critic approves. Simple requests never use agents.">
        <div className="flex gap-2"><input className="field" placeholder="e.g. audit skill math.evaluate" value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && goal.length > 4 && start()} /><Btn variant="primary" disabled={goal.trim().length < 5} onClick={start}>Run</Btn></div>
        <div className="mt-2 flex flex-wrap gap-1.5">{EXAMPLES.map((e) => <button key={e} onClick={() => setGoal(e)} className="rounded-full border border-cyan-400/20 px-2.5 py-1 text-[11px] text-slate-400 hover:text-cyan-100">{e}</button>)}</div>
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
      </Panel>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Run details">{sel ? <RunDetail id={sel} /> : <Empty>Select or start a run to see tasks, dependencies, failures and the final verified report.</Empty>}</Panel>
          <Panel title="Recent runs">
            {(data?.runs ?? []).length === 0 ? <Empty>No runs yet.</Empty> : <ul className="space-y-1.5">{data.runs.map((r: any) => <li key={r.id}><button onClick={() => setSel(r.id)} className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs ${sel === r.id ? "bg-cyan-400/15" : "hover:bg-white/5"}`}><span className="truncate text-slate-300">{r.goal}</span><span className="flex shrink-0 items-center gap-2"><Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge><span className="text-[10px] text-slate-600">{ago(r.createdAt)}</span></span></button></li>)}</ul>}
          </Panel>
        </div>
        <Panel title="Agents">
          <ul className="space-y-2">
            {(data?.agents ?? []).map((a: any) => (
              <li key={a.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-2.5">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-slate-100">{a.name}</span><Badge tone={a.status === "busy" ? "amber" : a.status.startsWith("degraded") ? "red" : "green"}>{a.status}</Badge></div>
                <p className="mt-0.5 text-[11px] text-slate-500">{a.role}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-500"><span>done {a.done}</span><span>failed {a.failed}</span><span>tools: {a.tools.join(", ")}</span></div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <Panel title="Intelligence engines" sub="Ten engines behind BRAHMA CORE. Each lists what is implemented and what is not.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data?.engines ?? []).map((e: any) => (
            <div key={e.id} className="rounded-lg border border-cyan-400/10 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-100">{e.name}</span><Badge tone={e.ready ? "green" : "amber"}>{e.ready ? "ready" : "degraded"}</Badge></div>
              <p className="text-[11px] text-slate-400">{e.responsibility}</p>
              <p className="mt-1 text-[10px] text-slate-500">{e.readiness}</p>
              <div className="mt-2 grid grid-cols-2 gap-2"><Stat label="7-day uses" value={e.activity7d} /><Stat label="Coverage" value={`${e.implemented.length}/${e.implemented.length + e.notImplemented.length}`} /></div>
              <p className="mt-2 text-[10px] text-slate-500">Use: {e.entry}</p>
              <button className="mt-1 text-[11px] text-cyan-300 underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? "Hide" : "Show"} detail</button>
              {open === e.id && <div className="mt-2 text-[11px]"><div className="text-emerald-300/90">{e.implemented.map((x: string) => <div key={x}>✔ {x}</div>)}</div><div className="mt-1 text-rose-300/80">{e.notImplemented.map((x: string) => <div key={x}>✘ {x}</div>)}</div></div>}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
