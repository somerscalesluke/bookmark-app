-- bookmark-app v1 schema
create extension if not exists pgcrypto;

create table if not exists public.boards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  description text not null default '',
  created_by  text not null default 'ai' check (created_by in ('ai','user')),
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.items (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  board_id               uuid references public.boards(id) on delete set null,
  url                    text not null,
  canonical_url          text not null,
  source                 text not null default 'other',
  title                  text,
  description            text,
  author                 text,
  site_name              text,
  thumbnail_url          text,
  original_thumbnail_url text,
  ai_summary             text,
  ai_tags                text[] not null default '{}',
  ai_confidence          real,
  ai_reasoning           text,
  filed_by               text not null default 'ai' check (filed_by in ('ai','user')),
  status                 text not null default 'ready' check (status in ('ready','partial','failed')),
  error                  text,
  raw_meta               jsonb,
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, canonical_url)
);
create index if not exists items_user_board_created_idx on public.items (user_id, board_id, created_at desc);
create index if not exists items_user_created_idx on public.items (user_id, created_at desc);

-- Static API keys for the iOS Shortcut (v1). Store only a sha256 hash.
create table if not exists public.api_keys (
  key_hash   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- updated_at trigger
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists items_set_updated_at on public.items;
create trigger items_set_updated_at before update on public.items
  for each row execute function public.set_updated_at();

-- Board summaries for the viewer / Shortcut picker
create or replace view public.board_summaries as
select b.id, b.user_id, b.name, b.description, b.created_by, b.created_at,
       count(i.id)::int as item_count,
       max(i.created_at) as last_saved_at,
       (array_agg(i.thumbnail_url order by i.created_at desc) filter (where i.thumbnail_url is not null))[1:4] as cover_thumbnails
from public.boards b
left join public.items i on i.board_id = b.id
group by b.id;

-- RLS: end users (v2 auth) see only their rows; service role bypasses.
alter table public.boards   enable row level security;
alter table public.items    enable row level security;
alter table public.api_keys enable row level security;

drop policy if exists boards_owner on public.boards;
create policy boards_owner on public.boards for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists items_owner on public.items;
create policy items_owner on public.items for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- api_keys: no client access at all (service role only)

-- Stage 3: the viewer queries the view with the user's JWT, so it must respect RLS.
alter view public.board_summaries set (security_invoker = true);
grant select on public.board_summaries to authenticated;
grant select, insert, update, delete on public.boards, public.items to authenticated;
