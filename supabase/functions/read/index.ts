// bookmark-app — read edge function (v2)
// POST /read { item_id, refresh?: boolean }                  -> { title, markdown, fetched_at, cached }
// POST /read { item_id, action: "thumbnail" }                -> { ok, thumbnail_url, via } | { error }
// POST /read { action: "thumbnail-all", limit?: number }     -> { checked, fixed, results[] }
// Auth: the viewer's Supabase user JWT (Authorization: Bearer …), verified with the anon client.
// Reader text comes from Jina Reader on first open and is cached in item_reader for 30 days.
// Thumbnail retries try, in order: the original image URL ingest found, a content image from Jina, a Microlink screenshot.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JINA_KEY = Deno.env.get("JINA_API_KEY") ?? "";
const MICROLINK_KEY = Deno.env.get("MICROLINK_API_KEY") ?? "";
const TTL_MS = 30 * 24 * 3600 * 1000;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
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

// ---------- thumbnail retry ----------
const BAD_IMG = /logo|icon|avatar|sprite|pixel|badge|emoji|tracking|1x1|blank|spacer|placeholder|\.svg(\?|$)/i;
const GOOD_IMG = /\.(jpe?g|png|webp|avif)(\?|$)|format=(jpe?g|png|webp)|\/image\//i;
async function jinaImages(url: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = { Accept: "application/json", "X-Timeout": "15", "X-With-Images-Summary": "true", "X-Retain-Images": "all" };
    if (JINA_KEY) headers.Authorization = `Bearer ${JINA_KEY}`;
    const r = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const j = await r.json(); const d = j?.data ?? {};
    const fromMap = d.images ? Object.values(d.images as Record<string, string>) : [];
    const fromMd = [...String(d.content ?? "").matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)/g)].map((m) => m[1]);
    const seen = new Set<string>(); const all: string[] = [];
    for (const u of [...fromMd, ...fromMap]) { if (!seen.has(u)) { seen.add(u); all.push(u); } }
    return all.filter((u) => !BAD_IMG.test(u)).sort((a, b) => Number(GOOD_IMG.test(b)) - Number(GOOD_IMG.test(a)));
  } catch { return []; }
}
async function microlinkScreenshot(url: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&viewport.width=1200&viewport.height=900`, { headers: MICROLINK_KEY ? { "x-api-key": MICROLINK_KEY } : {}, signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    return j?.status === "success" ? (j.data?.screenshot?.url ?? null) : null;
  } catch { return null; }
}
async function rehost(userId: string, itemId: string, src: string, referer: string): Promise<string | null> {
  try {
    const r = await fetch(src, { headers: { "User-Agent": BROWSER_UA, Referer: referer, Accept: "image/*,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!ct.startsWith("image/") || ct === "image/svg+xml") return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length < 2000 || bytes.length > 10 * 1024 * 1024) return null;   // < 2 KB is a tracking pixel or a broken icon
    const ext = ct === "image/png" ? "png" : ct === "image/webp" ? "webp" : ct === "image/gif" ? "gif" : ct === "image/avif" ? "avif" : "jpg";
    const path = `${userId}/${itemId}.${ext}`;
    const { error } = await db.storage.from("thumbs").upload(path, bytes, { contentType: ct, upsert: true });
    if (error) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/thumbs/${path}?v=${Date.now()}`;
  } catch { return null; }
}
async function retryThumbnail(userId: string, it: any): Promise<{ ok: boolean; thumbnail_url?: string; via?: string; error?: string }> {
  const page = it.canonical_url || it.url;
  const candidates: { src: string; via: string }[] = [];
  if (it.original_thumbnail_url) candidates.push({ src: it.original_thumbnail_url, via: "original" });
  for (const u of (await jinaImages(page)).slice(0, 4)) candidates.push({ src: u, via: "jina" });
  for (const c of candidates) {
    const hosted = await rehost(userId, it.id, c.src, page);
    if (hosted) return await save(hosted, c.src, c.via);
  }
  const shot = await microlinkScreenshot(page);
  if (shot) { const hosted = await rehost(userId, it.id, shot, page); if (hosted) return await save(hosted, shot, "screenshot"); }
  return { ok: false, error: `no usable image (${candidates.length} candidates${shot === null ? ", screenshot unavailable" : ""})` };

  async function save(hosted: string, original: string, via: string) {
    const err = String(it.error ?? "").split(";").map((e: string) => e.trim()).filter((e: string) => e && !/^thumbnail:/i.test(e)).join("; ");
    const status = err ? it.status : "ready";
    const { error } = await db.from("items").update({ thumbnail_url: hosted, original_thumbnail_url: it.original_thumbnail_url || original, status, error: err || null }).eq("id", it.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, thumbnail_url: hosted, via };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const userId = await userFromJwt(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  if (body.action === "thumbnail-all") {
    const limit = Math.min(Number(body.limit ?? 20), 40);
    const { data: rows, error } = await db.from("items").select("id,url,canonical_url,original_thumbnail_url,status,error").eq("user_id", userId).is("thumbnail_url", null).is("copied_from", null).order("created_at", { ascending: false }).limit(limit);
    if (error) return json({ error: error.message }, 500);
    const results = [];
    for (const it of rows ?? []) { const r = await retryThumbnail(userId, it); results.push({ id: it.id, url: it.canonical_url || it.url, ...r }); }
    // copies share the original's thumbnail: propagate
    for (const r of results) if (r.ok) await db.from("items").update({ thumbnail_url: r.thumbnail_url }).eq("copied_from", r.id).is("thumbnail_url", null);
    return json({ checked: results.length, fixed: results.filter((r) => r.ok).length, results });
  }

  const itemId = String(body.item_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return json({ error: "item_id required" }, 400);

  if (body.action === "thumbnail") {
    const { data: it, error } = await db.from("items").select("id,url,canonical_url,original_thumbnail_url,thumbnail_url,status,error,copied_from").eq("id", itemId).eq("user_id", userId).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!it) return json({ error: "not found" }, 404);
    const r = await retryThumbnail(userId, it);
    if (r.ok) await db.from("items").update({ thumbnail_url: r.thumbnail_url }).eq("copied_from", it.copied_from || it.id).is("thumbnail_url", null);
    return json(r, r.ok ? 200 : 502);
  }

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
