"use client";
import { useState } from "react";

export default function LoginPage() {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr("");
    const r = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (r.ok) window.location.href = "/";
    else setErr((await r.json().catch(() => ({}))).error ?? "failed");
    setBusy(false);
  };
  return (
    <main className="hud-grid relative z-10 grid min-h-screen place-items-center p-6">
      <div className="panel w-full max-w-sm p-6">
        <div className="glow text-xl font-bold tracking-[0.3em] text-cyan-200">JARVIS</div>
        <div className="mb-5 mt-1 text-[10px] uppercase tracking-[0.3em] text-slate-500">BRAHMA · access required</div>
        <input className="field" type="password" autoFocus placeholder="Access key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && key && submit()} />
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
        <button className="btn btn-primary mt-4 w-full" disabled={!key || busy} onClick={submit}>{busy ? "Checking…" : "Unlock"}</button>
      </div>
    </main>
  );
}
