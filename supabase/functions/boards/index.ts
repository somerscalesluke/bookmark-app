// bookmark-app — boards edge function (v7)
// GET  /boards            -> list boards with counts + cover thumbnails (Shortcut picker / viewer)
// POST /boards { name }   -> create a user board
// Auth: x-api-key header

import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function authenticate(req: Request): Promise<string | null> {
  const key = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key || !key.startsWith("bk_")) return null;
  const { data } = await db.from("api_keys").select("user_id").eq("key_hash", await sha256(key)).maybeSingle();
  return (data?.user_id as string) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const userId = await authenticate(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const { data, error } = await db.from("board_summaries").select("*").eq("user_id", userId).order("name");
    if (error) return json({ error: error.message }, 500);
    // Shortcuts "Choose from List" works best with a flat names array too.
    const names = (data ?? []).map((b) => b.name).filter((n) => n !== "Unsorted");
    // `picker` is the ready-made menu for the iOS Shortcut's "Choose from List".
    // Special rows carry a symbol so they read differently from board names in the iOS "Choose from List"
    // (Shortcuts can't style rows). Ingest strips symbols before matching these sentinels.
    return json({ boards: data, names, picker: ["+New Board", ...names, "[Auto Sort]"] });
  }
  if (req.method === "POST") {
    let body: any; try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const name = String(body.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) return json({ error: "name required" }, 400);
    const { data: existing } = await db.from("boards").select("id,name").eq("user_id", userId).ilike("name", name).maybeSingle();
    if (existing) return json({ ok: true, board: existing, created: false });
    const { data, error } = await db.from("boards").insert({ user_id: userId, name, description: String(body.description ?? "").slice(0, 300), created_by: "user" }).select("id,name,description").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, board: data, created: true });
  }
  return json({ error: "method not allowed" }, 405);
});
