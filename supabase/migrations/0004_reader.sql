-- v1.3 batch 3: cached reader-mode text for cards whose page can't be framed.
-- Separate table on purpose: items.updated_at has a trigger, and caching text must not count as "modified".
create table if not exists public.item_reader (
  item_id uuid primary key references public.items(id) on delete cascade,
  user_id uuid not null,
  title text,
  markdown text not null,
  fetched_at timestamptz not null default now()
);
alter table public.item_reader enable row level security;
-- No policies: only the service role (read edge function) touches this table.
comment on table public.item_reader is 'Article text as markdown (Jina Reader), fetched on first in-app open by the read edge function; refreshed after 30 days';
