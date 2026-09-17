// bookmark-app — read edge function (v1.3 batch 3)
// POST /read { item_id, refresh?: boolean }  -> { title, markdown, fetched_at, cached }
// Auth: the viewer's Supabase user JWT (Authorization: Bearer …), verified with the anon client.
// Fetches the article as markdown via Jina Reader on first open, caches it in item_reader for 30 days.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JINA_KEY = Deno.env.get("JINA_API_KEY") ?? "";
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_CHARS = 200_000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function userFromJwt(req: Request): Promise<string | null> {
  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user.id;
}

async function jinaMarkdown(url: string, retried = false): Promise<{ title?: string; markdown: string } | { error: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json", "X-Timeout": "15", "X-Retain-Images": "all" };
    if (JINA_KEY) headers.Authorization = `Bearer ${JINA_KEY}`;
    const r = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(20000) });
    if (r.status === 429 && !retried) { await new Promise((res) => setTimeout(res, 1500)); return jinaMarkdown(url, true); }
    if (!r.ok) return { error: `reader ${r.status}` };
    const j = await r.json();
    const content = typeof j?.data?.content === "string" ? j.data.content.trim() : "";
    if (content.length < 200) return { error: "reader returned no article text" };
    return { title: j.data.title || undefined, markdown: content.slice(0, MAX_CHARS) };
  } catch (e) {
    return { error: `reader failed: ${(e as Error).message}` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const userId = await userFromJwt(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const itemId = String(body.item_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return json({ error: "item_id required" }, 400);

  const { data: it, error } = await db.from("items").select("id,url,canonical_url,title").eq("id", itemId).eq("user_id", userId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!it) return json({ error: "not found" }, 404);

  const { data: cached } = await db.from("item_reader").select("title,markdown,fetched_at").eq("item_id", it.id).maybeSingle();
  const fresh = cached && Date.now() - Date.parse(cached.fetched_at) < TTL_MS;
  if (fresh && body.refresh !== true) return json({ title: cached.title || it.title, markdown: cached.markdown, fetched_at: cached.fetched_at, cached: true });

  const t0 = Date.now();
  const r = await jinaMarkdown(it.canonical_url || it.url);
  if ("error" in r) {
    // Serve a stale copy if we have one rather than nothing.
    if (cached) return json({ title: cached.title || it.title, markdown: cached.markdown, fetched_at: cached.fetched_at, cached: true, stale: true, warning: r.error });
    return json({ error: r.error, ms: Date.now() - t0 }, 502);
  }
  const fetched_at = new Date().toISOString();
  await db.from("item_reader").upsert({ item_id: it.id, user_id: userId, title: r.title ?? null, markdown: r.markdown, fetched_at });
  return json({ title: r.title || it.title, markdown: r.markdown, fetched_at, cached: false, ms: Date.now() - t0 });
});
