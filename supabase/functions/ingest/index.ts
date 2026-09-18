// bookmark-app — ingest edge function (v8)
// POST /ingest  { url, mode?: "auto" | "board", board_id?, board_name?, note? }
// Auth: x-api-key header (static key issued per user, hashed in public.api_keys)
//
// Pipeline: canonicalize -> dedupe -> metadata (oEmbed / OpenGraph / Microlink / Jina / URL slug)
//           -> rehost thumbnail -> classify (OpenAI) -> insert -> respond

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4-mini";
const MICROLINK_KEY = Deno.env.get("MICROLINK_API_KEY") ?? "";
const CONFIDENCE_FLOOR = Number(Deno.env.get("CONFIDENCE_FLOOR") ?? "0.45");

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

type Source = "instagram" | "tiktok" | "youtube" | "amazon" | "article" | "other";
interface Meta {
  title?: string; description?: string; author?: string; site_name?: string;
  image?: string; provider?: string; raw?: Record<string, unknown>;
}

// ---------- auth ----------
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function authenticate(req: Request): Promise<string | null> {
  const key = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key || !key.startsWith("bk_")) return null;
  const hash = await sha256(key);
  const { data } = await db.from("api_keys").select("user_id").eq("key_hash", hash).maybeSingle();
  if (!data) return null;
  db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", hash).then(() => {});
  return data.user_id as string;
}

// ---------- url handling ----------
const TRACKING = /^(utm_|igsh|igshid|fbclid|gclid|dclid|msclkid|mc_|ref$|ref_|_r$|si$|feature$|share_id|s$|t$|pp$|_t$|_branch|is_from_webapp|sender_device|web_id|source$|ncid|cmpid)/i;
const SHORTENERS = new Set(["vm.tiktok.com", "vt.tiktok.com", "t.co", "bit.ly", "a.co", "amzn.to", "amzn.eu", "tinyurl.com", "buff.ly", "lnkd.in", "l.instagram.com", "pin.it", "redd.it", "goo.gl", "ow.ly", "rb.gy", "cutt.ly", "shorturl.at", "on.soundcloud.com", "spoti.fi", "apple.co", "trib.al", "nyti.ms", "wapo.st"]);

async function resolveRedirects(url: string): Promise<string> {
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(6000) });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.url || url;
  } catch { return url; }
}

function detectSource(host: string): Source {
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) || host === "a.co" || host === "amzn.to") return "amazon";
  return "article";
}

