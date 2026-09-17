# bookmark-app — Build log & architecture

Status as of 2026-09-17 (all three stages live):

- **Stage 1 — backend:** Supabase project `dmqrroajctiiojbtsxbu` (us-east-2, free tier). Edge functions `ingest` (v7), `boards` (v6) and `read` (v1).
- **Stage 2 — capture:** iOS Shortcut "Save to Bookmarks" in the share sheet. Menu: New folder → boards → Auto. Spec in `docs/shortcut.md`. Verified from Instagram three ways.
- **Stage 3 — viewer:** https://somerscalesluke.github.io/bookmark-app/ — single-file PWA (`index.html`), GitHub Pages from `main`, Supabase Auth magic link, RLS-scoped queries. Boards as fanned thumbnail stacks, masonry cards, open original, edit / move / copy / delete cards (single or multi-select), rename / merge / delete boards, search, sort (cards and boards), **in-app preview sheet** (YouTube/TikTok/Instagram embeds, framed pages, reader mode for everything else), dark mode.
- **Repo:** github.com/somerscalesluke/bookmark-app (public). Local copy: `C:\Projects\bookmark-app` (index.html is byte-identical to the repo, anon key included — it's a public key by design).

## Stage 3 notes

- **Hosting lesson:** *.supabase.co refuses to serve HTML — Storage and Edge Functions both rewrite `text/html` to `text/plain` (anti-phishing). Two hours lost; the viewer must live on a real static host. GitHub Pages chosen; Vercel/Cloudflare are equivalent.
- **Auth:** magic link via Supabase's built-in mailer (limit: 2 emails/hour). Sessions persist, so sign-in is rare. `site_url` and redirect allow-list point at the Pages URL. For testing without email, `POST /auth/v1/admin/generate_link` (service role) returns a one-time link.
- **RLS:** `board_summaries` view set to `security_invoker = true`; `authenticated` role granted select/insert/update/delete on boards/items. Edge functions still use the service role.
- **Board name rules:** AI-created names are sanitized server-side (no emoji/symbols, max 3 words). User-typed names are kept as typed (max 80 chars).
- **Deploy quirk:** twice a `functions/deploy` call returned 201 with a new version but the live function stayed on the old version. Fix: delete the function, deploy again. The `docs/backend.md`-listed CLI commands should be used going forward.
- **Instagram:** Microlink's free tier returns `EPROXYNEEDED` for any uncached Instagram URL, so Jina Reader is now the primary Instagram path (caption → title, handle → author, image). Reels with no caption fall back to the account name as title — fix later by using the AI summary as the display title.

## v1.1 (2026-09-16)

- **Viewer:** "select" chip on any board → tap cards to multi-select → bottom bar: Select all / **Move N cards** / **Copy N cards** / **Delete N cards** (labels carry the live count; bar wraps on phones). Bulk "Move" is deliberately named Move, not Merge. Per-card menu adds "Edit title & description" and "Copy to another board". UI wording is now **cards** (DB table stays `items`).
- **Copies:** a card can live on several boards. `items.copied_from` points at the original; the unique-URL rule now applies only to originals (partial unique index), so the Shortcut still dedupes against the original. Copies share the thumbnail file.
- **Descriptions:** `items.blurb` is the user-written description; the card shows `blurb` if set, else `ai_summary`.
- **Ingest v4:** dedupe ignores copies; captionless Instagram posts use the AI summary as the title instead of "<Name> on Instagram".
- Migration: `supabase/migrations/0002_cards.sql`.

## v1.2 — sorting (2026-09-17)

Viewer only; no schema or function changes.

- **Control** (v1.2.1): a two-part pill `[caret][key]`. The caret toggles ascending/descending (points down = descending, up = ascending) and the key chip opens a picker with just the sort keys. Picking a key resets to that key's natural direction (dates newest-first, text A–Z).
- **Cards** (left of "select" on every board page): Date added (default, newest first) · Date modified · Title · Source · Board (Everything view only; hidden on a single board and silently falls back to Date added).
- **Boards** (home eyebrow row): Number of cards (default, biggest first) · Last saved to · Name · Date created. Unsorted is always pinned last.
- **Mechanics:** `SORTS` table of comparators + default direction; `getSort/setSortKey/flipSort/sortList/sortControl/refreshSortControl/bindSortControl/sortSheet`. Cards sort client-side inside `visibleItems()` so search and sort compose; boards sort in `renderHome()` only (`loadBoards()` order is untouched, so pickers keep their order). Tie-breaks: equal counts → name A–Z; equal modified → newer added first; source ties → newest first; articles group as `article <host>`. Title compare is `localeCompare` with `{sensitivity:"base", numeric:true}`; untitled cards sort by hostname.
- **Persistence:** `localStorage` keys `sort.cards` and `sort.boards` (`{key, dir}`), validated on read, per device.
- **Data:** `updated_at` added to the `loadItems` select. Move and edit bump `updated_at` locally so "Date modified" reorders without a reload. Boards have no `updated_at`; `last_saved_at` (max card `created_at`) stands in.
- **Polish:** chips no longer wrap their text on phone width; `.boardhead .actions` wraps as a row instead. Header no longer overflows horizontally on phones (`.search{min-width:0}`, `.iconbtn{flex:none}`) — pre-existing bug.
- Tested with a mocked Supabase client (28 checks, Playwright) and then against live data (24 cards, 9 boards) after deploy.

## v1.3 — in-app preview (2026-09-17)

Viewer only. Goal: thumb through saved cards without leaving the app.

- **Preview sheet** (`openViewer/closeViewer`, `#viewer`): full-screen overlay with a bar (back, title + author + `n/m`, prev, next, more), the content frame, and a footer with the kind and an "Open in browser ↗" link. Prev/next (and a horizontal swipe on the bar) step through the *embeddable* cards in the current list order (search + sort respected). Opening pushes a history entry, so the phone back gesture closes it; the ✕ button pops that entry. Escape closes. Delete from the card menu closes it. Close button gets focus on open so keyboard events reach the page, not the iframe.
- **What embeds** (`embedOf(item)`): the original pages mostly send `X-Frame-Options`/`frame-ancestors`, so the sheet uses each platform's official embed endpoint instead — YouTube (`youtube-nocookie.com/embed/ID?playsinline=1&autoplay=1`, matches watch/shorts/live/youtu.be), TikTok (`tiktok.com/embed/v2/ID`), Instagram (`instagram.com/p/CODE/embed/captioned/`, matches p/reel/reels/tv with or without a username prefix). Any card with `embeddable === true` (batch 2) embeds its own URL. Everything else returns `null` and opens in the browser.
- **Setting** (gear in the header → Settings sheet): "Open cards: In app / In browser", stored in `localStorage` `open.mode` (default `app`). The card menu always offers both "Preview in app" (when embeddable) and "Open in browser". Sign out moved into the Settings sheet.
- **Card tap:** the anchor keeps its real `href`/`target=_blank` (long-press, copy link still work); the click is intercepted only when mode is `app` and the card is embeddable.
- **Verified live:** 26 cards → 15 embeddable (9 IG, 2 TT, 4 YT), all three kinds render. Remaining 11 are articles/Amazon → batch 2/3.
- TikTok embed now uses the light frame (v1.3.1).

### Batch 2 — `items.embeddable` (ingest v5, viewer v1.3.1)

- **Migration `0003_embeddable.sql`:** `items.embeddable boolean` (null = unknown / social source).
- **Ingest v5:** `frameCheck(url)` GETs the page (browser UA, 5 s timeout, body cancelled) and decides from headers only: `X-Frame-Options` DENY/SAMEORIGIN/ALLOW-FROM → false; CSP `frame-ancestors` → false unless it allows `*`, `https:`, or the viewer origin (`VIEWER_ORIGIN` secret, default `https://somerscalesluke.github.io`; supports `*.host` and port); HTTP ≥ 400 or fetch error → false; otherwise true. Runs in the same `Promise.all` as the OpenAI call, so saves don't get slower. Skipped for instagram/tiktok/youtube (null). Result stored in `items.embeddable` and `raw_meta.frame`. Endpoints: `GET ?diag=frame&url=…` and `GET ?diag=backfill-frames&limit=…` (idempotent: fills nulls for the caller's non-social cards, 4 at a time). Both need the `x-api-key`.
- **Backfill result (11 article/Amazon cards):** 1 embeddable (Wikipedia). Denied: BBC, arXiv, Amazon (SAMEORIGIN), Bon Appétit, GitHub (DENY), Stripe (`frame-ancestors 'none'`); bot-walled 403/404 from the edge: Mr Porter, Serious Eats, Zillow, Nerd Fitness. Conclusion: header-based framing is a small win; the reader view (batch 3) is what makes articles work in-app.
- **Viewer v1.3.1:** `loadItems` selects `embeddable`; `embedOf` returns `{kind:"page", light:true}` for flagged cards (verified live: Wikipedia renders in the sheet).
- **Ops:** deployed via the Management API from a supabase.com tab with the source fetched from raw.githubusercontent.com (CORS `*`), so `supabase/` had to be in the repo first — it is now (functions + migrations pushed). For the backfill a temporary `bk_tmp_…` key was inserted into `api_keys` (label `temp-backfill-2026-09-17`) and deleted afterwards; only `ios-shortcut-v1` remains.

