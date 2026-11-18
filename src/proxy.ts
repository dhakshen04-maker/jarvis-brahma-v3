import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Optional access gate. When BRAHMA_ACCESS_KEY is set, every page and API route requires the
 * signed-in cookie (set by POST /api/auth). Device endpoints use their own bearer tokens;
 * /api/health stays open for the platform health check.
 */
const hash = (k: string) => createHash("sha256").update(`brahma-access:${k}`).digest("hex");

export function proxy(req: NextRequest) {
  const key = process.env.BRAHMA_ACCESS_KEY;
  if (!key) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname === "/api/health" || pathname === "/api/auth" || pathname === "/login" || pathname.startsWith("/api/device/")) return NextResponse.next();
  const cookie = req.cookies.get("brahma_access")?.value ?? "";
  const expected = hash(key);
  const ok = cookie.length === expected.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(expected));
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|images/|favicon.ico).*)"] };
