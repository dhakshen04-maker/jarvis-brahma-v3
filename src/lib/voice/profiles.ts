/** Voice settings, personalities, voice selection, pronunciation, wake-word matching and speech text cleanup (client side). */
import { LANGUAGES, getLanguage } from "@/lib/languages";

export type Personality = "JARVIS" | "FRIDAY" | "NEUTRAL" | "CUSTOM";

export interface VoiceSettings {
  wakeWord: string;
  personality: Personality;
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  lang: string;
  autoLang: boolean;
  speakReplies: boolean;
  speakTyped: boolean;
  bargeIn: boolean;
  silenceTimeoutSec: number;
  pauseMs: number;
  deviceId: string;
  preferOnDevice: boolean;
  pronunciations: Record<string, string>;
}

export const PERSONALITY_INFO: Record<Personality, { label: string; blurb: string; lang: string; gender: "male" | "female" | "any"; rate: number; pitch: number; hints: string[] }> = {
  JARVIS: { label: "JARVIS", blurb: "Professional, calm, British-style male", lang: "en-GB", gender: "male", rate: 0.95, pitch: 0.85, hints: ["ryan", "george", "daniel", "arthur", "oliver", "thomas", "uk english male", "en-gb"] },
  FRIDAY: { label: "FRIDAY", blurb: "Warm, quick, female assistant", lang: "en-IE", gender: "female", rate: 1.02, pitch: 1.08, hints: ["sonia", "libby", "hazel", "moira", "fiona", "uk english female", "emily", "aria"] },
  NEUTRAL: { label: "Neutral", blurb: "Natural conversational default", lang: "en-US", gender: "any", rate: 1, pitch: 1, hints: ["jenny", "samantha", "google us english", "zira"] },
  CUSTOM: { label: "Custom", blurb: "Pick any installed voice", lang: "en-US", gender: "any", rate: 1, pitch: 1, hints: [] },
};

export const DEFAULT_VOICE: VoiceSettings = {
  wakeWord: "hey jarvis", personality: "JARVIS", voiceURI: "", rate: 0.95, pitch: 0.85, volume: 1, lang: "en-GB", autoLang: true,
  speakReplies: true, speakTyped: false, bargeIn: true, silenceTimeoutSec: 20, pauseMs: 140, deviceId: "", preferOnDevice: false,
  pronunciations: { JARVIS: "Jarvis", BRAHMA: "Brahma", Ollama: "oh-lama", SQL: "sequel", GUI: "gooey", "Wi-Fi": "why fye" },
};

const KEY = "brahma.voice.v1";
export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_VOICE, ...JSON.parse(raw), pronunciations: { ...DEFAULT_VOICE.pronunciations, ...(JSON.parse(raw).pronunciations ?? {}) } } : DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}
export function saveVoiceSettings(s: VoiceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

const MALE = /(male|daniel|george|ryan|arthur|oliver|james|guy|david|thomas|mark|alex|fred|rishi|ravi|prabhat)/i;
const FEMALE = /(female|hazel|sonia|libby|moira|samantha|fiona|zira|aria|jenny|emily|susan|karen|kalpana|heera|valluvar-f|pallavi)/i;

export function pickVoice(voices: SpeechSynthesisVoice[], s: VoiceSettings, textLang: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  if (s.voiceURI) {
    const exact = voices.find((v) => v.voiceURI === s.voiceURI);
    const wantPrefix = textLang.split("-")[0];
    if (exact && (s.personality === "CUSTOM" || exact.lang.toLowerCase().startsWith(wantPrefix))) return exact;
  }
  const p = PERSONALITY_INFO[s.personality];
  const wantLang = s.autoLang && !textLang.startsWith("en") ? textLang : p.lang;
  const prefix = wantLang.split("-")[0].toLowerCase();
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const name = v.name.toLowerCase();
    const lang = v.lang.replace("_", "-").toLowerCase();
    let score = 0;
    if (lang === wantLang.toLowerCase()) score += 50;
    else if (lang.startsWith(prefix)) score += 28;
    else score -= 20;
    if (p.hints.some((h) => name.includes(h) || lang === h)) score += 30;
    if (p.gender === "male" && MALE.test(name) && !FEMALE.test(name)) score += 18;
    if (p.gender === "female" && FEMALE.test(name)) score += 18;
    if (/natural|neural|online/.test(name)) score += 20;
    if (v.localService) score += 4;
    if (v.default) score += 2;
    if (score > bestScore) { best = v; bestScore = score; }
  }
  return best;
}