### Batch 3 — reader mode (read v1, viewer v1.4)

- **Migration `0004_reader.sql`:** new table `item_reader (item_id pk → items, user_id, title, markdown, fetched_at)`, RLS on with no policies (service role only). Separate table on purpose: `items.updated_at` has a trigger, and caching text must not count as "modified".
- **Edge function `read`** (`POST {item_id, refresh?}`): verifies the viewer's Supabase user JWT with the anon client (`auth.getUser`), loads the item with the service role scoped to that user, returns the cached markdown if < 30 days old, else fetches `https://r.jina.ai/<url>` (JSON, `X-Retain-Images: all`, 20 s timeout, one retry on 429, optional `JINA_API_KEY` secret), requires ≥ 200 chars, caps at 200 k chars, upserts the cache. On fetch failure it serves a stale copy if one exists (`stale: true`), otherwise 502 `{error}`. `verify_jwt: false` (we verify ourselves; keeps behaviour consistent with the other functions).
- **Viewer v1.4:** every card opens in-app when the setting is "In app": platform embed → framed page (`embeddable`) → reader. `openViewer` renders `<article class="reader">` with a spinner and calls `loadReader(it)` → `sb.functions.invoke("read")` → `md()` (small Markdown renderer: headings, paragraphs, bold/italic/code, links (forced `_blank`), images, lists, blockquotes, fenced code, hr; everything HTML-escaped first, verified against a `<script>` fixture). Session cache `readerCache` so prev/next doesn't refetch. Failure → `.fallback` with the server's reason and an "Open in browser" button. Card menu says "Read in app" for non-embeddable cards. Prev/next now walk all visible cards.
- **Verified live (10 non-embeddable cards):** 8 read fine (BBC, arXiv, GitHub, Amazon, Nerd Fitness, Stripe, Zillow, Bon Appétit; 2–10 s first fetch, instant when cached). Serious Eats → Jina 451 (blocked for legal reasons), Mr Porter → 429 (Jina rate limit under 10 parallel calls; single opens should succeed). Jina's extraction leaves some nav crumbs at the top of some articles (e.g. "Site search", byline lines) — cosmetic.

