import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const hash = (k: string) => createHash("sha256").update(`brahma-access:${k}`).digest("hex");
const attempts = new Map<string, { n: number; at: number }>();

function cookieOf(req: Request, name: string) {
  return (req.headers.get("cookie") ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

export async function GET(req: Request) {
  const key = process.env.BRAHMA_ACCESS_KEY;
  if (!key) return NextResponse.json({ protected: false, authed: true });
  return NextResponse.json({ protected: true, authed: cookieOf(req, "brahma_access") === hash(key) });
}

export async function POST(req: Request) {
  const key = process.env.BRAHMA_ACCESS_KEY;
  if (!key) return NextResponse.json({ error: "no access key is configured (set BRAHMA_ACCESS_KEY)" }, { status: 400 });
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const rec = attempts.get(ip);
  if (rec && Date.now() - rec.at < 60_000 && rec.n >= 8) return NextResponse.json({ error: "too many attempts, wait a minute" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  const a = Buffer.from(hash(String(body.key ?? "")));
  const b = Buffer.from(hash(key));
  if (!timingSafeEqual(a, b)) {
    attempts.set(ip, { n: rec && Date.now() - rec.at < 60_000 ? rec.n + 1 : 1, at: rec && Date.now() - rec.at < 60_000 ? rec.at : Date.now() });
    return NextResponse.json({ error: "incorrect key" }, { status: 401 });
  }
  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("brahma_access", hash(key), { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 14, secure: new URL(req.url).protocol === "https:" });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete("brahma_access");
  return res;
}
