/**
 * Host tools: system information, processes, workspace-bounded filesystem, allow-listed apps and scripts.
 * All filesystem access is confined to data/workspace (symlink-safe). Deleted files move to data/trash
 * with a sidecar record so every deletion is reversible.
 */
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

export const WORKSPACE = path.join(process.cwd(), "data", "workspace");
export const TRASH = path.join(process.cwd(), "data", "trash");

async function ensureDirs() {
  await fs.mkdir(path.join(WORKSPACE, "scripts"), { recursive: true });
  await fs.mkdir(TRASH, { recursive: true });
}

export async function safePath(rel: string): Promise<string> {
  await ensureDirs();
  const abs = path.resolve(WORKSPACE, rel || ".");
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) throw new Error("path is outside the workspace boundary");
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(/*turbopackIgnore: true*/ probe);
      const root = await fs.realpath(WORKSPACE);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error("path escapes the workspace boundary via symlink");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(probe);
        if (parent === probe) throw new Error("invalid path");
        probe = parent;
        continue;
      }
      throw e;
    }
  }
  return abs;
}

const relOf = (abs: string) => path.relative(WORKSPACE, abs).split(path.sep).join("/") || ".";

// ---------- system ----------
export function systemInfo() {
  const cpus = os.cpus();
  return {
    platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname(),
    cpuModel: cpus[0]?.model ?? "unknown", cores: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / 1048576), uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10, node: process.version,
  };
}

let lastSample = { at: 0, idle: 0, total: 0 };
let lastPct = 0;
function snapshot() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { at: Date.now(), idle, total };
}
export async function cpuPercent(): Promise<number> {
  if (lastSample.at === 0) {
    lastSample = snapshot();
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = snapshot();
  if (now.at - lastSample.at >= 200) {
    const dTotal = now.total - lastSample.total;
    const dIdle = now.idle - lastSample.idle;
    if (dTotal > 0) lastPct = Math.round((1 - dIdle / dTotal) * 1000) / 10;
    lastSample = now;
  }
  return lastPct;
}

export async function systemResources() {
  const total = os.totalmem();
  const free = os.freemem();
  const mem = process.memoryUsage();
  return {
    cpuPercent: await cpuPercent(), cores: os.cpus().length, loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    ramUsedMb: Math.round((total - free) / 1048576), ramTotalMb: Math.round(total / 1048576), ramPercent: Math.round(((total - free) / total) * 1000) / 10,
    serverRssMb: Math.round(mem.rss / 1048576), serverHeapMb: Math.round(mem.heapUsed / 1048576), uptimeSec: Math.round(os.uptime()),
  };
}

function exec(cmd: string, args: string[], timeout = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 2_000_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export async function listProcesses(limit = 15) {
  const n = Math.min(Math.max(limit, 1), 50);
  if (os.platform() === "win32") {
    const out = await exec("tasklist", ["/FO", "CSV", "/NH"]);
    return out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^"|"$/g, "").split('","')).map((c) => ({ pid: Number(c[1]), name: c[0], memoryKb: Number((c[4] ?? "0").replace(/[^\d]/g, "")) })).sort((a, b) => b.memoryKb - a.memoryKb).slice(0, n);
  }
  const out = await exec("ps", ["-eo", "pid,pcpu,rss,comm", "--sort=-pcpu"]);
  return out.split("\n").slice(1).filter(Boolean).slice(0, n).map((l) => {
    const p = l.trim().split(/\s+/);
    return { pid: Number(p[0]), cpuPercent: Number(p[1]), memoryKb: Number(p[2]), name: p.slice(3).join(" ") };
  });
}

export async function killProcess(pid: number) {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error("refusing to signal a system process id");
  if (pid === process.pid || pid === process.ppid) throw new Error("refusing to terminate the JARVIS server or its parent");
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`no such process: ${pid}`);
  }
  process.kill(pid, "SIGTERM");
  return { pid, signal: "SIGTERM" };
}

// ---------- filesystem ----------
export async function fsList(rel: string) {
  const dir = await safePath(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries.slice(0, 200).map(async (e) => {
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      return { name: e.name, type: e.isDirectory() ? "dir" : "file", sizeBytes: st?.size ?? 0, modified: st?.mtime.toISOString() ?? null };
    }),
  );
  return { path: relOf(dir), count: entries.length, entries: out };
}

export async function fsRead(rel: string, maxBytes = 65_536) {
  const file = await safePath(rel);
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error("not a file");
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    await fh.read(buf, 0, buf.length, 0);
    return { path: relOf(file), sizeBytes: st.size, truncated: st.size > maxBytes, content: buf.toString("utf8") };
  } finally {
    await fh.close();
  }
}

export async function fsSearch(query: string, rel = ".") {
  const root = await safePath(rel);
  const q = query.toLowerCase();
  const results: Array<{ path: string; match: "name" | "content"; snippet?: string }> = [];
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (depth > 6 || visited > 3000 || results.length >= 40) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.isSymbolicLink()) continue;
      visited++;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q)) results.push({ path: relOf(full), match: "name" });
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.(txt|md|json|csv|js|ts|py|html|css|log|yml|yaml|ini|cfg)$/i.test(e.name)) {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.size < 256_000) {
          const text = await fs.readFile(full, "utf8").catch(() => "");
          const i = text.toLowerCase().indexOf(q);
          if (i >= 0 && !e.name.toLowerCase().includes(q)) results.push({ path: relOf(full), match: "content", snippet: text.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, " ") });
        }
      }
    }
  }
  await walk(root, 0);
  return { query, scanned: visited, results };
}