// ---------- text for speech ----------
export function cleanForSpeech(text: string, pron: Record<string, string>): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\(skill [^)]*\)/gi, " ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/\[(\d+)\]/g, " ")
    .replace(/[`*_#>~|]/g, "")
    .replace(/^[\s]*[•\-–]\s+/gm, "")
    .replace(/[✔✘⚠→]/g, " ")
    .replace(/(\d)\s*\*\s*(?=[\d(])/g, "$1 times ")
    .replace(/(\d)\s*\/\s*(?=[\d(])/g, "$1 divided by ")
    .replace(/\^/g, " to the power of ")
    .replace(/(\d)\s*\+\s*(?=[\d(])/g, "$1 plus ")
    .replace(/(\d)\s*-\s*(?=[\d(])/g, "$1 minus ")
    .replace(/\s=\s/g, " equals ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [word, say] of Object.entries(pron)) {
    if (!word) continue;
    t = t.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), say);
  }
  return t;
}

/** Splits a streaming buffer into complete sentences + remainder. */
export function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const out: string[] = [];
  let start = 0;
  const re = /([.!?।॥]+["')\]]*)(\s+|$)|\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    if (m[0] === "" ) break;
    const piece = buf.slice(start, end).trim();
    const lastWord = piece.split(/\s+/).slice(-1)[0] ?? "";
    const abbreviation = /^(?:[A-Za-z]{1,2}\.|e\.g\.|i\.e\.|etc\.|Dr\.|Mr\.|Mrs\.|Ms\.|vs\.)$/.test(lastWord);
    const atEnd = end >= buf.length && m[2] === "";
    if (piece.length > 0 && !abbreviation && !atEnd) {
      out.push(piece);
      start = end;
    }
  }
  return { sentences: out, rest: buf.slice(start) };
}

// ---------- wake word ----------
const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function wakePhrases(s: VoiceSettings): string[] {
  const lang = getLanguage(s.lang);
  const set = new Set([norm(s.wakeWord), ...lang.wakeAliases.map(norm)]);
  if (norm(s.wakeWord) === "hey jarvis") for (const l of LANGUAGES) l.wakeAliases.forEach((a) => set.add(norm(a)));
  return [...set].filter(Boolean);
}

function tokenize(text: string) {
  const out: Array<{ w: string; end: number }> = [];
  const re = /[\p{L}\p{M}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase().normalize("NFKC"), end: m.index + m[0].length });
  return out;
}
const afterToken = (text: string, end: number) => text.slice(end).replace(/^[\s,.:;!?-]+/, "").trim();

/** Returns the original-text remainder after the wake phrase (punctuation preserved), or null when absent. */
export function matchWake(text: string, s: VoiceSettings): { rest: string } | null {
  const toks = tokenize(text);
  for (const p of wakePhrases(s)) {
    const pw = p.split(" ");
    for (let i = 0; i + pw.length <= toks.length; i++) {
      if (pw.every((w, k) => toks[i + k].w === w)) return { rest: afterToken(text, toks[i + pw.length - 1].end) };
    }
  }
  // fuzzy: greeting + a word within edit distance 1 of the name (handles "hey jervis", "hey jarvas")
  const name = norm(s.wakeWord).split(" ").slice(-1)[0] ?? "";
  if (name.length >= 5) {
    for (let i = 1; i < toks.length; i++) {
      if (/^(hey|hi|ok|okay|a|hay)$/.test(toks[i - 1].w) && lev(toks[i].w, name) <= 1) return { rest: afterToken(text, toks[i].end) };
    }
  }
  return null;
}
