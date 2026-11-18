import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { body, json, route } from "@/lib/api";
import { isUuid } from "@/lib/util";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    if (!isUuid(id)) return json({ error: "invalid id" }, 400);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt).limit(200);
    return json({ messages: rows });
  }
  const rows = await db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(30);
  return json({ conversations: rows });
});

/** User-initiated deletion of a conversation and its messages. */
export const DELETE = route(async (req: Request) => {
  const { id } = await body<{ id?: string }>(req);
  if (!isUuid(id)) return json({ error: "invalid id" }, 400);
  await db.delete(messages).where(eq(messages.conversationId, id));
  await db.delete(conversations).where(eq(conversations.id, id));
  return json({ ok: true });
});
