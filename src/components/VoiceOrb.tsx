"use client";
import { useEffect, useRef } from "react";
import type { VoiceState } from "@/lib/voice/machine";

const PALETTE: Record<VoiceState, { c: string; label: string; speed: number }> = {
  IDLE: { c: "56,189,248", label: "Standing by", speed: 0.15 },
  WAKE_WORD_DETECTED: { c: "125,211,252", label: "Wake word detected", speed: 0.9 },
  LISTENING: { c: "34,211,238", label: "Listening", speed: 0.5 },
  RECORDING: { c: "103,232,249", label: "Recording", speed: 0.8 },
  TRANSCRIBING: { c: "129,140,248", label: "Transcribing", speed: 1.4 },
  UNDERSTANDING: { c: "99,102,241", label: "Understanding", speed: 1.6 },
  THINKING: { c: "147,130,255", label: "Thinking", speed: 2.2 },
  EXECUTING: { c: "251,191,36", label: "Executing", speed: 2.6 },
  SPEAKING: { c: "59,130,246", label: "Speaking", speed: 0.7 },
  INTERRUPTED: { c: "251,113,133", label: "Interrupted", speed: 1.2 },
  OFFLINE: { c: "148,163,184", label: "Offline", speed: 0.1 },
  ERROR: { c: "239,68,68", label: "Error", speed: 0.3 },
};

export const stateLabel = (s: VoiceState) => PALETTE[s].label;
export const stateColor = (s: VoiceState) => `rgb(${PALETTE[s].c})`;

/** Circular HUD visualisation. Mic level comes from the real analyser; the speaking pulse is a state-driven animation. */
export function VoiceOrb({ state, level, size = 340 }: { state: VoiceState; level: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, level });
  live.current = { state, level };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    let raf = 0;
    let t = 0;
    let smooth = 0;
    const cx = size / 2;
    const R = size * 0.27;
    const draw = () => {
      const { state: st, level: lv } = live.current;
      const p = PALETTE[st];
      t += 0.016 * p.speed;
      smooth += (lv - smooth) * 0.25;
      ctx.clearRect(0, 0, size, size);
      const listening = st === "LISTENING" || st === "RECORDING" || st === "WAKE_WORD_DETECTED";
      const amp = st === "SPEAKING" ? 0.45 + 0.35 * Math.abs(Math.sin(t * 5.3) * Math.sin(t * 2.1 + 1)) : listening ? smooth : st === "IDLE" || st === "OFFLINE" ? 0.05 + 0.03 * Math.sin(t * 4) : 0.18;
      // glow core
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, R * (1.5 + amp));
      g.addColorStop(0, `rgba(${p.c},${0.28 + amp * 0.4})`);
      g.addColorStop(0.6, `rgba(${p.c},0.06)`);
      g.addColorStop(1, `rgba(${p.c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cx, R * (1.6 + amp), 0, Math.PI * 2);
      ctx.fill();
      // radial bars
      const bars = 72;
      ctx.lineCap = "round";
      for (let i = 0; i < bars; i++) {
        const a = (i / bars) * Math.PI * 2 + t * 0.2;
        const wob = st === "SPEAKING" ? Math.abs(Math.sin(a * 3 + t * 6) * Math.cos(a * 5 - t * 3)) : listening ? Math.abs(Math.sin(a * 4 + t * 4)) * 0.6 + 0.4 : 0.35 + 0.2 * Math.sin(a * 6 + t);
        const len = 4 + wob * (6 + amp * 52);
        const r1 = R * 1.08;
        ctx.strokeStyle = `rgba(${p.c},${0.35 + wob * 0.55})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * (r1 + len), cx + Math.sin(a) * (r1 + len));
        ctx.stroke();
      }
      // arcs
      const arc = (r: number, start: number, len: number, w: number, alpha: number) => {
        ctx.strokeStyle = `rgba(${p.c},${alpha})`;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.arc(cx, cx, r, start, start + len);
        ctx.stroke();
      };
      arc(R * 1.55, t * 1.2, 1.3, 3, 0.85);
      arc(R * 1.55, t * 1.2 + 3.3, 0.8, 3, 0.55);
      arc(R * 1.75, -t * 0.8, 1.9, 1.5, 0.5);
      arc(R * 1.75, -t * 0.8 + 3.6, 0.9, 1.5, 0.35);
      arc(R * 1.95, t * 0.4, 0.5, 4, 0.7);
      ctx.setLineDash([2, 7]);
      arc(R * 2.1, -t * 0.3, Math.PI * 2, 1, 0.35);
      ctx.setLineDash([]);
      // tick ring
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2;
        const major = i % 5 === 0;
        const r0 = R * 2.22;
        ctx.strokeStyle = `rgba(${p.c},${major ? 0.5 : 0.2})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r0 + (major ? 8 : 4)), cx + Math.sin(a) * (r0 + (major ? 8 : 4)));
        ctx.stroke();
      }
      if (st === "OFFLINE" || st === "ERROR") {
        ctx.strokeStyle = `rgba(${p.c},0.8)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - R * 0.5, cx + R * 0.5);
        ctx.lineTo(cx + R * 0.5, cx - R * 0.5);
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size }} aria-label={`Voice state: ${PALETTE[state].label}`} />;
}
