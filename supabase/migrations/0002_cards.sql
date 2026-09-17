-- v1.1: copies + user-editable description ("blurb")
alter table public.items add column if not exists copied_from uuid references public.items(id) on delete set null;
alter table public.items add column if not exists blurb text;
-- Originals stay unique per URL; copies (copied_from set) are exempt.
alter table public.items drop constraint if exists items_user_id_canonical_url_key;
create unique index if not exists items_user_canonical_original_uidx on public.items (user_id, canonical_url) where copied_from is null;
create index if not exists items_copied_from_idx on public.items (copied_from);
