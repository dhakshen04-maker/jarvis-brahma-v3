/**
 * Voice state machine. Pure reducer: every transition is caused by an explicit event emitted by
 * real audio / recognition / network / chat-stream callbacks. Illegal transitions are rejected
 * and counted (never silently applied). Self-contained.
 */
export type VoiceState =
  | "IDLE"
  | "WAKE_WORD_DETECTED"
  | "LISTENING"
  | "RECORDING"
  | "TRANSCRIBING"
  | "UNDERSTANDING"
  | "THINKING"
  | "EXECUTING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "OFFLINE"
  | "ERROR";

export const VOICE_STATES: VoiceState[] = [
  "IDLE", "WAKE_WORD_DETECTED", "LISTENING", "RECORDING", "TRANSCRIBING", "UNDERSTANDING",
  "THINKING", "EXECUTING", "SPEAKING", "INTERRUPTED", "OFFLINE", "ERROR",
];

export type VoiceEventType =
  | "SESSION_START" // user pressed talk / push-to-talk
  | "WAKE_DETECTED"
  | "SESSION_READY"
  | "SPEECH_START"
  | "SPEECH_END"
  | "TRANSCRIPT_FINAL"
  | "TRANSCRIPT_EMPTY"
  | "TEXT_INPUT"
  | "INTENT_READY"
  | "TOOL_START"
  | "TOOL_END"
  | "RESPONSE_START"
  | "RESPONSE_END"
  | "BARGE_IN"
  | "INTERRUPT_HANDLED"
  | "SILENCE_TIMEOUT"
  | "NETWORK_LOST"
  | "NETWORK_RESTORED"
  | "ERROR"
  | "RECOVER"
  | "STOP";

export interface VoiceEvent {
  type: VoiceEventType;
  at?: number;
  detail?: string;
}

export interface VoiceMachineState {
  state: VoiceState;
  sessionActive: boolean;
  offline: boolean;
  since: number;
  rejected: number;
  lastEvent: string;
  history: Array<{ at: number; from: VoiceState; to: VoiceState; event: VoiceEventType }>;
  error?: string;
}

type Target = VoiceState | "RESUME"; // RESUME = LISTENING if session active else IDLE (or OFFLINE)

const T: Record<VoiceState, Partial<Record<VoiceEventType, Target>>> = {
  IDLE: {
    SESSION_START: "LISTENING", WAKE_DETECTED: "WAKE_WORD_DETECTED", TEXT_INPUT: "UNDERSTANDING",
    TRANSCRIPT_FINAL: "UNDERSTANDING", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  WAKE_WORD_DETECTED: {
    SESSION_READY: "LISTENING", TRANSCRIPT_FINAL: "UNDERSTANDING", SPEECH_START: "RECORDING",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  LISTENING: {
    SPEECH_START: "RECORDING", TRANSCRIPT_FINAL: "UNDERSTANDING", TEXT_INPUT: "UNDERSTANDING",
    SILENCE_TIMEOUT: "IDLE", STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  RECORDING: {
    SPEECH_END: "TRANSCRIBING", TRANSCRIPT_FINAL: "UNDERSTANDING", TRANSCRIPT_EMPTY: "RESUME",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  TRANSCRIBING: {
    TRANSCRIPT_FINAL: "UNDERSTANDING", TRANSCRIPT_EMPTY: "RESUME", STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  UNDERSTANDING: {
    INTENT_READY: "THINKING", TOOL_START: "EXECUTING", RESPONSE_START: "SPEAKING", RESPONSE_END: "RESUME",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  THINKING: {
    TOOL_START: "EXECUTING", RESPONSE_START: "SPEAKING", RESPONSE_END: "RESUME",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  EXECUTING: {
    TOOL_END: "THINKING", RESPONSE_START: "SPEAKING", RESPONSE_END: "RESUME",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  SPEAKING: {
    RESPONSE_END: "RESUME", BARGE_IN: "INTERRUPTED", STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  INTERRUPTED: {
    INTERRUPT_HANDLED: "LISTENING", TRANSCRIPT_FINAL: "UNDERSTANDING", SPEECH_START: "RECORDING", TEXT_INPUT: "UNDERSTANDING",
    STOP: "IDLE", NETWORK_LOST: "OFFLINE", ERROR: "ERROR",
  },
  // OFFLINE doubles as the idle state while disconnected: with on-device recognition the wake word still works.
  OFFLINE: {
    NETWORK_RESTORED: "RESUME", TEXT_INPUT: "UNDERSTANDING", SESSION_START: "LISTENING", WAKE_DETECTED: "WAKE_WORD_DETECTED", STOP: "OFFLINE", ERROR: "ERROR",
  },
  ERROR: { RECOVER: "RESUME", STOP: "IDLE", SESSION_START: "LISTENING", TEXT_INPUT: "UNDERSTANDING" },
};

export function initialMachine(now = 0): VoiceMachineState {
  return { state: "IDLE", sessionActive: false, offline: false, since: now, rejected: 0, lastEvent: "INIT", history: [] };
}

export function canTransition(state: VoiceState, event: VoiceEventType): boolean {
  return T[state][event] !== undefined;
}

export function reduceVoice(m: VoiceMachineState, ev: VoiceEvent): VoiceMachineState {
  const at = ev.at ?? Date.now();
  let offline = m.offline;
  if (ev.type === "NETWORK_LOST") offline = true;
  if (ev.type === "NETWORK_RESTORED") offline = false;

  const target = T[m.state][ev.type];
  if (target === undefined) {
    // Connectivity facts are recorded even when the transition itself is not legal.
    return { ...m, offline, rejected: m.rejected + 1, lastEvent: `${ev.type} (rejected in ${m.state})` };
  }

  let sessionActive = m.sessionActive;
  if (ev.type === "SESSION_START" || ev.type === "WAKE_DETECTED" || ev.type === "SESSION_READY") sessionActive = true;
  if (ev.type === "STOP" || ev.type === "SILENCE_TIMEOUT") sessionActive = false;

  let next: VoiceState;
  if (target === "RESUME") next = sessionActive ? "LISTENING" : offline ? "OFFLINE" : "IDLE";
  else next = target;
  if (next === "IDLE" && offline) next = "OFFLINE";
  if (next === "OFFLINE") offline = true;

  const entry = { at, from: m.state, to: next, event: ev.type };
  return {
    state: next,
    sessionActive,
    offline,
    since: next === m.state ? m.since : at,
    rejected: m.rejected,
    lastEvent: ev.type,
    history: [...m.history.slice(-29), entry],
    error: ev.type === "ERROR" ? ev.detail ?? "unknown error" : next === "ERROR" ? m.error : undefined,
  };
}
