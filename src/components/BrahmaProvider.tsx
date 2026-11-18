"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVoice, type VoiceCallbacks } from "@/lib/voice/useVoice";
import { api } from "@/components/ui";

export type Tab = "console" | "voice" | "skills" | "memory" | "agents" | "research" | "projects" | "monitor" | "settings";
export const TABS: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: "console", label: "Console", glyph: "⌘" },
  { id: "voice", label: "Voice", glyph: "◉" },
  { id: "skills", label: "Skill Library", glyph: "✦" },
  { id: "memory", label: "Memory", glyph: "◈" },
  { id: "agents", label: "Agents", glyph: "⬡" },
  { id: "research", label: "Research", glyph: "⌕" },
  { id: "projects", label: "Projects", glyph: "▤" },
  { id: "monitor", label: "System Monitor", glyph: "∿" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

export interface ToolEvt { ts: number; name: string; status: string; risk: string; detail?: string }
export interface Approval { id: string; tool: string; risk: string; summary: string; expiresAt: string; status: "pending" | "approved" | "denied" | "done"; outcome?: any }
export interface Msg { id: string; role: "user" | "assistant" | "system"; content: string; streaming?: boolean; meta?: any; tools?: ToolEvt[]; voice?: boolean; intent?: string; engine?: string; data?: Array<{ kind: string; payload: any }> }

interface Ctx {
  tab: Tab;
  setTab: (t: Tab) => void;
  messages: Msg[];
  busy: boolean;
  stage: string;
  send: (text: string, o?: { voice?: boolean }) => Promise<void>;
  stopGeneration: () => void;
  newConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  conversations: any[];
  conversationId?: string;
  approvals: Approval[];
  decide: (id: string, decision: "approve" | "deny", confirm?: string) => Promise<void>;
  tools: ToolEvt[];
  voice: ReturnType<typeof useVoice>;
}

const BrahmaCtx = createContext<Ctx | null>(null);
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const useBrahma = () => {
  const c = useContext(BrahmaCtx);
  if (!c) throw new Error("BrahmaProvider missing");
  return c;
};

export function BrahmaProvider({ children }: { children: ReactNode }) {
  const [tab, setTabState] = useState<Tab>("console");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [conversations, setConversations] = useState<any[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tools, setTools] = useState<ToolEvt[]>([]);
  const convRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const sendRef = useRef<Ctx["send"]>(async () => undefined);
  const cbRef = useRef<VoiceCallbacks>({ onUtterance: () => undefined, onBargeIn: () => undefined });
  const voice = useVoice(cbRef);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#${t}`);
  }, []);

  const refreshConversations = useCallback(async () => {
    try { setConversations((await api<any>("/api/conversations")).conversations); } catch { /* ignore */ }
  }, []);

  const loadPending = useCallback(async () => {
    try {
      const d = await api<any>("/api/permissions");
      setApprovals((cur) => {
        const known = new Set(cur.map((a) => a.id));
        const fresh = (d.approvals as any[]).filter((a) => a.status === "pending" && !known.has(a.id)).map((a) => ({ id: a.id, tool: a.tool, risk: a.risk, summary: a.summary, expiresAt: a.expiresAt, status: "pending" as const }));
        return [...fresh, ...cur];
      });
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const h = window.location.hash.replace("#", "") as Tab;
    if (TABS.some((t) => t.id === h)) setTabState(h);
    refreshConversations();
    loadPending();
  }, [refreshConversations, loadPending]);

  const patchMsg = (id: string, fn: (m: Msg) => Msg) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(async (raw: string, o?: { voice?: boolean }) => {
    const text = raw.trim();
    if (!text) return;
    const viaVoice = !!o?.voice;
    const v = voiceRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const id = uid();
    const t0 = performance.now();
    setMessages((ms) => [...ms, { id: `${id}-u`, role: "user", content: text, voice: viaVoice }, { id, role: "assistant", content: "", streaming: true, tools: [] }]);
    setBusy(true);
    setStage("understanding");
    const st = v.machine.state;
    if (!viaVoice && ["IDLE", "OFFLINE", "LISTENING", "INTERRUPTED", "ERROR"].includes(st)) v.fire("TEXT_INPUT");
    const speak = v.shouldSpeak(viaVoice);
    v.speaker.begin(t0);
    let streamed = false;
    let acc = "";
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, conversationId: convRef.current, voice: viaVoice }), signal: ac.signal });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          const cur = voiceRef.current;
          switch (ev.t) {
            case "intent": patchMsg(id, (m) => ({ ...m, intent: ev.intent, engine: ev.engine })); break;
            case "phase":
              setStage(ev.phase);
              if (ev.phase === "thinking" && cur.machine.state === "UNDERSTANDING") cur.fire("INTENT_READY");
              if (ev.phase === "executing" && (cur.machine.state === "UNDERSTANDING" || cur.machine.state === "THINKING")) cur.fire("TOOL_START");
              break;
            case "tool": {
              const te: ToolEvt = { ts: Date.now(), name: ev.name, status: ev.status, risk: ev.risk, detail: ev.detail };
              setTools((t) => [te, ...t].slice(0, 40));
              patchMsg(id, (m) => ({ ...m, tools: [...(m.tools ?? []), te] }));
              if (ev.status !== "running" && cur.machine.state === "EXECUTING") cur.fire("TOOL_END");
              break;
            }
            case "delta":
              streamed = true;
              acc += ev.text;
              patchMsg(id, (m) => ({ ...m, content: acc }));
              if (speak) cur.speaker.push(ev.text);
              break;
            case "approval": setApprovals((a) => (a.some((x) => x.id === ev.approval.id) ? a : [{ ...ev.approval, status: "pending" }, ...a])); break;
            case "data": patchMsg(id, (m) => ({ ...m, data: [...(m.data ?? []), { kind: ev.kind, payload: ev.payload }] })); break;
            case "error": throw new Error(ev.message);
            case "done":
              if (!streamed) { acc = ev.text; if (speak) cur.speaker.push(ev.text); }
              else acc = ev.text || acc;
              convRef.current = ev.meta.conversationId;
              setConversationId(ev.meta.conversationId);
              patchMsg(id, (m) => ({ ...m, content: acc, streaming: false, meta: ev.meta }));
              break;
          }
        }
      }
      voiceRef.current.speaker.end();
      patchMsg(id, (m) => ({ ...m, streaming: false }));
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        patchMsg(id, (m) => ({ ...m, streaming: false, content: (m.content || "") + (m.content ? " …" : "(interrupted)") }));
      } else {
        patchMsg(id, (m) => ({ ...m, streaming: false, content: `Connection problem: ${(e as Error).message}` }));
        voiceRef.current.speaker.end();
      }
    } finally {
      if (abortRef.current === ac) { setBusy(false); setStage(""); }
      refreshConversations();
    }
  }, [refreshConversations]);
  sendRef.current = send;

  cbRef.current = {
    onUtterance: (t) => { void sendRef.current(t, { voice: true }); },
    onBargeIn: () => abortRef.current?.abort(),
  };

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    voiceRef.current.speaker.cancel();
    setBusy(false);
  }, []);

  const newConversation = useCallback(() => { abortRef.current?.abort(); convRef.current = undefined; setConversationId(undefined); setMessages([]); }, []);

  const loadConversation = useCallback(async (id: string) => {
    const d = await api<any>(`/api/conversations?id=${id}`);
    convRef.current = id;
    setConversationId(id);
    setMessages(d.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta, intent: m.meta?.intent, engine: m.meta?.engine, voice: m.meta?.voice })));
  }, []);

  const decide = useCallback(async (id: string, decision: "approve" | "deny", confirm?: string) => {
    const r = await api<any>("/api/permissions", { method: "POST", json: { action: "decide", id, decision, confirm } });
    setApprovals((a) => a.map((x) => (x.id === id ? { ...x, status: decision === "approve" ? "done" : "denied", outcome: r.outcome } : x)));
    if (r.outcome) {
      const o = r.outcome;
      setMessages((ms) => [...ms, { id: uid(), role: "system", content: o.status === "ok" ? `Approved and executed ${o.tool}: ${JSON.stringify(o.data).slice(0, 400)}` : `Approved, but ${o.tool} ${o.status}: ${o.error ?? ""}` }]);
    } else {
      setMessages((ms) => [...ms, { id: uid(), role: "system", content: "Request denied. Nothing was executed." }]);
    }
  }, []);

  const value = useMemo<Ctx>(() => ({ tab, setTab, messages, busy, stage, send, stopGeneration, newConversation, loadConversation, conversations, conversationId, approvals, decide, tools, voice }), [tab, setTab, messages, busy, stage, send, stopGeneration, newConversation, loadConversation, conversations, conversationId, approvals, decide, tools, voice]);
  return <BrahmaCtx.Provider value={value}>{children}</BrahmaCtx.Provider>;
}
