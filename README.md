# JARVIS BRAHMA — Universal Adaptive Intelligence System

A modular personal-intelligence console: voice conversation, persistent six-layer memory, a sandboxed and **validated** skill library, a skill-acquisition pipeline, multi-agent delegation, source-rated research, permission-gated tools and measured self-evaluation.

> **Reality check (read this first)**
> - The repository you gave me contained only a blank Next.js starter page. There was **no existing JARVIS UI and no "Option B" interface** to preserve. The HUD was designed from your reference image. `/api/health` was preserved.
> - The brief proposes Python/PySide6. This workspace is a Next.js + TypeScript + PostgreSQL (Drizzle) project, so BRAHMA is implemented as a web application in that stack. The Python modules, Faster-Whisper, OpenWakeWord, Piper, Silero VAD and ChromaDB are **not** used; browser/OS equivalents or local substitutes are used and listed below.
> - Nothing below is marked "working" unless it was executed. The model-driven paths (conversation, skill *generation*) could **not** be exercised here because no model provider was reachable; everything else was run against the live server (see *Verification*).

## Run
```
npm install && npx drizzle-kit push   # schema (platform bootstrap does this)
npm run build && npm start
node --test tests/core.test.mjs        # 19 unit tests: sandbox, skills, security, embeddings, voice state machine
```
Environment (read from env only — never stored, logged or returned by any API):
`GROQ_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), `CUSTOM_LLM_BASE_URL/KEY/MODEL` (any OpenAI-compatible server), `SEARXNG_URL` (optional), `BRAHMA_ACCESS_KEY` (optional login gate — **set it if the URL is reachable by others**; without it the console is open and a banner says so).

Free local setup for a 16 GB i5 laptop: install Ollama, `ollama pull llama3.2:3b` (or `llama3.2:1b`), choose *local-only* in Settings › Models.

## Architecture
```
src/lib/core/brahma.ts      BRAHMA CORE: observe → understand → plan → delegate → execute → verify → learn
src/lib/engines.ts          10 engines: Creator, Scientist, Engineer, Scholar, Strategist, Security, Communicator, Memory, Research, Evolution
src/lib/agents/             10 agents + orchestrator (dependency graph, retries, reassignment, critic, structured messages)
src/lib/skills/             registry + validator, acquisition pipeline (8 phases), seed skills, schema validator
src/lib/sandbox.ts          isolated skill runner (child process + Node permission model + vm context)
src/lib/memory/             six layers, hashed-vector + keyword retrieval, versions, export
src/lib/models/             provider adapters (Groq, Gemini, Ollama, OpenAI-compatible) + router
src/lib/permissions.ts      risk classes, grants, single-use approvals, frozen core policy
src/lib/tools/              permission-gated tool registry; workspace-bounded filesystem; processes; apps; scripts
src/lib/research.ts         search, SSRF-safe fetch, reliability rating, injection screening, citations
src/lib/evolution.ts        metrics → failure/gap detection → approval-gated suggestions
src/lib/voice/              state machine (pure, unit-tested), profiles/wake word, useVoice hook (browser audio)
src/components/             HUD shell + 9 views (Console, Voice, Skills, Memory, Agents, Research, Projects, Monitor, Settings)
```

## Decisions
1. **Skills are pure synchronous JavaScript run in a sandbox.** Child process with `--permission` (no fs/child/worker/addons), 64 MB heap cap, stripped env, `vm` context from a null-prototype object with code generation disabled, vm + hard-kill timeouts, JSON-only boundary. This is process isolation, **not** a VM/container: sockets are not blocked at OS level (the code simply has no network API). Run the host in a container for stronger guarantees. Code that fails the static scan is never executed.
2. **Status is earned.** `VERIFIED` requires: static scan clean, all tests pass, ≥3 tests including an error case, 5 malformed inputs handled without crash/hang, resource limits, output-schema conformance. The model's claims never set a status.
3. **No silent replacement.** New versions are drafts; promotion needs TESTED/VERIFIED and may not downgrade the active version; rollback re-validates the target.
4. **Tools only fire from the user's own words** via deterministic patterns, never from model output or fetched content. External text is wrapped as untrusted data and instruction-like lines are removed.
5. **Permissions.** LOW/MEDIUM need the capability granted; HIGH/CRITICAL also need a single-use, 5-minute approval bound to the exact arguments (CRITICAL: type `CONFIRM`). Only the human user can change grants; `CORE_POLICY` is frozen code the evolution engine cannot touch. All decisions are audited.
6. **Memory is explicit.** Conversations are never stored automatically; secrets/cards are refused unless overridden and then excluded from prompts and exports. Retrieval uses local hashed n-gram vectors (offline) + keyword overlap + importance + recency — not neural embeddings (pgvector is not installed here).
7. **Voice uses the browser** (SpeechRecognition + speechSynthesis + Web Audio). Every state change is an event through a pure reducer (12 states). Wake word = phrase matching on live transcripts with per-language aliases; barge-in uses non-echo speech detection; mic level/VAD come from a real analyser.
8. **Model router**: per-task provider order, health probes, timeouts, 429 cooldowns, fallback, daily token budgets, token accounting, local-only mode, Ollama model discovery.

## Status matrix
| Area | Status | Notes |
|---|---|---|
| Sandbox, validator, skill registry, versioning | **Implemented, tested** | 11 seed skills VERIFIED by the real validator |
| Permissions, approvals, audit, SSRF guard, injection screen | **Implemented, tested** | self-check test 14 |
| Memory (6 layers, search, versions, export, delete) | **Implemented, tested** | |
| Multi-agent runs, critic, reassignment | **Implemented, tested** | verified `audit skill` run; model-based agents degrade without a model |
| Research | **Implemented, tested live** | Wikipedia reliable; DuckDuckGo is bot-blocked from some hosts |
| Skill acquisition | **Partial** | manual path tested end-to-end; model-generation path untested (no provider) |
| Model router / conversation | **Implemented, untested live** | needs a key or Ollama |
| Voice | **Partial** | state machine unit-tested; audio paths need a Chromium browser — use *Voice › self-test*. No Whisper/Piper/OpenWakeWord; offline recognition only where the browser supports on-device mode |
| Android | **Server contract only** | `/api/device/*` with hashed bearer tokens and per-device grants; no Kotlin client in this repo |
| Windows tools | **Implemented** | Windows commands only used when the server runs on Windows; Linux equivalents otherwise |
| Self-evaluation | **Implemented, tested** | approval-gated; cannot edit policy or source |

## Verification performed
`node --test tests/core.test.mjs` (19 pass). Against the running server: skill seeding/validation, 12 chat intents, approval single-use, sandbox escape/timeout/memory-bomb, SSRF blocks, manual acquisition → VERIFIED → reuse by trigger, device auth + grants, evolution analysis, and **System Monitor › Status & acceptance › Run self-check** (acceptance tests 4, 5, 8–14 executed automatically; 1–3 need a browser; 6–7 need a model; 15 is a manual review).

## Browser acceptance (manual)
Chrome/Edge on `https://` or `localhost`: Voice › *Enable wake word* → say "Hey JARVIS, what time is it" → hear the reply → speak over it to interrupt → ask a follow-up without the wake word. Unplug the mic or go offline to see ERROR/OFFLINE recovery.
