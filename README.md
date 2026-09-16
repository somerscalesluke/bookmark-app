# bookmark-app

A MyMind-style "home for all your bookmarks": share any link from iOS, the backend fetches a preview, files it onto an AI-chosen (or user-chosen) board, and a Pinterest-style viewer shows it all.

- **Viewer (GitHub Pages):** https://somerscalesluke.github.io/bookmark-app/ — `index.html`, single file, Supabase Auth magic link.
- **Backend:** Supabase project `dmqrroajctiiojbtsxbu` — edge functions `ingest` + `boards` in `supabase/functions`, schema in `supabase/migrations`.
- **Capture:** iOS Shortcut "Save to Bookmarks" — spec in `docs/shortcut.md`.
- **Architecture, API, test results, known limits:** `docs/backend.md`.

Secrets live in `.env.local` (never committed); see `.env.example`.
