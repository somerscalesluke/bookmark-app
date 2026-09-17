-- v1.3 batch 2: can the original page be shown inside the viewer's iframe?
-- null = unknown / not applicable (instagram, tiktok, youtube use their own embed endpoints)
alter table public.items add column if not exists embeddable boolean;
comment on column public.items.embeddable is 'true if the page allows framing by the viewer origin (checked via X-Frame-Options / CSP frame-ancestors at ingest); null for social sources';
