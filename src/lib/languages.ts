/**
 * Language registry shared by client and server. Add a language by adding one entry.
 * Speech recognition handles one language per session (browser limitation), so the active
 * recognition language is a setting; response language/voice is chosen per reply from the text script.
 */
export interface LanguageDef {
  code: string; // BCP-47 used for recognition + TTS
  name: string;
  nativeName: string;
  scriptRange?: [number, number]; // unicode block used for script detection
  wakeAliases: string[]; // transliterations recognisers commonly produce for "hey jarvis"
}

export const LANGUAGES: LanguageDef[] = [
  { code: "en-GB", name: "English (UK)", nativeName: "English", wakeAliases: ["hey jarvis", "hey jarvas", "a jarvis", "hey travis", "hey service", "okay jarvis", "ok jarvis"] },
  { code: "en-US", name: "English (US)", nativeName: "English", wakeAliases: ["hey jarvis", "hey jarvas", "a jarvis", "hey travis", "okay jarvis", "ok jarvis"] },
  { code: "en-IN", name: "English (India)", nativeName: "English", wakeAliases: ["hey jarvis", "hey jarvas", "a jarvis", "okay jarvis", "ok jarvis"] },
  { code: "ta-IN", name: "Tamil", nativeName: "தமிழ்", scriptRange: [0x0b80, 0x0bff], wakeAliases: ["ஹே ஜார்விஸ்", "ஏய் ஜார்விஸ்", "ஹே ஜார்விஸ", "hey jarvis"] },
  { code: "hi-IN", name: "Hindi", nativeName: "हिन्दी", scriptRange: [0x0900, 0x097f], wakeAliases: ["हे जार्विस", "हेय जार्विस", "हे जारविस", "hey jarvis"] },
];

export function getLanguage(code: string): LanguageDef {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

/** Detect the dominant registered script in a text; falls back to the default (English). */
export function detectLanguage(text: string, fallback = "en-GB"): string {
  const counts = new Map<string, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    for (const l of LANGUAGES) {
      if (l.scriptRange && cp >= l.scriptRange[0] && cp <= l.scriptRange[1]) counts.set(l.code, (counts.get(l.code) ?? 0) + 1);
    }
  }
  let best = "";
  let n = 0;
  for (const [code, c] of counts) if (c > n) { best = code; n = c; }
  return n >= 2 ? best : fallback;
}