function youtubeId(u: URL): string | null {
  if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (u.searchParams.get("v")) return u.searchParams.get("v");
  const m = u.pathname.match(/\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
  return m ? m[2] : null;
}

async function canonicalize(input: string): Promise<{ url: string; source: Source }> {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u = new URL(raw);
  if (SHORTENERS.has(u.hostname.replace(/^www\./, ""))) u = new URL(await resolveRedirects(u.toString()));
  u.hostname = u.hostname.toLowerCase();
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const source = detectSource(host);

  if (source === "youtube") {
    const id = youtubeId(u);
    if (id) {
      const isShort = /\/shorts\//.test(u.pathname);
      return { url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, source };
    }
  }
  if (source === "instagram") {
    const m = u.pathname.match(/\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    if (m) return { url: `https://www.instagram.com/${m[1] === "reels" ? "reel" : m[1]}/${m[2]}/`, source };
  }
  if (source === "tiktok") {
    const m = u.pathname.match(/(\/@[^/]+)?\/(video|photo)\/(\d+)/);
    if (m) return { url: `https://www.tiktok.com${m[1] ?? ""}/${m[2]}/${m[3]}`, source };
  }
  if (source === "amazon") {
    const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
    if (m) return { url: `https://${u.hostname}/dp/${m[1].toUpperCase()}`, source };
  }
  // generic: drop tracking params + hash
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hash = "";
  let s = u.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  return { url: s, source };
}

// ---------- metadata ----------
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt|nbsp|#39);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&"; if (l === "quot") return '"'; if (l === "apos" || l === "#39") return "'";
    if (l === "lt") return "<"; if (l === "gt") return ">"; if (l === "nbsp") return " ";
    if (l.startsWith("#x")) return String.fromCodePoint(parseInt(l.slice(2), 16));
    if (l.startsWith("#")) return String.fromCodePoint(parseInt(l.slice(1), 10));
    return m;
  }).trim();
}
function parseMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const metaRe = /<meta\s+[^>]*?>/gi;
  for (const tag of html.match(metaRe) ?? []) {
    const key = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content && !(key in out)) out[key] = decodeEntities(content);
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (t) out["_title"] = decodeEntities(t.replace(/\s+/g, " "));
  return out;
}
async function fetchHtml(url: string, ua: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "";
    if (!/html|xml/.test(ct)) return null;
    const reader = r.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let total = 0;
    while (total < 600_000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
    try { reader.cancel(); } catch { /* ignore */ }
    const buf = new Uint8Array(total); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch { return null; }
}
async function openGraph(url: string, ua = BROWSER_UA): Promise<Meta | null> {
  const html = await fetchHtml(url, ua);
  if (!html) return null;
  const m = parseMetaTags(html);
  const title = m["og:title"] ?? m["twitter:title"] ?? m["_title"];
  const meta: Meta = {
    title, description: m["og:description"] ?? m["twitter:description"] ?? m["description"],
    image: m["og:image"] ?? m["og:image:url"] ?? m["og:image:secure_url"] ?? m["twitter:image"] ?? m["twitter:image:src"],
    site_name: m["og:site_name"], author: m["author"] ?? m["article:author"] ?? m["twitter:creator"], provider: "opengraph", raw: m,
  };
  // Instagram/TikTok login walls still return og tags for the login page — treat those as misses.
  if (!meta.title || /^(login|log in|instagram|tiktok)\s*$/i.test(meta.title)) return meta.image ? meta : null;
  return meta;
}
async function oembed(endpoint: string): Promise<Meta | null> {
  try {
    const r = await fetch(endpoint, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, author: j.author_name, image: j.thumbnail_url, site_name: j.provider_name, provider: "oembed", raw: j };
  } catch { return null; }
}
// Jina Reader: handles many bot-walled sites; returns title/description/content/images as JSON.
async function jina(url: string, retried = false): Promise<Meta | null> {
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "Accept": "application/json", "X-With-Images-Summary": "true", "X-Timeout": "10", "X-Retain-Images": "all" },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 429 && !retried) { await new Promise((res) => setTimeout(res, 1500)); return jina(url, true); }
    if (!r.ok) return null;
    const j = await r.json();
    const d = j.data; if (!d) return null;
    const imgs = d.images ? Object.values(d.images as Record<string, string>) : [];
    const image = imgs.find((u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !/logo|icon|avatar|sprite|pixel|badge/i.test(u)) ?? imgs[0];
    const content = typeof d.content === "string" ? d.content.replace(/\s+/g, " ").trim() : "";
    return { title: d.title, description: d.description || (content ? content.slice(0, 600) : undefined), image, provider: "jina", raw: { title: d.title, description: d.description, imageCount: imgs.length } };
  } catch { return null; }
}
let lastMicrolinkError = "";
async function microlink(url: string): Promise<Meta | null> {
  try {
    lastMicrolinkError = "";
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true`, {
      headers: MICROLINK_KEY ? { "x-api-key": MICROLINK_KEY } : {}, signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    if (j.status !== "success" || !j.data) { lastMicrolinkError = `${r.status} ${j.code ?? ""} ${j.message ?? ""}`.trim(); return null; }
    const d = j.data;
    return { title: d.title, description: d.description, author: d.author, site_name: d.publisher, image: d.image?.url ?? d.logo?.url, provider: "microlink", raw: d };
  } catch (e) { lastMicrolinkError = String(e); return null; }
}
function merge(...metas: (Meta | null)[]): Meta {
  const out: Meta = {};
  for (const m of metas) if (m) for (const [k, v] of Object.entries(m)) if (v && !(out as any)[k]) (out as any)[k] = v;
  return out;
}
function cleanTitle(t: string | undefined, source: Source): string | undefined {
  if (!t) return t;
  let s = t.replace(/\s+/g, " ").trim();
  s = s.replace(/^Amazon\.com\s*:\s*/i, "").replace(/\s*[•|–-]\s*(Instagram( reel| photo| video)?|TikTok|YouTube|Wikipedia)\s*$/i, "");
  if (source === "instagram") s = s.replace(/\s*•\s*Instagram.*$/i, "");
  return s || undefined;
}
// Instagram OG description looks like: `109K likes, 1,001 comments - nasa on August 18, 2026: “caption…”`
function parseInstagramDescription(meta: Meta): Meta {
  const d = meta.description ?? "";
  const m = d.match(/^(?:[\d.,]+[KMB]?\s+likes?,\s*)?(?:[\d.,]+[KMB]?\s+comments?\s*-\s*)?([A-Za-z0-9_.]+)\s+on\s+[A-Z][a-z]+ \d{1,2}, \d{4}:\s*[“"']?([\s\S]*?)[”"']?\s*$/);
  if (!m) return meta;
  const handle = m[1]; const caption = m[2].trim().replace(/[\u201d"']+\.?$/, "").trim();
  const firstLine = caption.split(/\n|(?<=[.!?])\s+/)[0]?.trim() ?? caption;
  const title = firstLine.length > 90 ? firstLine.slice(0, 87).replace(/\s+\S*$/, "") + "…" : firstLine;
  return { ...meta, title: title || meta.title, description: caption || meta.description, author: meta.author?.startsWith("@") ? meta.author : `@${handle}` };
}
// Bot walls and 404s still "succeed" with junk: detect and discard so the slug fallback kicks in.
const JUNK_TITLE = /^(access denied|just a moment|attention required|page not found|404|403|are you a robot|robot or human|bot verification|please verify|blocked|error)\b|\b(page not found|access denied|not found)\s*$/i;
function isJunk(meta: Meta | null, pageUrl: string): boolean {
  if (!meta) return true;
  const t = (meta.title ?? "").trim();
  const lastSeg = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!t) return !meta.image;
  if (JUNK_TITLE.test(t)) return true;
  if (t === lastSeg || /^\d{6,}$/.test(t)) return true;          // title is just the URL id
  if (meta.image && /akamai|cloudflare|captcha/i.test(meta.image)) return true;
  return false;
}
// Human-readable title from the URL path, e.g. /the-best-slow-cooked-bolognese-sauce-recipe -> "The Best Slow Cooked Bolognese Sauce Recipe"
function slugTitle(pageUrl: string): string | undefined {
  const u = new URL(pageUrl);
  const segs = u.pathname.split("/").filter((s) => s && /[a-z]{3,}/i.test(s) && !/^\d+$/.test(s) && !/\.(html?|php|aspx?)$/i.test(s) || /\.(html?|php|aspx?)$/i.test(s));
  const pick = segs.filter((s) => /[-_]/.test(s)).pop() ?? segs.pop();
  if (!pick) return undefined;
  const words = pick.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  if (words.length < 6) return undefined;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}
function absolutize(meta: Meta | null, pageUrl: string): Meta | null {
  if (meta?.image) { try { meta.image = new URL(meta.image, pageUrl).toString(); } catch { meta.image = undefined; } }
  return meta;
}
async function fetchMetadata(url: string, source: Source): Promise<Meta> {
  let m: Meta;
  if (source === "youtube") {
    const [oe, og] = await Promise.all([oembed(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`), openGraph(url)]);
    const id = youtubeId(new URL(url));
    m = merge(oe, og);
    if (id && !m.image) m.image = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    m.site_name = "YouTube";
  } else if (source === "tiktok") {
    const oe = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    m = oe?.image ? oe : merge(oe, await microlink(url));
    m.site_name = "TikTok";
  } else if (source === "instagram") {
    // Direct fetch is usually login-walled. Microlink's free tier can't proxy Instagram (EPROXYNEEDED); Jina Reader can.
    let og = absolutize(await openGraph(url, BOT_UA), url);
    if (isJunk(og, url)) og = null;
    if (!og?.image) {
      const [jn, ml] = await Promise.all([jina(url), microlink(url)]);
      og = merge(og, absolutize(isJunk(jn, url) ? null : jn, url), isJunk(ml, url) ? null : ml);
    }
    if (og?.title) { const t = og.title.match(/^(.+?) on Instagram:\s*["\u201c]([\s\S]*)["\u201d]\s*$/); if (t) { og.author = og.author ?? t[1]; og.title = t[2].trim(); } }
    m = parseInstagramDescription({ ...og, site_name: "Instagram" });
  } else {
    let og = absolutize(await openGraph(url), url);
    if (isJunk(og, url)) og = null;
    if (!og?.image || !og?.title) { const ml = await microlink(url); og = merge(og, isJunk(ml, url) ? null : ml); }
    if (!og?.title) { const jn = absolutize(await jina(url), url); og = merge(og, isJunk(jn, url) ? null : jn); }
    m = og ?? {};
  }
  m.title = cleanTitle(m.title, source);
  if (!m.title) { const s = slugTitle(url); if (s) { m.title = s; m.provider = m.provider ?? "slug"; } }
  return m;
}

