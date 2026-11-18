/**
 * Cross-device layer. Paired devices (e.g. an Android client) authenticate with a bearer token whose
 * SHA-256 hash is stored server-side. The user grants each device specific capabilities; a command is
 * only queued when the device actually holds the grant. The Android app itself is NOT part of this
 * repository - this module is the real server-side contract it talks to:
 *   GET  /api/device/poll        -> pending commands
 *   POST /api/device/result      -> { commandId, ok, result }
 *   POST /api/device/chat        -> { message }
 *   GET  /api/device/skills      -> shared skill registry (read-only)
 *   GET  /api/device/memory?q=   -> memories the user marked as shared
 */
import { db } from "@/db";
import { deviceCommands, devices } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { randomToken, sha256 } from "@/lib/util";
import { audit } from "@/lib/log";

export const DEVICE_GRANTS = [
  { id: "launch_app", label: "Launch apps" },
  { id: "notify", label: "Show notifications" },
  { id: "device_info", label: "Report device info" },
  { id: "chat", label: "Talk to JARVIS" },
  { id: "skills.read", label: "Read shared skill registry" },
  { id: "memory.read", label: "Read memories marked shared" },
];

export async function createDevice(name: string, platform: string) {
  const token = `jb_${randomToken(24)}`;
  const [d] = await db.insert(devices).values({ name: name.slice(0, 60), platform: platform.slice(0, 30), tokenHash: sha256(token), granted: [] }).returning();
  await audit({ actor: "user", action: "device.pair", tool: d.name, risk: "MEDIUM", decision: "allowed" });
  return { device: publicDevice(d), token }; // the token is shown exactly once
}

type Dev = typeof devices.$inferSelect;
export function publicDevice(d: Dev) {
  const { tokenHash: _t, ...rest } = d;
  void _t;
  return { ...rest, online: !!d.lastSeen && Date.now() - d.lastSeen.getTime() < 5 * 60_000 };
}

export async function listDevices() {
  const rows = await db.select().from(devices).orderBy(desc(devices.createdAt));
  const cmds = await db.select().from(deviceCommands).orderBy(desc(deviceCommands.createdAt)).limit(30);
  return { devices: rows.map(publicDevice), commands: cmds };
}

export async function updateDeviceGrants(id: string, granted: string[]) {
  const valid = granted.filter((g) => DEVICE_GRANTS.some((x) => x.id === g));
  await db.update(devices).set({ granted: valid }).where(eq(devices.id, id));
  await audit({ actor: "user", action: "device.grants", tool: id, risk: "MEDIUM", decision: "allowed", details: { granted: valid } });
}

export async function deleteDevice(id: string) {
  await db.delete(deviceCommands).where(eq(deviceCommands.deviceId, id));
  await db.delete(devices).where(eq(devices.id, id));
  await audit({ actor: "user", action: "device.unpair", tool: id, risk: "MEDIUM", decision: "allowed" });
}

export async function authDevice(req: Request): Promise<Dev | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(jb_[a-f0-9]+)$/);
  if (!m) return null;
  const [d] = await db.select().from(devices).where(eq(devices.tokenHash, sha256(m[1]))).limit(1);
  if (!d) return null;
  await db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.id, d.id));
  return d;
}

export async function queueCommand(command: "launch_app" | "notify" | "device_info", args: Record<string, unknown>, deviceId?: string) {
  const all = await db.select().from(devices);
  if (all.length === 0) throw new Error("no Android device is paired (Settings > Devices)");
  const candidates = all.filter((d) => (!deviceId || d.id === deviceId) && d.platform.toLowerCase() === "android");
  if (candidates.length === 0) throw new Error("no paired Android device matches");
  const device = candidates.find((d) => d.granted.includes(command));
  if (!device) throw new Error(`the device has not been granted "${command}" - grant it in Settings > Devices (permissions are never assumed)`);
  const [row] = await db.insert(deviceCommands).values({ deviceId: device.id, command, args }).returning();
  const online = !!device.lastSeen && Date.now() - device.lastSeen.getTime() < 5 * 60_000;
  return { commandId: row.id, device: device.name, status: "queued", deviceOnline: online, note: online ? "device polled recently and will pick this up" : "device has not polled in the last 5 minutes; it will run when the device reconnects" };
}

export async function pollCommands(deviceId: string) {
  const rows = await db.select().from(deviceCommands).where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.status, "pending"))).limit(10);
  for (const r of rows) await db.update(deviceCommands).set({ status: "delivered" }).where(eq(deviceCommands.id, r.id));
  return rows.map((r) => ({ id: r.id, command: r.command, args: r.args }));
}

export async function completeCommand(deviceId: string, commandId: string, ok: boolean, result: Record<string, unknown>) {
  const rows = await db
    .update(deviceCommands)
    .set({ status: ok ? "completed" : "failed", result, completedAt: new Date() })
    .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, deviceId)))
    .returning({ id: deviceCommands.id });
  return rows.length > 0;
}
