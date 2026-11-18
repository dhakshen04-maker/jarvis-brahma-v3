"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export async function api<T = any>(url: string, init?: Omit<RequestInit, "body"> & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export function useApi<T = any>(url: string | null, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!url);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const d = await api<T>(url);
      if (alive.current) { setData(d); setError(""); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    reload();
    const t = pollMs > 0 ? setInterval(reload, pollMs) : undefined;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [reload, pollMs]);
  return { data, error, loading, reload, setData };
}

export function Panel({ title, right, children, className = "", pad = true, sub }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean; sub?: ReactNode }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-cyan-400/10 px-4 py-2.5">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300/90">{title}</h3>
            {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
          </div>
          <div className="flex items-center gap-2">{right}</div>
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  cyan: "border-cyan-400/40 bg-cyan-400/10 text-cyan-200",
  green: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  amber: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  red: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  violet: "border-violet-400/40 bg-violet-400/10 text-violet-200",
  slate: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};
export function Badge({ tone = "slate", children, title }: { tone?: keyof typeof TONES | string; children: ReactNode; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONES[tone] ?? TONES.slate}`}>{children}</span>;
}

export const statusTone = (s: string) => ({ VERIFIED: "green", TESTED: "cyan", EXPERIMENTAL: "slate", DEVELOPING: "amber", FAILED: "red", DISABLED: "slate", verified: "green", done: "green", completed: "green", running: "amber", pending: "slate", failed: "red", blocked: "red", completed_unverified: "amber", skipped: "slate", approved: "green", denied: "red", proposed: "amber", applied: "green", rejected: "slate" } as Record<string, string>)[s] ?? "slate";
export const riskTone = (r: string) => ({ LOW: "green", MEDIUM: "cyan", HIGH: "amber", CRITICAL: "red" } as Record<string, string>)[r] ?? "slate";

export function Btn({ variant, className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" }) {
  return <button {...p} className={`btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : variant === "ghost" ? "btn-ghost" : ""} ${className}`} />;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-cyan-400/10 bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mono mt-0.5 text-xl font-semibold ${tone ?? "text-cyan-100"}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function Bar({ value, tone = "cyan" }: { value: number; tone?: "cyan" | "amber" | "red" }) {
  const c = value > 85 ? "red" : value > 65 ? "amber" : tone;
  const col = c === "red" ? "bg-rose-400" : c === "amber" ? "bg-amber-400" : "bg-cyan-400";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
      <div className={`h-full rounded-full ${col} transition-all duration-500`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 text-xs text-slate-300 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-5 w-9 rounded-full border transition ${checked ? "border-cyan-300/70 bg-cyan-400/30" : "border-slate-600 bg-slate-800"}`}>
        <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${checked ? "left-[18px] bg-cyan-200" : "left-0.5 bg-slate-400"}`} />
      </button>
      {label}
    </label>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-lg border border-dashed border-slate-700/80 px-4 py-6 text-center text-xs text-slate-500">{children}</div>;

export const Dot = ({ ok }: { ok: boolean | null }) => <span className={`inline-block h-2 w-2 rounded-full ${ok === null ? "bg-slate-500" : ok ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-rose-400 shadow-[0_0_8px_#fb7185]"}`} />;

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border border-cyan-400/10 bg-black/20 p-1">
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)} className={`rounded-md px-3 py-1 text-xs font-semibold tracking-wide transition ${value === id ? "bg-cyan-400/20 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,.4)]" : "text-slate-400 hover:text-slate-200"}`}>{label}</button>
      ))}
    </div>
  );
}

export const Notice = ({ tone = "amber", children }: { tone?: string; children: ReactNode }) => <div className={`rounded-lg border px-3 py-2 text-xs ${TONES[tone] ?? TONES.amber}`}>{children}</div>;

export function Code({ value, max = 600 }: { value: unknown; max?: number }) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-cyan-400/10 bg-black/40 p-2.5 text-[11px] leading-relaxed text-slate-300">{s.length > max ? s.slice(0, max) + "…" : s}</pre>;
}

export function ago(iso?: string | Date | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block text-xs">
    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[10px] text-slate-500">{hint}</span>}
  </label>
);
