# Stage 2 — iOS Shortcut "Save to Bookmarks" (DONE 2026-09-16)

One share-sheet action for every app. Menu: **New folder** → your boards → **Auto**. Built by feeding the spec below to Apple Intelligence in Shortcuts; verified working from Instagram (auto, existing board, new folder).

## Spec (paste into Siri / Apple Intelligence in the Shortcuts app, or build by hand)

```
Create an iOS Shortcut named "Save to Bookmarks" with these exact settings and actions, in this order.

SETTINGS
- Show in Share Sheet: ON. Accept URLs, Safari web pages, and text as input. If there is no input, continue.

ACTIONS
1. Get URLs from Shortcut Input.
2. Get First Item from the URLs.
3. Get Contents of URL:
   - URL: https://dmqrroajctiiojbtsxbu.supabase.co/functions/v1/boards
   - Method: GET
   - Header: key "x-api-key", value "<INGEST_API_KEY from .env.local>"
4. Get Dictionary Value for key "picker" from the result of step 3.
5. Choose from List using the value from step 4. Prompt text: "Where should this go?"
6. If the Chosen Item is "New folder":
   6a. Ask for Input, type Text, prompt "Folder name".
   Otherwise:
   6b. Get the Chosen Item.
   End If.
   (The If block's result is either the typed folder name or the chosen menu item.)
7. Get Contents of URL:
   - URL: https://dmqrroajctiiojbtsxbu.supabase.co/functions/v1/ingest
   - Method: POST
   - Header: key "x-api-key", value "<INGEST_API_KEY>"
   - Request Body: JSON with two text fields:
     "url" = the First Item from step 2
     "board_name" = the If Result from step 6
8. Get Dictionary Value for key "message" from the result of step 7.
9. Show Notification with the Dictionary Value from step 8 as the body.

IMPORTANT
- All URLs must be plain text, not formatted text (paste into the action search bar first to strip formatting).
- The header key is exactly "x-api-key".
- Step 7's "url" field must reference the shared link from step 2, not the API address.
```

## Gotchas hit while building

- "Get URLs from **Input**" with *Input* greyed out means it is unbound → server gets no URL (400). It must show the blue *Shortcut Input* token.
- Pasting a URL from Notes/Messages inserts rich text → "couldn't convert from Rich Text to URL". Type it or paste via the search bar.
- Siri initially left the top block as "Receive … from **Nowhere**" (share sheet off) and added a stray empty Text action. Turn Share Sheet on in ⓘ; delete unused actions.
- Siri's If/Otherwise + "If Result" pattern works and avoids a Set Variable.

## Server-side behavior the Shortcut relies on

- `GET /boards` → `picker` = `["New folder", ...boards, "Auto"]` (Unsorted excluded).
- `POST /ingest` with `board_name: "Auto"` → AI files it. Any other `board_name` → that board, created if missing, name kept exactly as typed.
- AI-created board names: no emoji/symbols, max 3 words (enforced server-side).
