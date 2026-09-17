# bookmark-app — Handoff (2026-09-17 late — viewer v1.4.1, ingest v7, read v1)

Read this first in a new chat. Everything below is live and verified unless marked otherwise.

## What it is

Personal "MyMind meets Pinterest" bookmark app. iOS share sheet → Shortcut → Supabase edge function fetches a preview (thumbnail + caption), AI files it onto a topical board → web viewer to browse, re-file, edit, sort. Owner: Luke (Windows PC, iPhone, no Mac). Built for one user, schema is multi-user-ready.

## Where everything lives

- **Repo:** github.com/somerscalesluke/bookmark-app (public). Contains README, .gitignore, .env.example, **index.html** (v1.4.1, commit ab34058), **supabase/** (migrations 0001–0004, functions ingest v7 (commit c2f422b) + boards v6 + read v1). `docs/` (backend.md, HANDOFF.md, shortcut.md) is in the repo too as of Sept 17.
- **Local copy on PC:** `C:\Projects\bookmark-app\` (index.html = repo copy byte-for-byte, docs/backend.md, docs/shortcut.md, docs/HANDOFF.md, supabase/migrations/0001–0004, supabase/functions/ingest + boards + read).
- **Viewer (live):** https://somerscalesluke.github.io/bookmark-app/ — GitHub Pages from `main`, root.
- **Supabase project:** `dmqrroajctiiojbtsxbu` (us-east-2, free tier). Edge functions `ingest` (v7), `boards` (v6), `read` (v1). Storage bucket `thumbs` (public). Auth: magic link, built-in mailer (2 emails/hour).
- **Project doc mirrors** in the Lacuna Systems project: `claude/bookmark-app-backend.md` = `docs/backend.md`; `claude/bookmark-app-handoff.md` = this file.

## Secrets (Luke has them; not in repo)

`SUPABASE_ACCESS_TOKEN` (PAT), `SUPABASE_PROJECT_REF`, `OPENAI_API_KEY`, `INGEST_API_KEY` (bk_…, hash stored in `api_keys`), `SUPABASE_USER_ID`, `GITHUB_TOKEN` (fine-grained PAT, repo-scoped; regenerated Sept 17 and pasted in chat — rotate). The Supabase anon key is embedded in index.html (public by design; the old `__ANON_KEY__` placeholder convention for the local copy is dropped so the PC file can be uploaded as-is). Paste whichever keys the next session needs; rotate everything pasted in chat eventually.

## Data model (Postgres)

- `boards` (id, user_id, name, description, created_by ai|user, created_at). No `updated_at`. `description` is written by the AI at creation (AI boards) or in the background once a board reaches 5 cards (ingest v7 `describeBoard`); it feeds the classifier.
- `items` = "cards" in UI (id, user_id, board_id, url, canonical_url, source, title, description, author, site_name, thumbnail_url, original_thumbnail_url, ai_summary, ai_tags[], ai_confidence, ai_reasoning, filed_by ai|user, status ready|partial|failed, error, raw_meta, note, **blurb** (user description), **copied_from** (uuid → original item), **embeddable** (bool, null for social sources; set by ingest v5 from frame headers), **created_at**, **updated_at** (trigger `set_updated_at` on every UPDATE).
- Unique on (user_id, canonical_url) **only where copied_from is null** (partial index) — copies may repeat a URL.
- `api_keys` (key_hash sha256, user_id, label).
- `item_reader` (item_id pk → items, user_id, title, markdown, fetched_at) — reader-mode cache written by the `read` function; RLS on, no policies (service role only).
- View `board_summaries` (security_invoker): board cols + `item_count`, `last_saved_at` (max created_at), `cover_thumbnails[1:4]`.
- RLS: `auth.uid() = user_id` for `authenticated` on boards/items; edge functions use service role.

## Viewer (index.html) — how it's built

Single file, no build step. supabase-js v2 UMD from jsDelivr. Hash routing (`#` home, `#all`, `#<boardId>`). CSS-columns masonry. Key state: `state = {user, boards, items, board, q, selecting, sel:Set, sort:{cards, boards}}`. Key functions: `loadBoards()` (orders: Unsorted last, then item_count desc, then name — used by pickers), `loadItems(boardId)` (`order("created_at", desc).limit(600)`, selects `updated_at`), `renderHome()` (applies board sort, Unsorted pinned last), `renderBoard()`, `visibleItems()` (search filter → card sort), `renderItems()` (card meta row: source · creator · `fmtDate(created_at)` stamp), sorting (`SORTS`, `getSort/setSortKey/flipSort/sortList/sortControl/refreshSortControl/bindSortControl/sortSheet`), selection mode (`enterSelect/exitSelect/toggleOne/renderBulk/bulkAction`), `pickBoard()`, `moveMany()`, `copyMany()`, `itemMenu()`, `editItem()`, `boardAction()` (rename / merge into… / delete), `sheet()`/`closeSheet()`, `toast()`, `plural(n, "card")`.

Current features: sign-in, boards as fanned thumbnail stacks, search, open original, per-card menu (Open / Edit title & description / Move / Copy to another board / Copy link / Delete), multi-select with bulk bar ("N of M selected · Select all · Move N cards · Copy N cards · Delete N cards"), rename/merge/delete boards, **sort control** `[caret][key]` — caret toggles asc/desc, key chip opens a keys-only picker; picking a key resets to its natural direction — for **cards** (added / modified / title / source / board-on-Everything) and **boards** (size / saved / name / created), both persisted in `localStorage` (`sort.cards`, `sort.boards`), **in-app preview sheet** (`openViewer`: YouTube/TikTok/Instagram official embeds, framed page when `embeddable`, otherwise **reader mode** — `loadReader(it, refresh?)` → `sb.functions.invoke("read")` → `tidyReader()` (strips nav crumbs) → `md()` renderer, session `readerCache`, fallback with the server error; card menu has "Refresh article text" — in a full-screen overlay with prev/next over all visible cards, swipe on the bar, back-gesture close via `history.pushState`, "Open in browser" link), **Settings sheet** (gear: Open cards In app / In browser → `localStorage` `open.mode`; Sign out lives here now), dark mode, PWA meta. `embedOf(item)` decides embed vs reader: social embeds, the page itself when `items.embeddable === true` (Wikipedia), else reader mode (8 of 10 remaining articles read fine; Serious Eats is Jina-451, Mr Porter hit a 429 under parallel load).

## Deploy procedures (what actually worked on Sept 17)

Cloud container egress: raw.githubusercontent.com **works** (read any repo file); api.github.com, github.io, supabase.com, openai.com, jsDelivr are blocked. On the PC side, `device_request_folder_access` for `C:\Projects\bookmark-app` and `device_commit_files` **work** (the Sept 8 mount bug affected `device_bash`, which wasn't needed this time).

- **Viewer deploy (preferred):** build `index.html` in the cloud → copy it to `/mnt/user-data/uploads/index.html` (the Chrome `file_upload` tool only accepts paths under that folder) → Chrome tab on `https://github.com/somerscalesluke/bookmark-app/upload/main` (Luke is signed in) → `find` the "choose your files" input → `file_upload` → set the commit summary with `javascript_tool` (`input[name="message"]`.value + dispatch `input`; `computer type` after a ref click landed in the wrong field twice) → submit with `javascript_tool` by `.click()`-ing the "Commit changes" submit button (ref/coordinate clicks missed twice; JS click worked every time) → confirm the tab URL becomes the repo page → get the new SHA with `fetch(api.github.com/repos/…/commits/main)` from that tab (print it as spaced characters — the output filter masks hex strings). raw.githubusercontent.com caches `main` for a few minutes — verify with the commit SHA URL (`/<sha>/index.html`) instead. Verify with `curl raw.githubusercontent.com/.../main/index.html` + `cmp` against the local file. Pages builds in ~30–60 s; the browser caches the old page, so hard-reload (ctrl+shift+r) before checking `typeof sortSheet` etc. Then `device_commit_files` (force:true) to `C:\Projects\bookmark-app\index.html` from `/mnt/user-data/outputs/…`.
- **Same page pushes `docs/` and `supabase/`:** use `/upload/main/docs`, `/upload/main/supabase/migrations`, `/upload/main/supabase/functions/ingest`, `/upload/main/supabase/functions/boards` — one commit each, files staged from the PC with `device_stage_files` then copied into `/mnt/user-data/uploads/`.
- **Viewer deploy (fallback, API):** from a Chrome tab on `somerscalesluke.github.io`, `javascript_tool`: GET `api.github.com/repos/somerscalesluke/bookmark-app/contents/index.html` (Bearer GITHUB_TOKEN) → decode → edit → PUT with `sha`. Only worth it for tiny string-replace edits.
- **Edge function deploy (worked first time on Sept 17):** push the source to the repo via the upload page, then from a **supabase.com** tab (`/dashboard/project/{ref}/functions`): `src = await (await fetch(raw.githubusercontent.com/…/index.ts?ts, {cache:"no-store"})).text()` (CORS `*`), `FormData` with `metadata` = `{name, entrypoint_path:"index.ts", verify_jwt:false}` and `file` = Blob(src) named `index.ts`, `POST api.supabase.com/v1/projects/{ref}/functions/deploy?slug=ingest` with the PAT → 201 + version; confirm with `GET …/functions/ingest` (version, status ACTIVE). Older quirk (201 but not live → delete + redeploy) didn't recur.
- **Calling the function without the Shortcut key:** insert a temporary key — `bk_tmp_<hex>` → sha256 → `insert into api_keys (key_hash,user_id,label)` via the SQL endpoint — call with `x-api-key`, then `delete … where key_hash=…`. Check `select label from api_keys` afterwards; only `ios-shortcut-v1` should remain.
- **SQL:** `POST /v1/projects/{ref}/database/query` with the PAT, same tab.
- **Test sign-in without email:** `POST {supabase}/auth/v1/admin/generate_link` with service role.
- **Local testing without Supabase:** Playwright with `executablePath: '/opt/pw-browsers/chromium'`, `page.route` serving index.html at a fake origin and a mock `supabase-js` UMD (see the sort test harness pattern: `from(table)` returns a thenable that resolves `{data, error:null}` from fixture arrays, `auth.getSession` returns a fake user). Fast, no network, catches console errors.
- Output filter masks keys/base64 in tool results — expected, not an error.

## Known limits (carry forward)

Instagram relies on Jina Reader (primary) / Microlink free tier; bot-walled sites (Serious Eats, Mr Porter, Nerd Fitness) get slug titles and no thumbnail; Shortcut waits 2–4 s synchronously; keys pasted in chat need rotation. Source badge shows "en" for en.wikipedia.org (first host label) — cosmetic.

## NEXT — pick from the backlog (in-app preview, reader polish and board descriptions are all done)

1. **Thumbnail retries for `partial` cards.** `read` already receives images in the Jina markdown; a card with no thumbnail could take the first image from `item_reader.markdown` (or call Microlink `screenshot=true`) and re-host it into `thumbs`. Add a "Retry preview" item to the card menu; optionally run it for all `partial` cards from a `?diag=` endpoint.
2. **Rotate keys:** Supabase PAT (pasted in chat Sept 17 — `sbp_…`), OpenAI, Shortcut key (insert new hash into `api_keys`, update the Shortcut, delete the old row), GitHub PAT.
3. **Trigger `describeBoard` on viewer moves too** — when `moveMany`/`copyMany` lands ≥ 5 cards on a description-less board. Needs either a small endpoint on `boards` (user JWT) or reuse of `read`'s auth pattern.
4. **`JINA_API_KEY` secret** if reader 429s show up in normal use (free key from jina.ai; `read` already sends it when set).
5. **Native share extension** (needs Paul's Mac).
