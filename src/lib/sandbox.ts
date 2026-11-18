/**
 * Skill sandbox.
 *
 * Isolation layers (defence in depth - this is process isolation, NOT a VM or container):
 *  1. Separate Node child process started with the Node permission model (`--permission`):
 *     no filesystem, no child processes, no worker threads, no native addons.
 *  2. V8 heap cap (--max-old-space-size) - memory bombs abort the child.
 *  3. Environment stripped (no API keys / DATABASE_URL reach the child).
 *  4. Code runs inside a `vm` context created from a null-prototype object with
 *     `codeGeneration.strings = false` (no eval / new Function). The context has no
 *     require, process, fetch, timers or any I/O primitive.
 *  5. vm timeout (sync loops) + parent-side hard kill timer.
 *  6. Only JSON crosses the boundary in both directions.
 *
 * Known limit: the Node permission model of Node 22 does not restrict network sockets at
 * the OS level; code simply has no API to open one. Run the host inside a container for
 * stronger guarantees.
 *
 * Skill contract: define `function run(input) { ... return jsonSerializableValue; }` (synchronous).
 */
import { spawn } from "node:child_process";

const RUNNER = String.raw`
'use strict';
const vm = require('vm');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) { data += c; });
process.stdin.on('end', function () {
  const t0 = process.hrtime.bigint();
  let out;
  try {
    const job = JSON.parse(data);
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext('var __logs=[];var console={log:function(){__logs.push(Array.prototype.join.call(arguments," ").slice(0,500))}};console.info=console.log;console.warn=console.log;console.error=console.log;', ctx, { timeout: 1000 });
    vm.runInContext(job.code, ctx, { timeout: job.timeout, filename: 'skill.js' });
    if (vm.runInContext('typeof run', ctx) !== 'function') throw new Error('skill must define a function named run(input)');
    vm.runInContext('var __in=JSON.parse(' + JSON.stringify(JSON.stringify(job.input === undefined ? null : job.input)) + ');', ctx, { timeout: 1000 });
    const raw = vm.runInContext('(function(){var v=run(__in);if(v&&typeof v.then==="function")throw new Error("async skills are not supported; run(input) must be synchronous");var s=JSON.stringify(v===undefined?null:v);return JSON.stringify({s:s,logs:__logs.slice(0,50)})})()', ctx, { timeout: job.timeout });
    const parsed = JSON.parse(raw);
    out = { ok: true, value: JSON.parse(parsed.s), logs: parsed.logs };
  } catch (e) {
    let msg = 'unknown error';
    try { msg = String(e && e.message !== undefined ? e.message : e).slice(0, 500); } catch (x) {}
    out = { ok: false, error: msg, timedOut: /timed out/i.test(msg) };
  }
  const ru = process.resourceUsage();
  out.durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  out.heapMb = process.memoryUsage().heapUsed / 1048576;
  out.cpuMs = (ru.userCPUTime + ru.systemCPUTime) / 1000;
  process.stdout.write(JSON.stringify(out));
});
`;

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  wallMs: number;
  heapMb: number;
  cpuMs: number;
  timedOut: boolean;
  crashed: boolean;
}

export interface SandboxOptions {
  code: string;
  input: unknown;
  timeoutMs?: number;
  maxHeapMb?: number;
}

const MAX_CONCURRENT = 3;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

export function sandboxStats() {
  return { active, queued: waiters.length, maxConcurrent: MAX_CONCURRENT };
}

export async function runInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 2000, 100), 15000);
  const maxHeap = Math.min(Math.max(opts.maxHeapMb ?? 64, 16), 256);
  if (opts.code.length > 100_000) {
    return fail("skill code exceeds 100 KB limit", 0);
  }
  await acquire();
  const started = Date.now();
  try {
    return await new Promise<SandboxResult>((resolve) => {
      const env = {} as NodeJS.ProcessEnv;
      if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // required for node.exe on Windows
      const child = spawn(
        process.execPath,
        ["--permission", `--max-old-space-size=${maxHeap}`, "--eval", RUNNER],
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let killed = false;
      const killer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs + 2500);
      child.stdout.on("data", (c: Buffer) => {
        if (stdout.length < 300_000) stdout += c.toString("utf8");
      });
      child.stderr.on("data", () => {});
      child.on("error", (e) => {
        clearTimeout(killer);
        resolve(fail(`sandbox could not start: ${e.message}`, Date.now() - started, true));
      });
      child.on("close", () => {
        clearTimeout(killer);
        const wallMs = Date.now() - started;
        if (killed) {
          resolve({ ...fail("execution exceeded hard time limit and was killed", wallMs), timedOut: true });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            ok: !!parsed.ok,
            value: parsed.value,
            error: parsed.error,
            logs: parsed.logs ?? [],
            durationMs: parsed.durationMs ?? 0,
            wallMs,
            heapMb: parsed.heapMb ?? 0,
            cpuMs: parsed.cpuMs ?? 0,
            timedOut: !!parsed.timedOut,
            crashed: false,
          });
        } catch {
          resolve(fail("sandbox process crashed (likely exceeded the memory limit)", wallMs, true));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ code: opts.code, input: opts.input ?? null, timeout: timeoutMs }));
    });
  } finally {
    release();
  }
}

function fail(error: string, wallMs: number, crashed = false): SandboxResult {
  return { ok: false, error, logs: [], durationMs: 0, wallMs, heapMb: 0, cpuMs: 0, timedOut: false, crashed };
}