## v1.4.1 + ingest v6 (2026-09-17, same evening)

- **Date-added stamp on cards:** the meta row is now `[source] [creator …] [date]`; `fmtDate()` shows "Sep 17" in the current year and "Sep 17, 2025" otherwise, with the full date in the tooltip (`<time datetime>`). Creator text truncates, date never wraps.
- **Reader polish:** `tidyReader()` drops the nav crumbs Jina leaves before the article (short plain lines before the first ≥ 60-char paragraph), known junk lines anywhere ("Advertisement", "Share", "Getty Images", "Image source …", "N min read"…), and immediate duplicate lines; headings, images, lists, quotes are always kept. Card menu gains **Refresh article text** for reader cards (calls `read` with `refresh:true`, re-renders if the viewer is open).
- **Ingest v6 — board descriptions:** `describeBoard(userId, boardId)` writes a one-sentence `boards.description` from the newest 25 cards (title + AI summary + tags) once a board has ≥ 5 cards (`DESCRIBE_MIN_ITEMS` secret, default 5 — Luke raised it from 3 on Sept 17, ingest v7), via the same OpenAI JSON-schema pattern as `classify`. Runs after a save in the background (`EdgeRuntime.waitUntil`) whenever the target board has no description and isn't Unsorted — so it covers user-created boards and any AI board that lost its description. `GET ?diag=describe-boards[&force=1]` backfills. Result on Luke's data (run at the old threshold of 3): "Content Advice" (user-created, 4 cards) → "Advice for creating, planning, and improving content for social media, including ideas, branding, and engagement tactics". Cards moved into a user board via the viewer don't trigger it (no ingest call) — the next save into that board will.
- Temp key `temp-describe-2026-09-17` used for the backfill and deleted; `ios-shortcut-v1` is the only key.

