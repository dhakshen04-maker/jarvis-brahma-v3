import { body, json, route, str } from "@/lib/api";
import { createDevice, DEVICE_GRANTS, deleteDevice, listDevices, updateDeviceGrants } from "@/lib/devices";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";

export const GET = route(async () => json({ ...(await listDevices()), grantOptions: DEVICE_GRANTS }));

/** Pairs a new device; the bearer token is returned exactly once. */
export const POST = route(async (req: Request) => {
  const b = await body(req);
  if (!str(b.name).trim()) return json({ error: "name required" }, 400);
  return json(await createDevice(str(b.name).trim(), str(b.platform, "android")));
});

export const PATCH = route(async (req: Request) => {
  const b = await body<{ id?: string; granted?: string[] }>(req);
  if (!isUuid(b.id)) return json({ error: "invalid id" }, 400);
  await updateDeviceGrants(b.id, Array.isArray(b.granted) ? b.granted.map(String) : []);
  return json({ ok: true });
});

export const DELETE = route(async (req: Request) => {
  const b = await body<{ id?: string }>(req);
  if (!isUuid(b.id)) return json({ error: "invalid id" }, 400);
  await deleteDevice(b.id);
  return json({ ok: true });
});