export async function fsMkdir(rel: string) {
  const dir = await safePath(rel);
  await fs.mkdir(dir, { recursive: true });
  return { path: relOf(dir), created: true };
}

export async function fsWrite(rel: string, content: string, overwrite = false) {
  if (content.length > 262_144) throw new Error("content exceeds 256 KB");
  const file = await safePath(rel);
  let backedUp: string | null = null;
  const exists = await fs.stat(file).then(() => true, () => false);
  if (exists) {
    if (!overwrite) throw new Error("file exists; pass overwrite=true to replace it (the old version is backed up)");
    backedUp = await moveToTrash(file, "overwritten");
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return { path: relOf(file), bytes: Buffer.byteLength(content), backedUpAs: backedUp };
}

async function moveToTrash(file: string, reason: string): Promise<string> {
  await ensureDirs();
  const id = `${Date.now()}-${path.basename(file)}`;
  await fs.copyFile(file, path.join(TRASH, id));
  await fs.writeFile(path.join(TRASH, `${id}.json`), JSON.stringify({ original: relOf(file), reason, at: new Date().toISOString() }));
  return id;
}

export async function fsDelete(rel: string) {
  const file = await safePath(rel);
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error("only files can be deleted (directories are never deleted automatically)");
  const trashId = await moveToTrash(file, "deleted");
  await fs.rm(file);
  return { path: relOf(file), trashId, recoverable: true };
}

export async function fsRestore(trashId: string) {
  await ensureDirs();
  if (!/^[\w.-]+$/.test(trashId)) throw new Error("invalid trash id");
  const meta = JSON.parse(await fs.readFile(path.join(TRASH, `${trashId}.json`), "utf8")) as { original: string };
  const target = await safePath(meta.original);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(TRASH, trashId), target);
  return { restoredTo: relOf(target) };
}

export async function fsTrashList() {
  await ensureDirs();
  const names = (await fs.readdir(TRASH)).filter((n) => n.endsWith(".json"));
  return Promise.all(names.slice(-50).map(async (n) => ({ id: n.replace(/\.json$/, ""), ...(JSON.parse(await fs.readFile(path.join(TRASH, n), "utf8")) as object) })));
}

// ---------- apps & scripts ----------
const APPS: Record<string, Record<string, [string, string[]]>> = {
  win32: { notepad: ["notepad.exe", []], calculator: ["calc.exe", []], paint: ["mspaint.exe", []], explorer: ["explorer.exe", []], "task manager": ["taskmgr.exe", []], edge: ["msedge.exe", []], chrome: ["chrome.exe", []], vscode: ["code", []] },
  darwin: { calculator: ["open", ["-a", "Calculator"]], notes: ["open", ["-a", "Notes"]], safari: ["open", ["-a", "Safari"]], terminal: ["open", ["-a", "Terminal"]] },
  linux: { calculator: ["gnome-calculator", []], files: ["xdg-open", [WORKSPACE]], browser: ["xdg-open", ["about:blank"]], terminal: ["x-terminal-emulator", []] },
};

export function allowedApps(): string[] {
  return Object.keys(APPS[os.platform()] ?? {});
}

export async function openApp(name: string) {
  const table = APPS[os.platform()] ?? {};
  const entry = table[name.toLowerCase().trim()];
  if (!entry) throw new Error(`"${name}" is not in the allow-list for ${os.platform()}. Allowed: ${allowedApps().join(", ") || "none"}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ entry[0], entry[1], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (e) => reject(new Error(`could not launch ${name}: ${e.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return { launched: name };
}

export async function runScript(rel: string, args: string[] = []) {
  const file = await safePath(path.posix.join("scripts", rel.replace(/^scripts[\\/]/, "")));
  const ext = path.extname(file).toLowerCase();
  let cmd: string;
  let argv: string[];
  if (ext === ".js") {
    cmd = process.execPath;
    argv = ["--permission", `--allow-fs-read=${WORKSPACE}`, `--allow-fs-write=${WORKSPACE}`, file, ...args.slice(0, 10).map(String)];
  } else if (ext === ".py") {
    cmd = os.platform() === "win32" ? "python" : "python3";
    argv = [file, ...args.slice(0, 10).map(String)];
  } else throw new Error("only .js (permission-restricted) and .py scripts are supported");
  const env = {} as NodeJS.ProcessEnv;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return new Promise<{ exitCode: number | null; output: string; sandboxed: boolean }>((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ cmd, argv, { cwd: WORKSPACE, env, timeout: 15_000, windowsHide: true });
    let out = "";
    const take = (c: Buffer) => { if (out.length < 20_000) out += c.toString("utf8"); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => reject(new Error(`could not run script: ${e.message}`)));
    child.on("close", (code) => resolve({ exitCode: code, output: out.slice(0, 20_000), sandboxed: ext === ".js" }));
  });
}