## Next iteration candidates

1. ~~Title fallback for captionless reels~~ (done in v1.1).
2. ~~Sorting for cards and boards~~ (done in v1.2).
3. ~~In-app preview batches 2 and 3 + reader polish~~ (done). Still open: a `JINA_API_KEY` secret if 429s show up in normal use.
4. ~~Board descriptions for user-created boards~~ (done, ingest v6).
5. Retry thumbnails for `partial` items (screenshot service).
6. Rotate the Supabase PAT, OpenAI key, Shortcut key and GitHub PAT before anyone else uses the app.
7. Native share extension (needs Paul's Mac) — same API, no Shortcut.
8. ~~Push `supabase/` and `docs/` to GitHub~~ (done).

---


## Architecture

```
iOS share sheet ──► Shortcut ──POST /ingest──► Supabase Edge Function (Deno)
                                                  │ 1 canonicalize URL (resolve short links, strip tracking, per-site canonical form)
                                                  │ 2 dedupe on canonical_url
                                                  │ 3 metadata: YouTube/TikTok oEmbed · OpenGraph · Microlink · Jina Reader · URL slug
                                                  │ 4 re-host thumbnail into Storage bucket `thumbs` (CDN links from IG/TikTok expire)
                                                  │ 5 classify with OpenAI (gpt-5.4-mini, JSON-schema output) against existing boards
                                                  │ 6 pick board: AI (confidence ≥ 0.45) / user-chosen / Unsorted
                                                  ▼ 7 insert into `items`, respond "Filed under: X"
                                              Postgres (boards, items, api_keys) ◄── web viewer (Stage 3)
```

Runs synchronously; typical 2–4 s, worst case ~14 s when a site blocks every fetcher and the fallbacks time out.

## Data model

- `boards` (id, user_id, name, description, created_by ai|user). `description` is written by the AI on creation and fed back into future classifications so boards stay coherent.
- `items` (id, user_id, board_id, url, canonical_url, source instagram|tiktok|youtube|amazon|article|other, title, description, author, site_name, thumbnail_url [re-hosted], original_thumbnail_url, ai_summary, ai_tags[], ai_confidence, ai_reasoning, filed_by ai|user, status ready|partial|failed, error, raw_meta jsonb, note, blurb, copied_from, created_at, updated_at). Unique on (user_id, canonical_url) where copied_from is null.
- `api_keys` (key_hash sha256, user_id, label). Static keys for the Shortcut; service-role only.
- View `board_summaries`: board + item_count + last_saved_at + up to 4 cover thumbnails — what the Shortcut picker and viewer read.
- RLS on for `authenticated` (auth.uid() = user_id) so Stage 3 can use Supabase Auth directly. Edge functions use the service role.
- One real `auth.users` row (Luke) so multi-user later is zero migration.

## Auth model (v1)

Header `x-api-key: bk_…`. Function hashes it, looks up `api_keys`. Key stored only in `.env.local` (`INGEST_API_KEY`) and, later, inside the Shortcut. Rotate by inserting a new hash and deleting the old row.

## Classification prompt — rules that matter

- File by topic, never by format/platform. Catch-alls ("Read Later", "Videos", "Misc") are banned; a loose fit must create a new board instead of stretching an existing one.
- Board names 1–3 words, Title Case, never a person/brand/creator. Existing boards + descriptions + counts are passed in every call.
- Output: board_name, is_new_board, board_description, confidence, tags, summary, reasoning. Confidence < 0.45 → Unsorted.
- Model: `gpt-5.4-mini` (secret `OPENAI_MODEL`), falls back to `gpt-4.1-mini` → `gpt-4o-mini` on model errors. Tested both; 5.4-mini made better calls on borderline items at the same ~2.5 s latency.

## Test results (20 real URLs, clean database)

Saved 20/20. Thumbnails 17/20. Dedupe: youtu.be + youtube.com of the same video → 1 item. Boards created by the AI: Space, Sports, Music, AI & Tech, Recipes, Men's Style, Real Estate (then Fitness, Kitchen Gear after the loose-fit rule).

| Source | Result |
|---|---|
| Instagram (3: reel, photo, reel) | ✅ thumbnail + caption as title + @handle. Direct fetch is login-walled; Microlink is what works. |
| TikTok (2) | ✅ oEmbed: thumbnail + caption + author. |
| YouTube (short, youtu.be, watch) | ✅ oEmbed + OG description. |
| Bon Appétit, BBC, Stripe blog, GitHub, Wikipedia, arXiv, Zillow | ✅ OpenGraph. arXiv needed relative-image fix. |
| Amazon | ✅ OG works from the edge; title cleaned of "Amazon.com:". |
| Serious Eats, Mr Porter, Nerd Fitness | ⚠️ `partial` — every fetcher blocked (Akamai / Dotdash bot walls). Title derived from the URL slug ("The Best Slow Cooked Bolognese Sauce Recipe"), still classified correctly, **no thumbnail**. |

Judgment calls before the prompt fix: water bottle → Sports, push-up tutorial → Sports. After: Kitchen Gear, Fitness.

## Known limits / risks

1. **Instagram depends on Microlink's free tier (50 requests/day, no key).** Enough for personal use. If it becomes a problem: Microlink Pro ($), or a headless-browser fetch, or accept "no thumbnail" for IG.
2. **Bot-walled sites get no thumbnail.** ~15% of generic sites in the test. A screenshot service (Microlink `screenshot=true`, or Jina with image) could backfill; deferred.
3. **Edge function wall-clock.** Supabase free tier allows long enough for the worst case (~14 s) but keep fallbacks capped.
4. **Synchronous UX.** The Shortcut waits 2–4 s. Acceptable; Stage 2 can add an "Auto, no menu" shortcut for one-tap saves.
5. **Secrets pasted in chat** (Supabase PAT, OpenAI key, GitHub PAT). Rotate when convenient; everything is stored as Supabase secrets, not in code.

## Deploy notes

v1 was deployed via the Supabase Management API (`POST /v1/projects/{ref}/functions/deploy`, multipart) from a browser tab because the cloud workspace's egress blocked `api.supabase.com` and `api.openai.com`, and the local Cowork shell couldn't mount folders (Windows update, Sept 8). `README.md` has the normal CLI commands. Local source and deployed source are byte-identical (28,385 bytes, ingest v5).

Viewer v1.2+ is deployed through GitHub's web "Upload files" page from a Chrome tab (file staged at `/mnt/user-data/uploads/`, pushed into the file input, committed to `main`). Simpler and safer than the API string-replace route; see HANDOFF.

## Debug endpoints

- `GET /ingest?diag=meta&url=…` — per-provider metadata + timings + final merge. Use this first when a save looks wrong.
- `POST /ingest {url, dry_run:true, model?:…}` — full pipeline without insert; compare models.
- `GET /ingest?diag=models` — models the OpenAI key can see.