// ---------- thumbnail rehost ----------
async function rehostThumbnail(userId: string, itemId: string, src: string, referer: string): Promise<string | null> {
  try {
    const r = await fetch(src, { headers: { "User-Agent": BROWSER_UA, "Referer": referer, "Accept": "image/*,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!ct.startsWith("image/")) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length < 200 || bytes.length > 10 * 1024 * 1024) return null;
    const ext = ct === "image/png" ? "png" : ct === "image/webp" ? "webp" : ct === "image/gif" ? "gif" : ct === "image/avif" ? "avif" : "jpg";
    const path = `${userId}/${itemId}.${ext}`;
    const { error } = await db.storage.from("thumbs").upload(path, bytes, { contentType: ct, upsert: true });
    if (error) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/thumbs/${path}`;
  } catch { return null; }
}

// ---------- classification ----------
interface Board { id: string; name: string; description: string; item_count?: number }
interface Classification {
  board_name: string; is_new_board: boolean; board_description: string;
  confidence: number; tags: string[]; summary: string; reasoning: string;
}
const SCHEMA = {
  name: "classification", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      board_name: { type: "string" }, is_new_board: { type: "boolean" }, board_description: { type: "string" },
      confidence: { type: "number" }, tags: { type: "array", items: { type: "string" } },
      summary: { type: "string" }, reasoning: { type: "string" },
    },
    required: ["board_name", "is_new_board", "board_description", "confidence", "tags", "summary", "reasoning"],
  },
};
async function classify(meta: Meta, url: string, source: Source, boards: Board[], note?: string, modelOverride?: string): Promise<{ result?: Classification; model?: string; error?: string }> {
  if (!OPENAI_API_KEY) return { error: "OPENAI_API_KEY not set" };
  const boardList = boards.length
    ? boards.map((b) => `- ${b.name}${b.description ? ` — ${b.description}` : ""}${b.item_count != null ? ` (${b.item_count} items)` : ""}`).join("\n")
    : "(none yet)";
  const system = `You file saved links into topical boards, like Pinterest boards, for one person's personal library.
Rules:
- File by the TOPIC of the content (what it is about), never by its format or where it came from. A music video goes to "Music", a product page goes to a board for that kind of product, a tutorial goes to its subject.
- Prefer an EXISTING board whenever the item fits its topic reasonably well. If an existing board is only a loose fit (a workout tutorial is Fitness, not Sports; a water bottle is Gear, not Sports), create the right board instead — a new well-named board is better than a stretched or catch-all board.
- Never use catch-all boards such as "Read Later", "Videos", "Links", "Misc", "Other", "Articles", "Products", "Interesting". If truly nothing fits, propose the most specific reasonable topic board and lower your confidence.
- New board names: 1-3 words, Title Case, broad enough to reuse (e.g. "Recipes", "Fitness", "Home Decor", "Men's Style", "Marketing", "AI & Tech", "Space", "Music", "Travel", "Kitchen Gear", "Real Estate", "Career"). Never name a board after a person, brand, platform, or creator. Never make near-duplicates of existing boards (check singular/plural and synonyms).
- Never choose "Unsorted"; instead give a low confidence.
- board_description: one sentence describing what belongs on the board (for a new board only; empty string otherwise).
- summary: <= 20 words describing what the item actually is and why someone would save it.
- tags: 3-6 lowercase keywords.
- confidence: 0-1, your confidence that the chosen board is right.
- reasoning: one short sentence.`;
  const user = `ITEM
URL: ${url}
Source: ${source}
Title: ${meta.title ?? "(unknown)"}
Description: ${(meta.description ?? "").slice(0, 1200) || "(none)"}
Author/creator: ${meta.author ?? "(unknown)"}
Site: ${meta.site_name ?? new URL(url).hostname}
${note ? `User's note when saving: ${note}\n` : ""}
EXISTING BOARDS
${boardList}`;
  const candidates = [modelOverride ?? OPENAI_MODEL, "gpt-4.1-mini", "gpt-4o-mini"].filter((v, i, a) => a.indexOf(v) === i);
  let lastErr = "";
  for (const model of candidates) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_schema", json_schema: SCHEMA } }),
        signal: AbortSignal.timeout(25000),
      });
      const j = await r.json();
      if (!r.ok) { lastErr = j.error?.message ?? `HTTP ${r.status}`; if (j.error?.code === "model_not_found" || /model/i.test(lastErr)) continue; return { error: lastErr }; }
      const content = j.choices?.[0]?.message?.content;
      if (!content) { lastErr = "empty completion"; continue; }
      return { result: JSON.parse(content) as Classification, model };
    } catch (e) { lastErr = String(e); }
  }
  return { error: lastErr || "classification failed" };
}

// ---------- boards ----------
async function listBoards(userId: string): Promise<Board[]> {
  const { data } = await db.from("board_summaries").select("id,name,description,item_count").eq("user_id", userId).order("name");
  return (data ?? []) as Board[];
}
// AI-created board names: letters/numbers/&'-/ only (no emoji or symbols), max 3 words. User-created names are kept as typed.
function sanitizeBoardName(name: string, createdBy: "ai" | "user"): string {
  if (createdBy === "user") return name.replace(/\s+/g, " ").trim().slice(0, 80);
  const words = name.replace(/[^\p{L}\p{N}&'\-\/ ]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 3);
  return words.join(" ").slice(0, 40);
}
async function ensureBoard(userId: string, name: string, description: string, createdBy: "ai" | "user"): Promise<{ board: Board; created: boolean }> {
  const clean = sanitizeBoardName(name, createdBy) || "Unsorted";
  const { data: existing } = await db.from("boards").select("id,name,description").eq("user_id", userId).ilike("name", clean).maybeSingle();
  if (existing) return { board: existing as Board, created: false };
  const { data, error } = await db.from("boards").insert({ user_id: userId, name: clean, description: description.slice(0, 300), created_by: createdBy }).select("id,name,description").single();
  if (error) throw new Error(`board insert: ${error.message}`);
  return { board: data as Board, created: true };
}

// ---------- board descriptions (v6) ----------
// User-created boards start with no description, so the classifier under-picks them. Once a board holds
// >= 5 cards (DESCRIBE_MIN_ITEMS), write a one-sentence description from what's actually on it. Runs in the background after a save.
const DESCRIBE_MIN = Number(Deno.env.get("DESCRIBE_MIN_ITEMS") ?? "5");
const DESC_SCHEMA = { name: "board_description", strict: true, schema: { type: "object", additionalProperties: false, properties: { description: { type: "string" } }, required: ["description"] } };
async function describeBoard(userId: string, boardId: string, force = false): Promise<{ board: string; ok: boolean; description?: string; reason?: string }> {
  const { data: b } = await db.from("boards").select("id,name,description,created_by").eq("id", boardId).eq("user_id", userId).maybeSingle();
  if (!b) return { board: boardId, ok: false, reason: "not found" };
  if (b.name === "Unsorted") return { board: b.name, ok: false, reason: "unsorted" };
  if (b.description && !force) return { board: b.name, ok: false, reason: "has description" };
  const { data: items } = await db.from("items").select("title,ai_summary,ai_tags,source").eq("board_id", boardId).order("created_at", { ascending: false }).limit(25);
  if (!items || items.length < DESCRIBE_MIN) return { board: b.name, ok: false, reason: `only ${items?.length ?? 0} cards` };
  if (!OPENAI_API_KEY) return { board: b.name, ok: false, reason: "OPENAI_API_KEY not set" };
  const list = items.map((i: any) => `- ${i.title ?? "(untitled)"}${i.ai_summary ? ` — ${i.ai_summary}` : ""}${i.ai_tags?.length ? ` [${i.ai_tags.join(", ")}]` : ""}`).join("\n");
  const system = `You write one-sentence descriptions of a person's bookmark boards so an automatic filer knows what belongs on each board.
Rules: describe the TOPIC the cards share (what kinds of links belong here), not the format or platform; be specific enough to tell it apart from neighbouring topics; <= 25 words; no preamble, no quotes, no trailing period needed. Never mention people, brands or platforms unless the board is clearly about them.`;
  const user = `BOARD NAME: ${b.name}\nCARDS ON IT:\n${list}`;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_schema", json_schema: DESC_SCHEMA } }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    if (!r.ok) return { board: b.name, ok: false, reason: j.error?.message ?? `HTTP ${r.status}` };
    const description = String(JSON.parse(j.choices?.[0]?.message?.content ?? "{}").description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (!description) return { board: b.name, ok: false, reason: "empty completion" };
    const { error } = await db.from("boards").update({ description }).eq("id", boardId);
    if (error) return { board: b.name, ok: false, reason: error.message };
    return { board: b.name, ok: true, description };
  } catch (e) { return { board: b.name, ok: false, reason: String(e) }; }
}
// Run after the response is sent when the runtime allows it; otherwise fire-and-forget.
function background(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p.catch(() => {})); else p.catch(() => {});
}

// ---------- frameability (v1.3 batch 2) ----------
// Can the viewer show this page inside an <iframe>? Decided from response headers only:
// X-Frame-Options DENY/SAMEORIGIN or a CSP frame-ancestors that excludes the viewer origin -> false.
// Social sources are skipped (the viewer uses their official embed endpoints instead).
const VIEWER_ORIGIN = Deno.env.get("VIEWER_ORIGIN") ?? "https://somerscalesluke.github.io";
const SOCIAL: Set<Source> = new Set(["instagram", "tiktok", "youtube"]);
interface FrameCheck { embeddable: boolean; reason: string; status?: number; xfo?: string | null; frame_ancestors?: string | null; ms: number }
function frameAncestorsAllow(directive: string, origin: string): boolean {
  const o = new URL(origin); const host = o.hostname;
  const sources = directive.trim().split(/\s+/).map((s) => s.replace(/^'|'$/g, "").toLowerCase());
  if (!sources.length || sources.includes("none")) return false;
  return sources.some((s) => {
    if (s === "*" || s === "https:" || s === "https://*") return true;
    if (s === "self") return false;
    const m = s.match(/^(?:(https?):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/); if (!m) return false;
    const [, scheme, wild, h] = m;
    if (scheme && scheme !== o.protocol.replace(":", "")) return false;
    return wild ? host.endsWith("." + h) || host === h : host === h;
  });
}
async function frameCheck(url: string): Promise<FrameCheck> {
  const t = Date.now();
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": BROWSER_UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(5000) });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    const xfo = r.headers.get("x-frame-options"); const csp = r.headers.get("content-security-policy");
    const fa = csp?.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d))?.replace(/^frame-ancestors\s*/i, "") ?? null;
    const base = { status: r.status, xfo, frame_ancestors: fa, ms: Date.now() - t };
    if (r.status >= 400) return { embeddable: false, reason: `http ${r.status}`, ...base };
    if (xfo && /deny|sameorigin|allow-from/i.test(xfo)) return { embeddable: false, reason: `x-frame-options ${xfo}`, ...base };
    if (fa !== null && !frameAncestorsAllow(fa, VIEWER_ORIGIN)) return { embeddable: false, reason: `frame-ancestors ${fa}`, ...base };
    return { embeddable: true, reason: fa !== null ? "frame-ancestors allows viewer" : "no framing restriction", ...base };
  } catch (e) {
    return { embeddable: false, reason: `fetch failed: ${(e as Error).message}`, ms: Date.now() - t };
  }
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const userId = await authenticate(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  const reqUrl = new URL(req.url);
  if (req.method === "GET" && reqUrl.searchParams.get("diag") === "models") {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    const j = await r.json();
    return json({ status: r.status, configured_model: OPENAI_MODEL, models: (j.data ?? []).map((m: any) => m.id).filter((id: string) => /gpt/.test(id)).sort(), error: j.error });
  }
  // Debug: see what each metadata provider returns for a URL (no insert).
  if (req.method === "GET" && reqUrl.searchParams.get("diag") === "meta" && reqUrl.searchParams.get("url")) {
    const canon = await canonicalize(reqUrl.searchParams.get("url")!);
    const time = async <T,>(f: () => Promise<T>) => { const t = Date.now(); const v = await f(); return { ms: Date.now() - t, v }; };
    const [og, ogBot, ml, jn] = await Promise.all([
      time(() => openGraph(canon.url)), time(() => openGraph(canon.url, BOT_UA)), time(() => microlink(canon.url)), time(() => jina(canon.url)),
    ]);
    const strip = (x: { ms: number; v: Meta | null }) => ({ ms: x.ms, title: x.v?.title, image: x.v?.image, description: x.v?.description?.slice(0, 160), author: x.v?.author });
    return json({ canonical: canon, opengraph: strip(og), opengraph_bot: strip(ogBot), microlink: { ...strip(ml), error: lastMicrolinkError || undefined }, jina: strip(jn), final: await fetchMetadata(canon.url, canon.source) });
  }
  // Debug: would this page load inside the viewer's iframe?
  if (req.method === "GET" && reqUrl.searchParams.get("diag") === "frame" && reqUrl.searchParams.get("url")) {
    const canon = await canonicalize(reqUrl.searchParams.get("url")!);
    return json({ canonical: canon, ...(SOCIAL.has(canon.source) ? { embeddable: null, reason: "social source: viewer uses the platform embed" } : await frameCheck(canon.url)) });
  }
  // One-off: fill items.embeddable for the caller's existing cards (null + non-social). Idempotent; ?limit= caps the batch.
  if (req.method === "GET" && reqUrl.searchParams.get("diag") === "backfill-frames") {
    const limit = Math.min(Number(reqUrl.searchParams.get("limit") ?? "50"), 200);
    const { data: rows, error } = await db.from("items").select("id,canonical_url,url,source").eq("user_id", userId).is("embeddable", null).not("source", "in", "(instagram,tiktok,youtube)").limit(limit);
    if (error) return json({ error: error.message }, 500);
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < (rows ?? []).length; i += 4) {
      await Promise.all((rows ?? []).slice(i, i + 4).map(async (it: any) => {
        const fc = await frameCheck(it.canonical_url || it.url);
        const { error: upErr } = await db.from("items").update({ embeddable: fc.embeddable }).eq("id", it.id);
        out.push({ id: it.id, url: it.canonical_url || it.url, embeddable: fc.embeddable, reason: fc.reason, error: upErr?.message });
      }));
    }
    return json({ checked: out.length, embeddable: out.filter((o) => o.embeddable).length, results: out });
  }
  // One-off / maintenance: describe every board of the caller that has none yet (or all with ?force=1).
  if (req.method === "GET" && reqUrl.searchParams.get("diag") === "describe-boards") {
    const force = reqUrl.searchParams.get("force") === "1";
    const { data: bs } = await db.from("boards").select("id,name,description").eq("user_id", userId).neq("name", "Unsorted");
    const out = [];
    for (const b of bs ?? []) { if (b.description && !force) { out.push({ board: b.name, ok: false, reason: "has description" }); continue; } out.push(await describeBoard(userId, b.id, force)); }
    return json({ boards: out.length, described: out.filter((o) => o.ok).length, results: out });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const inputUrl: string | undefined = body.url ?? body.text?.match(/https?:\/\/\S+/)?.[0];
  if (!inputUrl) return json({ error: "url required", message: "Nothing to save — no link found" }, 400);
  // Picker sentinels: "[Auto Sort]"/"Auto" -> AI files it; "+New Board"/"New folder" with no name supplied -> also auto (Shortcut should have asked for a name).
  if (typeof body.board_name === "string" && /^(auto( sort)?|new (folder|board))$/i.test(body.board_name.replace(/[^a-z0-9 ]/gi, "").trim())) { body.mode = "auto"; delete body.board_name; }
  const mode: "auto" | "board" = body.mode === "board" || (typeof body.board_name === "string" && body.board_name.trim()) ? "board" : "auto";
  const note: string | undefined = body.note?.toString().slice(0, 500) || undefined;
  const dryRun = body.dry_run === true;            // run the pipeline, return the result, insert nothing
  const modelOverride: string | undefined = typeof body.model === "string" ? body.model : undefined;
  const t0 = Date.now();

  // 1. canonicalize
  let canon: { url: string; source: Source };
  try { canon = await canonicalize(inputUrl); } catch { return json({ error: "invalid url" }, 400); }

  // 2. dedupe
  const { data: dup } = await db.from("items").select("id,title,thumbnail_url,board_id,boards(name)").eq("user_id", userId).eq("canonical_url", canon.url).is("copied_from", null).maybeSingle();
  if (dup && !dryRun) {
    const boardName = (dup as any).boards?.name ?? "Unsorted";
    return json({ ok: true, duplicate: true, item_id: dup.id, title: dup.title, thumbnail_url: dup.thumbnail_url, board: { id: dup.board_id, name: boardName }, message: `Already saved in ${boardName}` });
  }

  // 3. metadata + boards in parallel
  const [meta, boards] = await Promise.all([fetchMetadata(canon.url, canon.source), listBoards(userId)]);
  const errors: string[] = [];
  if (!meta.title && !meta.image) errors.push("metadata: nothing extracted");
  else if (meta.provider === "slug") errors.push("metadata: site blocked fetch; title derived from URL");

  // 4 + 5. thumbnail rehost and classification in parallel
  const itemId = crypto.randomUUID();
  const [thumb, cls, frame] = await Promise.all([
    meta.image && !dryRun ? rehostThumbnail(userId, itemId, meta.image, canon.url) : Promise.resolve<string | null>(null),
    classify(meta, canon.url, canon.source, boards.filter((b) => b.name !== "Unsorted"), note, modelOverride),
    SOCIAL.has(canon.source) ? Promise.resolve<FrameCheck | null>(null) : frameCheck(canon.url),   // runs alongside the OpenAI call, so no added wait
  ]);
  if (meta.image && !dryRun && !thumb) errors.push("thumbnail: could not rehost");
  if (cls.error) errors.push(`classify: ${cls.error}`);
  const c = cls.result;

  if (dryRun) {
    return json({ ok: true, dry_run: true, canonical_url: canon.url, source: canon.source, title: meta.title, description: meta.description?.slice(0, 200), author: meta.author, image: meta.image, provider: meta.provider, classification: c, model: cls.model, frame, errors, ms: Date.now() - t0 });
  }

  // 6. board selection
  let board: Board; let isNewBoard = false; let filedBy: "ai" | "user" = "ai";
  if (mode === "board" && (body.board_id || body.board_name)) {
    filedBy = "user";
    if (body.board_id) {
      const { data } = await db.from("boards").select("id,name,description").eq("id", body.board_id).eq("user_id", userId).maybeSingle();
      if (!data) return json({ error: "board not found" }, 404);
      board = data as Board;
    } else {
      const r = await ensureBoard(userId, String(body.board_name), "", "user"); board = r.board; isNewBoard = r.created;
    }
  } else if (c && c.confidence >= CONFIDENCE_FLOOR && c.board_name && !/^unsorted$/i.test(c.board_name)) {
    const r = await ensureBoard(userId, c.board_name, c.board_description ?? "", "ai"); board = r.board; isNewBoard = r.created;
  } else {
    const r = await ensureBoard(userId, "Unsorted", "Items the AI could not confidently place. Review and move them.", "user"); board = r.board;
  }

  // 7. insert
  const status = errors.length ? "partial" : "ready";
  let title = meta.title ?? new URL(canon.url).hostname.replace(/^www\./, "");
  // Captionless Instagram posts only yield "<Name> on Instagram"; the AI summary is a better display title.
  if (canon.source === "instagram" && /\bon instagram\b/i.test(title) && c?.summary) title = c.summary;
  const row = {
    id: itemId, user_id: userId, board_id: board.id, url: inputUrl, canonical_url: canon.url, source: canon.source,
    title: title.slice(0, 500), description: meta.description?.slice(0, 4000) ?? null, author: meta.author?.slice(0, 200) ?? null,
    site_name: meta.site_name?.slice(0, 100) ?? null, thumbnail_url: thumb, original_thumbnail_url: meta.image ?? null,
    ai_summary: c?.summary ?? null, ai_tags: c?.tags?.slice(0, 8) ?? [], ai_confidence: c?.confidence ?? null,
    ai_reasoning: c ? `${c.reasoning} [suggested: ${c.board_name}; model: ${cls.model}]` : null,
    filed_by: filedBy, status, error: errors.length ? errors.join("; ") : null, note: note ?? null,
    embeddable: frame ? frame.embeddable : null,
    raw_meta: { provider: meta.provider, source_raw: meta.raw ?? null, frame: frame ? { reason: frame.reason, status: frame.status } : null },
  };
  const { error: insErr } = await db.from("items").insert(row);
  if (insErr) return json({ error: `insert failed: ${insErr.message}` }, 500);
  // 8. board without a description (user-created, or an old AI board) -> write one in the background once it has enough cards
  if (!board.description && board.name !== "Unsorted") background(describeBoard(userId, board.id));

  return json({
    ok: true, item_id: itemId, title: row.title, thumbnail_url: thumb, source: canon.source, canonical_url: canon.url,
    board: { id: board.id, name: board.name }, is_new_board: isNewBoard, filed_by: filedBy,
    confidence: c?.confidence ?? null, summary: c?.summary ?? null, status, errors, ms: Date.now() - t0,
    message: isNewBoard ? `Filed under new board: ${board.name}` : `Filed under: ${board.name}`,
  });
});
