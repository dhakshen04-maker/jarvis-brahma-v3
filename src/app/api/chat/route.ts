import { handleMessage } from "@/lib/core/brahma";
import { errMsg } from "@/lib/util";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Streams BRAHMA CORE events as newline-delimited JSON. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { message?: string; conversationId?: string; voice?: boolean } | null;
  const text = typeof b?.message === "string" ? b.message.trim() : "";
  if (!text) return json({ error: "message is required" }, 400);
  const enc = new TextEncoder();
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {
          /* client went away */
        }
      };
      try {
        for await (const ev of handleMessage({ text, conversationId: b?.conversationId, voice: !!b?.voice, signal: ac.signal })) send(ev);
      } catch (e) {
        send({ t: "error", message: errMsg(e) });
      }
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
