-- =====================================================================================
-- خزانة · Khizana — device mode: one archive on every device, kept in step through the owner's
-- Google Drive. Runs after schema.sql in the browser database (PGlite) only — never in Supabase.
-- Safe to run again at any time: every statement is idempotent.
--
--  • every row carries a version (kh_v: a clock that never goes back and is always ahead of what
--    this device has seen) and the device that wrote it (kh_dev);
--  • a change made here is noted in an outbox; a removed row leaves a tombstone;
--  • the app sends the outbox to Drive as a «changeset» (kh_sync_take / kh_sync_ack) and applies the
--    changesets of the other devices with kh_sync_apply: row by row, the newer version wins;
--  • a new device loads a full snapshot (kh_sync_dump → kh_sync_load), then the newer changesets;
--  • stored files go to the hidden app folder of Drive (kh_blobs, kh_blob_queue) and a readable copy
--    of every document outside the vault goes to the visible «خزانة» folder (kh_mirror).
-- =====================================================================================

create table if not exists public.kh_local_meta (key text primary key, value text);

-- ------------------------------------------------------------------ what Drive holds
-- every stored file (page image, thumbnail, original) and its id in the hidden app folder
create table if not exists public.kh_blobs (
  path text primary key,
  owner_id uuid not null default auth.uid(),
  drive_id text not null,
  size bigint,
  mime text,
  uploaded_at timestamptz not null default now()
);

-- the readable copy of each document in the visible «خزانة» folder (no foreign key on purpose:
-- when a document is removed for good, its row tells which Drive file to remove too)
create table if not exists public.kh_mirror (
  document_id uuid primary key,
  owner_id uuid not null default auth.uid(),
  drive_id text not null,
  folder text,
  category_id uuid,
  trashed boolean not null default false,
  name text,
  src text,
  updated_at timestamptz not null default now()
);

-- this device only: the documents whose readable copy may need work (the nil id = the shelf folders)
create table if not exists public.kh_mirror_dirty (
  document_id uuid primary key,
  at timestamptz not null default clock_timestamp()
);

-- this device's work for Drive: files to upload, files to remove (never shared with other devices)
-- rank: 0 removal, 1 thumbnail, 2 page image, 3 original (small first)
create table if not exists public.kh_blob_queue (
  path text not null,
  op text not null check (op in ('up', 'del')),
  drive_id text,
  tries int not null default 0,
  next_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  primary key (path, op)
);
alter table public.kh_blob_queue add column if not exists rank int not null default 2;
create index if not exists kh_blob_queue_next on public.kh_blob_queue (rank, created_at);

-- ------------------------------------------------------------------ versions, outbox, tombstones
create table if not exists public.kh_sync_clock (id int primary key default 1 check (id = 1), last bigint not null default 0);
insert into public.kh_sync_clock (id, last) values (1, 0) on conflict (id) do nothing;

create table if not exists public.kh_sync_outbox (
  tbl text not null,
  pk jsonb not null,
  at timestamptz not null default clock_timestamp(),
  primary key (tbl, pk)
);
create index if not exists kh_sync_outbox_at on public.kh_sync_outbox (at);

-- (x: what else must be known of the removed row — the path of a stored file)
create table if not exists public.kh_sync_tomb (
  tbl text not null,
  pk jsonb not null,
  v bigint not null,
  dev text not null,
  at timestamptz not null default now(),
  primary key (tbl, pk)
);
alter table public.kh_sync_tomb add column if not exists x jsonb;
create index if not exists kh_sync_tomb_path on public.kh_sync_tomb ((x ->> 'path')) where tbl = 'kh_files';
create index if not exists kh_sync_tomb_dev on public.kh_sync_tomb (dev);

-- rows from another device that could not be applied yet, and what each one waits for
create table if not exists public.kh_sync_pending (
  tbl text not null,
  pk jsonb not null,
  row jsonb not null,
  tries int not null default 0,
  error text,
  at timestamptz not null default now(),
  primary key (tbl, pk)
);
alter table public.kh_sync_pending add column if not exists since timestamptz not null default now();
alter table public.kh_sync_pending add column if not exists wait_t text;
alter table public.kh_sync_pending add column if not exists wait_c text;
alter table public.kh_sync_pending add column if not exists wait_v text;
create index if not exists kh_sync_pending_wait on public.kh_sync_pending (wait_t, wait_v);

-- the same thing made on two devices under two ids (a box with the same code…): the id that lost
-- points to the one kept, so rows that still name the old one land on the right row
create table if not exists public.kh_sync_alias (
  tbl text not null,
  old_id text not null,
  new_id text not null,
  at timestamptz not null default now(),
  primary key (tbl, old_id)
);

-- the synced tables, parents first; the SQL fragments are worked out below from the catalog
create table if not exists public.kh_sync_tables (
  tbl text primary key,
  ord int not null,
  pk text[] not null,
  self_ref text,
  cols text[],
  pk_cond text,
  pk_after text,
  pk_order text,
  fk_filter text,
  fks jsonb
);
alter table public.kh_sync_tables add column if not exists fks jsonb;
insert into public.kh_sync_tables (tbl, ord, pk, self_ref) values
  ('kh_categories', 1, '{id}', 'parent_id'),
  ('kh_locations', 2, '{id}', 'parent_id'),
  ('kh_sessions', 3, '{id}', null),
  ('kh_proposals', 4, '{id}', null),
  ('kh_documents', 5, '{id}', null),
  ('kh_files', 6, '{id}', null),
  ('kh_pages', 7, '{id}', null),
  ('kh_lsh', 8, '{document_id,band}', null),
  ('kh_entities', 9, '{id}', 'merged_into'),
  ('kh_doc_entities', 10, '{document_id,entity_id,role}', null),
  ('kh_links', 11, '{id}', null),
  ('kh_reviews', 12, '{id}', null),
  ('kh_rejections', 13, '{owner_id,name_norm}', null),
  ('kh_corrections', 14, '{kh_uid}', null),
  ('kh_deadlines', 15, '{id}', null),
  ('kh_ai_usage', 16, '{kh_uid}', null),
  ('kh_ai_jobs', 17, '{id}', null),
  ('kh_settings', 18, '{owner_id,key}', null),
  ('kh_audit', 19, '{kh_uid}', null),
  ('kh_collections', 20, '{id}', null),
  ('kh_collection_docs', 21, '{collection_id,document_id}', null),
  ('kh_share_links', 22, '{id}', null),
  ('kh_blobs', 23, '{path}', null),
  ('kh_mirror', 24, '{document_id}', null)
on conflict (tbl) do update set ord = excluded.ord, pk = excluded.pk, self_ref = excluded.self_ref;

-- rows numbered by this device only (corrections, usage, journal) get a key unique everywhere
alter table public.kh_corrections add column if not exists kh_uid uuid not null default gen_random_uuid();
create unique index if not exists kh_corrections_uid on public.kh_corrections (kh_uid);
alter table public.kh_ai_usage add column if not exists kh_uid uuid not null default gen_random_uuid();
create unique index if not exists kh_ai_usage_uid on public.kh_ai_usage (kh_uid);
alter table public.kh_audit add column if not exists kh_uid uuid not null default gen_random_uuid();
create unique index if not exists kh_audit_uid on public.kh_audit (kh_uid);

do $$
declare t record;
begin
  for t in select tbl from public.kh_sync_tables loop
    execute format('alter table public.%I add column if not exists kh_v bigint, add column if not exists kh_dev text', t.tbl);
  end loop;
end $$;

-- the SQL fragments of each table: its columns, its key, and its parents (fks: every link to a parent,
-- the table's own parent included; fk_filter: the parents a row cannot live without, for loading)
do $$
declare t record; v_cols text[]; v_cond text; v_aft text; v_ord text; v_fk text; v_fks jsonb;
begin
  for t in select * from public.kh_sync_tables loop
    select array_agg(a.attname::text order by a.attnum) into v_cols
      from pg_attribute a
     where a.attrelid = ('public.' || t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> 'search' and a.attidentity = '' and a.attgenerated = '';
    select string_agg(format('x.%I = ($1 ->> %L)::%s', c.col, c.col, format_type(a.atttypid, a.atttypmod)), ' and ' order by c.n),
           format('(%s) > (%s)', string_agg(format('x.%I', c.col), ', ' order by c.n),
                  string_agg(format('($1 ->> %L)::%s', c.col, format_type(a.atttypid, a.atttypmod)), ', ' order by c.n)),
           string_agg(format('x.%I', c.col), ', ' order by c.n)
      into v_cond, v_aft, v_ord
      from unnest(t.pk) with ordinality c(col, n)
      join pg_attribute a on a.attrelid = ('public.' || t.tbl)::regclass and a.attname = c.col;
    select string_agg(z.cond, ' and ') filter (where z.deltype <> 'n' and not z.self),
           jsonb_object_agg(z.col, jsonb_build_object('t', z.reltab, 'c', z.refcol, 'cond', z.cond, 'del', z.deltype, 'self', z.self))
      into v_fk, v_fks
      from (select ca.attname::text as col, rc.relname::text as reltab, ra.attname::text as refcol, con.confdeltype as deltype,
                   ca.attname::text is not distinct from t.self_ref as self,
                   format('(x.%I is null or exists (select 1 from public.%I r where r.%I = x.%I))', ca.attname, rc.relname, ra.attname, ca.attname) as cond
              from pg_constraint con
              join pg_attribute ca on ca.attrelid = con.conrelid and ca.attnum = con.conkey[1]
              join pg_class rc on rc.oid = con.confrelid
              join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = con.confkey[1]
             where con.contype = 'f' and con.conrelid = ('public.' || t.tbl)::regclass and array_length(con.conkey, 1) = 1) z;
    update public.kh_sync_tables set cols = v_cols, pk_cond = v_cond, pk_after = v_aft, pk_order = v_ord, fk_filter = v_fk, fks = v_fks where tbl = t.tbl;
  end loop;
end $$;

-- ------------------------------------------------------------------ ids that follow the meaning
-- links, deadlines and boxes made before this version get the id their meaning gives them (the same
-- thing made on two devices is then one row): done once, nothing changes for the owner
do $$
declare r record; nid uuid;
begin
  update public.kh_links set id = public.kh_key_uuid('link|' || from_id || '|' || to_id || '|' || relation)
   where id <> public.kh_key_uuid('link|' || from_id || '|' || to_id || '|' || relation);
  update public.kh_deadlines set id = public.kh_key_uuid('deadline|' || document_id || '|' || kind || '|' || due_date)
   where document_id is not null and id <> public.kh_key_uuid('deadline|' || document_id || '|' || kind || '|' || due_date);
  for r in select * from public.kh_locations where id <> public.kh_key_uuid('location|' || owner_id || '|' || code) order by created_at loop
    nid := public.kh_key_uuid('location|' || r.owner_id || '|' || r.code);
    continue when exists (select 1 from public.kh_locations where id = nid);
    update public.kh_locations set code = code || '~' where id = r.id;
    insert into public.kh_locations (id, owner_id, parent_id, code, name, kind, place, notes, created_at)
    values (nid, r.owner_id, r.parent_id, r.code, r.name, r.kind, r.place, r.notes, r.created_at);
    update public.kh_documents set original_location_id = nid where original_location_id = r.id;
    update public.kh_sessions set location_id = nid where location_id = r.id;
    update public.kh_locations set parent_id = nid where parent_id = r.id;
    delete from public.kh_locations where id = r.id;
  end loop;
end $$;

-- ------------------------------------------------------------------ the clock and this device
create or replace function public.kh_hlc_next() returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v bigint;
begin
  update public.kh_sync_clock set last = greatest(last + 1, (extract(epoch from clock_timestamp()) * 1000000)::bigint)
   where id = 1 returning last into v;
  return v;
end $$;

create or replace function public.kh_hlc_seen(x bigint) returns void
language sql security definer set search_path = public, extensions as $$
  update public.kh_sync_clock set last = greatest(last, coalesce(x, 0)) where id = 1
$$;

-- this device's name (made once, kept for ever)
create or replace function public.kh_sync_dev() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare d text := nullif(current_setting('kh.dev', true), '');
begin
  if d is null then
    select value into d from public.kh_local_meta where key = 'device';
    if d is null then
      insert into public.kh_local_meta (key, value) values ('device', 'd' || substr(md5(gen_random_uuid()::text), 1, 10))
      on conflict (key) do nothing;
      select value into d from public.kh_local_meta where key = 'device';
    end if;
    perform set_config('kh.dev', d, false);
  end if;
  return d;
end $$;

-- is this device linked to an archive in Drive? (changes are sent only then)
create or replace function public.kh_sync_on() returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare c text := nullif(current_setting('kh.capture', true), '');
begin
  if c is null then
    select case when value = '1' then 'on' else 'off' end into c from public.kh_local_meta where key = 'linked';
    c := coalesce(c, 'off');
    perform set_config('kh.capture', c, false);
  end if;
  return c = 'on';
end $$;

create or replace function public.kh_sync_key(pk text[], r jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(c, r -> c), '{}'::jsonb) from unnest(pk) c
$$;

-- ------------------------------------------------------------------ noting the changes
-- before a write: the row gets this transaction's version (unless only derived columns changed)
create or replace function public.kh_sync_stamp() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v bigint;
begin
  if current_setting('kh.applying', true) = 'on' then return new; end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'search' - 'updated_at' - 'kh_v' - 'kh_dev')
                        = (to_jsonb(old) - 'search' - 'updated_at' - 'kh_v' - 'kh_dev') then
    new.kh_v := old.kh_v;
    new.kh_dev := old.kh_dev;
    return new;
  end if;
  v := nullif(current_setting('kh.txv', true), '')::bigint;
  if v is null then
    v := public.kh_hlc_next();
    perform set_config('kh.txv', v::text, true);
  end if;
  new.kh_v := v;
  new.kh_dev := public.kh_sync_dev();
  return new;
end $$;

-- after a write: a removed row leaves a tombstone (always: a device joining again must not bring back
-- what it removed meanwhile), and, when the device is linked, the change goes into the outbox
create or replace function public.kh_sync_capture() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; o jsonb; k jsonb := '{}'; ok jsonb := '{}'; i int; linked boolean;
begin
  if current_setting('kh.applying', true) = 'on' then return null; end if;
  if tg_op = 'UPDATE' and new.kh_v is not distinct from old.kh_v then return null; end if;
  linked := public.kh_sync_on();
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  for i in 0 .. tg_nargs - 1 loop k := k || jsonb_build_object(tg_argv[i], r -> tg_argv[i]); end loop;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
    for i in 0 .. tg_nargs - 1 loop ok := ok || jsonb_build_object(tg_argv[i], o -> tg_argv[i]); end loop;
    if ok <> k then
      -- the key itself changed: the old key is gone for the other devices
      insert into public.kh_sync_tomb (tbl, pk, v, dev, x) values (tg_table_name, ok, public.kh_hlc_next(), public.kh_sync_dev(), null)
      on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, at = now(), x = excluded.x;
      if linked then
        insert into public.kh_sync_outbox (tbl, pk) values (tg_table_name, ok) on conflict (tbl, pk) do update set at = clock_timestamp();
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    insert into public.kh_sync_tomb (tbl, pk, v, dev, x)
    values (tg_table_name, k, public.kh_hlc_next(), public.kh_sync_dev(),
            case when tg_table_name = 'kh_files' then jsonb_build_object('path', r -> 'path') end)
    on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, at = now(), x = excluded.x;
  else
    delete from public.kh_sync_tomb where tbl = tg_table_name and pk = k;
  end if;
  if linked then
    insert into public.kh_sync_outbox (tbl, pk) values (tg_table_name, k) on conflict (tbl, pk) do update set at = clock_timestamp();
  end if;
  return null;
end $$;

-- a file row made on this device: its bytes go to Drive (small first)
create or replace function public.kh_blob_track() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if current_setting('kh.applying', true) = 'on' or not public.kh_sync_on() then return null; end if;
  if not exists (select 1 from public.kh_blobs b where b.path = new.path) then
    insert into public.kh_blob_queue (path, op, rank) values (new.path, 'up', case new.role when 'thumb' then 1 when 'page' then 2 else 3 end)
    on conflict (path, op) do update set rank = least(public.kh_blob_queue.rank, excluded.rank);
  end if;
  return null;
end $$;

-- a document (or one of its files) changed, here or on another device: its readable copy is looked at
create or replace function public.kh_mirror_mark_doc() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare did uuid;
begin
  if not public.kh_sync_on() then return null; end if;
  if tg_op = 'DELETE' then did := old.id; else did := new.id; end if;
  insert into public.kh_mirror_dirty (document_id) values (did) on conflict (document_id) do update set at = clock_timestamp();
  return null;
end $$;
create or replace function public.kh_mirror_mark_file() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.kh_sync_on() then return null; end if;
  if tg_op <> 'INSERT' then
    insert into public.kh_mirror_dirty (document_id) values (old.document_id) on conflict (document_id) do update set at = clock_timestamp();
  end if;
  if tg_op <> 'DELETE' then
    insert into public.kh_mirror_dirty (document_id) values (new.document_id) on conflict (document_id) do update set at = clock_timestamp();
  end if;
  return null;
end $$;
-- a shelf renamed or moved: the folders are looked at (the nil id stands for «the folders»)
create or replace function public.kh_mirror_mark_shelf() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.kh_sync_on() then return null; end if;
  insert into public.kh_mirror_dirty (document_id) values ('00000000-0000-0000-0000-000000000000') on conflict (document_id) do update set at = clock_timestamp();
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from public.kh_sync_tables loop
    execute format('drop trigger if exists kh_sync_stamp on public.%I', t.tbl);
    execute format('create trigger kh_sync_stamp before insert or update on public.%I for each row execute function public.kh_sync_stamp()', t.tbl);
    execute format('drop trigger if exists kh_sync_capture on public.%I', t.tbl);
    execute format('create trigger kh_sync_capture after insert or update or delete on public.%I for each row execute function public.kh_sync_capture(%s)',
                   t.tbl, (select string_agg(quote_literal(c), ', ') from unnest(t.pk) c));
  end loop;
end $$;
drop trigger if exists kh_blob_track on public.kh_files;
create trigger kh_blob_track after insert on public.kh_files for each row execute function public.kh_blob_track();
drop trigger if exists kh_mirror_mark on public.kh_documents;
create trigger kh_mirror_mark after insert or update or delete on public.kh_documents for each row execute function public.kh_mirror_mark_doc();
drop trigger if exists kh_mirror_mark on public.kh_files;
create trigger kh_mirror_mark after insert or update or delete on public.kh_files for each row execute function public.kh_mirror_mark_file();
drop trigger if exists kh_mirror_mark on public.kh_categories;
create trigger kh_mirror_mark after insert or update or delete on public.kh_categories for each statement execute function public.kh_mirror_mark_shelf();

-- ------------------------------------------------------------------ sending: outbox → changeset
create or replace function public.kh_sync_take(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  lim int := least(greatest(coalesce((p ->> 'limit')::int, 1000), 1), 5000);
  e record; t public.kh_sync_tables; r jsonb; tb record;
  rows_ jsonb[] := '{}'; dels jsonb[] := '{}'; keys jsonb[] := '{}';
begin
  for e in select o.tbl, o.pk, o.at from public.kh_sync_outbox o order by o.at, o.tbl limit lim loop
    keys := array_append(keys, jsonb_build_object('t', e.tbl, 'k', e.pk, 'at', e.at));
    select * into t from public.kh_sync_tables where tbl = e.tbl;
    if not found then continue; end if;
    execute format('select to_jsonb(x) - ''search'' from public.%I x where %s', t.tbl, t.pk_cond) into r using e.pk;
    if r is not null then
      rows_ := array_append(rows_, jsonb_build_object('t', e.tbl, 'd', r));
    else
      select v, dev, x into tb from public.kh_sync_tomb where tbl = e.tbl and pk = e.pk;
      if not found then
        dels := array_append(dels, jsonb_build_object('t', e.tbl, 'k', e.pk, 'v', public.kh_hlc_next(), 'dev', public.kh_sync_dev()));
      else
        dels := array_append(dels, jsonb_build_object('t', e.tbl, 'k', e.pk, 'v', tb.v, 'dev', tb.dev) || case when tb.x is not null then jsonb_build_object('x', tb.x) else '{}'::jsonb end);
      end if;
    end if;
  end loop;
  return jsonb_build_object('rows', to_jsonb(rows_), 'dels', to_jsonb(dels), 'keys', to_jsonb(keys),
    'more', (select count(*) from public.kh_sync_outbox) > cardinality(keys));
end $$;

-- the changeset is safely in Drive: forget those entries (unless changed again since)
create or replace function public.kh_sync_ack(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.kh_sync_outbox o using jsonb_array_elements(public.kh_arr(p -> 'keys')) x
   where o.tbl = x ->> 't' and o.pk = x -> 'k' and o.at <= (x ->> 'at')::timestamptz;
  return jsonb_build_object('ok', true, 'left', (select count(*) from public.kh_sync_outbox));
end $$;

-- the rows made on this device, and what it removed, into the outbox (joining an archive that already
-- has other devices; with {"mine": false}, every row)
create or replace function public.kh_sync_mark_all(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.kh_sync_tables; n int := 0; m int; me text := public.kh_sync_dev();
  only_mine boolean := coalesce((p ->> 'mine')::boolean, true);
begin
  for t in select * from public.kh_sync_tables order by ord loop
    execute format('insert into public.kh_sync_outbox (tbl, pk, at) select %L, public.kh_sync_key(%L::text[], to_jsonb(x)), clock_timestamp() from public.%I x
                    where not $1 or x.kh_dev is null or x.kh_dev = $2 on conflict (tbl, pk) do nothing', t.tbl, t.pk, t.tbl)
      using only_mine, me;
    get diagnostics m = row_count;
    n := n + m;
  end loop;
  insert into public.kh_sync_outbox (tbl, pk, at)
  select tbl, pk, clock_timestamp() from public.kh_sync_tomb where not only_mine or dev = me
  on conflict (tbl, pk) do nothing;
  get diagnostics m = row_count;
  return jsonb_build_object('rows', n, 'removed', m);
end $$;

-- ------------------------------------------------------------------ receiving: changeset → rows
-- links to rows that were merged into another row (see kh_sync_alias) are set to that row
create or replace function public.kh_sync_fk_rewrite(t public.kh_sync_tables, r jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f record; v text; nv text; hops int;
begin
  if t.fks is null or not exists (select 1 from public.kh_sync_alias) then return r; end if;
  for f in select x.key as col, x.value as d from jsonb_each(t.fks) x loop
    v := r ->> f.col;
    continue when v is null;
    hops := 0;
    loop
      select new_id into nv from public.kh_sync_alias where tbl = f.d ->> 't' and old_id = v;
      exit when nv is null or hops > 5;
      v := nv;
      nv := null;
      hops := hops + 1;
    end loop;
    if v is distinct from r ->> f.col then r := r || jsonb_build_object(f.col, v); end if;
  end loop;
  return r;
end $$;

-- one row from another device: written only when it is newer than what is here (and not removed later)
create or replace function public.kh_sync_put(t public.kh_sync_tables, r jsonb) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  k jsonb; iv bigint := coalesce((r ->> 'kh_v')::bigint, 0); idev text := coalesce(r ->> 'kh_dev', '');
  tv bigint; tdev text; lv bigint; ldev text; n int; cl text;
begin
  if r ? 'owner_id' then r := r || jsonb_build_object('owner_id', auth.uid()); end if;
  r := public.kh_sync_fk_rewrite(t, r);
  k := public.kh_sync_key(t.pk, r);
  select v, dev into tv, tdev from public.kh_sync_tomb where tbl = t.tbl and pk = k;
  if found and (tv, tdev) >= (iv, idev) then return 'gone'; end if;
  execute format('select coalesce(x.kh_v, 0), coalesce(x.kh_dev, '''') from public.%I x where %s', t.tbl, t.pk_cond) into lv, ldev using k;
  get diagnostics n = row_count;
  -- only the columns the other device sent (an older app version knows fewer columns)
  select string_agg(format('%I', c), ', ') into cl from unnest(t.cols) c where r ? c;
  if n > 0 then
    if (lv, ldev) >= (iv, idev) then return 'older'; end if;
    execute format('update public.%I x set (%s) = (select %s from jsonb_populate_record(null::public.%I, $2)) where %s',
                   t.tbl, cl, cl, t.tbl, t.pk_cond) using k, r;
  else
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', t.tbl, cl, cl, t.tbl) using r;
  end if;
  delete from public.kh_sync_tomb where tbl = t.tbl and pk = k;
  return 'applied';
end $$;

-- does any row point to this one? (a row others point to is never replaced in a clash of keys)
create or replace function public.kh_sync_has_children(t public.kh_sync_tables, k jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare f record; hit boolean;
begin
  if t.pk <> '{id}' then return false; end if;
  for f in select c.conrelid::regclass::text as child, ca.attname as col
             from pg_constraint c join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
            where c.contype = 'f' and c.confrelid = ('public.' || t.tbl)::regclass and array_length(c.conkey, 1) = 1 loop
    execute format('select exists (select 1 from %s where %I = $1::uuid)', f.child, f.col) into hit using k ->> 'id';
    if hit then return true; end if;
  end loop;
  return false;
end $$;

-- one row, with what can go wrong: {st: applied | older | gone | wait | error, …}
create or replace function public.kh_sync_row(t public.kh_sync_tables, d jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  st text; cname text; err text; ucols text[]; lrow jsonb; k jsonb; lk jsonb; f record;
  own constant jsonb := jsonb_build_object('owner_id', auth.uid());
  iv bigint := coalesce((d ->> 'kh_v')::bigint, 0); idev text := coalesce(d ->> 'kh_dev', '');
begin
  begin
    st := public.kh_sync_put(t, d);
    return jsonb_build_object('st', st);
  exception
    when foreign_key_violation then
      -- a parent that has not arrived (yet): which one
      get stacked diagnostics cname = constraint_name;
      select ca.attname::text as col, rc.relname::text as wt, ra.attname::text as wc into f
        from pg_constraint con
        join pg_attribute ca on ca.attrelid = con.conrelid and ca.attnum = con.conkey[1]
        join pg_class rc on rc.oid = con.confrelid
        join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = con.confkey[1]
       where con.conname = cname and con.conrelid = ('public.' || t.tbl)::regclass;
      d := public.kh_sync_fk_rewrite(t, d);
      return jsonb_build_object('st', 'wait', 'col', f.col, 'wait_t', f.wt, 'wait_c', f.wc, 'wait_v', d ->> f.col);
    when unique_violation then
      -- the same thing made on two devices under two ids: the newer one stays everywhere
      get stacked diagnostics cname = constraint_name;
      select array_agg(a.attname::text order by u.n) into ucols
        from pg_class ic join pg_index i on i.indexrelid = ic.oid
        join lateral unnest(i.indkey::int2[]) with ordinality u(attnum, n) on true
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = u.attnum
       where ic.relname = cname and i.indrelid = ('public.' || t.tbl)::regclass;
      d := public.kh_sync_fk_rewrite(t, d || own);
      if ucols is not null then
        execute format('select to_jsonb(x) from public.%I x, jsonb_populate_record(null::public.%I, $1) n where %s limit 1', t.tbl, t.tbl,
                       (select string_agg(format('x.%I is not distinct from n.%I', c, c), ' and ') from unnest(ucols) c))
          into lrow using d;
      end if;
      if lrow is null then return jsonb_build_object('st', 'error', 'err', 'unique ' || coalesce(cname, '?')); end if;
      k := public.kh_sync_key(t.pk, d);
      lk := public.kh_sync_key(t.pk, lrow);
      if (iv, idev) > (coalesce((lrow ->> 'kh_v')::bigint, 0), coalesce(lrow ->> 'kh_dev', '')) and not public.kh_sync_has_children(t, lk) then
        -- the newer one replaces the older one, whose id now points to it
        begin
          execute format('delete from public.%I x where %s', t.tbl, t.pk_cond) using lk;
          insert into public.kh_sync_tomb (tbl, pk, v, dev) values (t.tbl, lk, coalesce((lrow ->> 'kh_v')::bigint, 0), coalesce(lrow ->> 'kh_dev', ''))
          on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, at = now()
            where (public.kh_sync_tomb.v, public.kh_sync_tomb.dev) < (excluded.v, excluded.dev);
          if t.pk = '{id}' then
            insert into public.kh_sync_alias (tbl, old_id, new_id) values (t.tbl, lk ->> 'id', k ->> 'id')
            on conflict (tbl, old_id) do update set new_id = excluded.new_id, at = now();
          end if;
          st := public.kh_sync_put(t, d);
          return jsonb_build_object('st', st);
        exception when others then
          get stacked diagnostics err = message_text;
          return jsonb_build_object('st', 'error', 'err', err);
        end;
      end if;
      -- the row here stays (it is newer, or other rows point to it): the one that came goes, and its id
      -- points to the one kept (rows that name it land on the kept row)
      insert into public.kh_sync_tomb (tbl, pk, v, dev) values (t.tbl, k, iv, idev)
      on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, at = now()
        where (public.kh_sync_tomb.v, public.kh_sync_tomb.dev) < (excluded.v, excluded.dev);
      if t.pk = '{id}' then
        insert into public.kh_sync_alias (tbl, old_id, new_id) values (t.tbl, k ->> 'id', lk ->> 'id')
        on conflict (tbl, old_id) do update set new_id = excluded.new_id, at = now();
      end if;
      return jsonb_build_object('st', 'gone');
    when others then
      get stacked diagnostics err = message_text;
      return jsonb_build_object('st', 'error', 'err', err);
  end;
end $$;

-- the rows of one table: parents of the same table first (several passes), what still waits is kept
create or replace function public.kh_sync_rows(t public.kh_sync_tables, rows_ jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  todo jsonb[]; again jsonb[]; e jsonb; r jsonb; d jsonb; w jsonb; k jsonb; progress boolean; dead boolean;
  applied int := 0; older int := 0; gone int := 0; parked int := 0; maxv bigint := 0;
  docs uuid[] := '{}'; cats uuid[] := '{}'; ents uuid[] := '{}';
  own constant jsonb := jsonb_build_object('owner_id', auth.uid());
begin
  select coalesce(array_agg(x), '{}') into todo from jsonb_array_elements(public.kh_arr(rows_)) x;
  again := '{}';
  loop
    again := '{}';
    progress := false;
    foreach e in array todo loop
      r := public.kh_sync_row(t, e -> 'd');
      if r ->> 'st' = 'wait' then
        again := array_append(again, jsonb_build_object('d', e -> 'd', 'w', r));
        continue;
      end if;
      progress := true;
      k := public.kh_sync_key(t.pk, public.kh_sync_fk_rewrite(t, (e -> 'd') || own));
      if r ->> 'st' = 'error' then
        insert into public.kh_sync_pending (tbl, pk, row, tries, error) values (t.tbl, k, e -> 'd', 1, r ->> 'err')
        on conflict (tbl, pk) do update set row = excluded.row, tries = public.kh_sync_pending.tries + 1, error = excluded.error, at = now(),
          wait_t = null, wait_c = null, wait_v = null;
        parked := parked + 1;
        continue;
      end if;
      delete from public.kh_sync_pending where tbl = t.tbl and pk = k;
      if r ->> 'st' = 'applied' then
        applied := applied + 1;
        maxv := greatest(maxv, coalesce((e -> 'd' ->> 'kh_v')::bigint, 0));
        if t.tbl = 'kh_documents' then docs := docs || (e -> 'd' ->> 'id')::uuid;
        elsif t.tbl in ('kh_pages', 'kh_doc_entities') then docs := docs || (e -> 'd' ->> 'document_id')::uuid;
        elsif t.tbl = 'kh_entities' then ents := ents || (e -> 'd' ->> 'id')::uuid;
        elsif t.tbl = 'kh_categories' then cats := cats || (e -> 'd' ->> 'id')::uuid;
        end if;
      elsif r ->> 'st' = 'older' then older := older + 1;
      else gone := gone + 1;
      end if;
    end loop;
    exit when cardinality(again) = 0 or not progress;
    todo := again;
  end loop;

  -- still waiting for a parent: if that parent was removed on a device, the link is cleared (or the row
  -- goes with its parent, as Postgres itself does); otherwise the row is kept for later
  foreach e in array again loop
    d := e -> 'd';
    w := e -> 'w';
    dead := false;
    if w ->> 'wait_v' is not null and exists (select 1 from public.kh_sync_tomb s where s.tbl = w ->> 'wait_t'
                                                and s.pk = jsonb_build_object(w ->> 'wait_c', w ->> 'wait_v')) then
      if t.fks -> (w ->> 'col') ->> 'del' = 'n' then d := d || jsonb_build_object(w ->> 'col', null); else dead := true; end if;
    end if;
    k := public.kh_sync_key(t.pk, public.kh_sync_fk_rewrite(t, (e -> 'd') || own));
    if dead then
      gone := gone + 1;
      delete from public.kh_sync_pending where tbl = t.tbl and pk = k;
      continue;
    end if;
    if d is distinct from e -> 'd' then
      r := public.kh_sync_row(t, d);
      if r ->> 'st' in ('applied', 'older', 'gone') then
        if r ->> 'st' = 'applied' then applied := applied + 1; else gone := gone + 1; end if;
        delete from public.kh_sync_pending where tbl = t.tbl and pk = k;
        continue;
      end if;
      if r ->> 'st' = 'wait' then w := r; end if;
    end if;
    insert into public.kh_sync_pending (tbl, pk, row, tries, error, wait_t, wait_c, wait_v)
    values (t.tbl, k, e -> 'd', 1, 'parent missing', w ->> 'wait_t', w ->> 'wait_c', w ->> 'wait_v')
    on conflict (tbl, pk) do update set
      row = case when coalesce((excluded.row ->> 'kh_v')::bigint, 0) >= coalesce((public.kh_sync_pending.row ->> 'kh_v')::bigint, 0)
                 then excluded.row else public.kh_sync_pending.row end,
      tries = public.kh_sync_pending.tries + 1, error = excluded.error, at = now(),
      wait_t = excluded.wait_t, wait_c = excluded.wait_c, wait_v = excluded.wait_v;
    parked := parked + 1;
  end loop;
  return jsonb_build_object('applied', applied, 'older', older, 'gone', gone, 'parked', parked, 'maxv', maxv,
    'docs', to_jsonb(docs), 'cats', to_jsonb(cats), 'ents', to_jsonb(ents));
end $$;

create or replace function public.kh_sync_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  t public.kh_sync_tables; e jsonb; r jsonb; rows_ jsonb; wt text; wc text;
  applied int := 0; older int := 0; gone int := 0; parked int := 0; maxv bigint := 0;
  docs uuid[] := '{}'; cats uuid[] := '{}'; ents uuid[] := '{}'; paths text[] := '{}'; removed text[] := '{}';
  k jsonb; lv bigint; ldev text; iv bigint; idev text; n int;
  own constant jsonb := jsonb_build_object('owner_id', auth.uid());
  batch jsonb := public.kh_arr(p -> 'rows');
begin
  perform set_config('kh.applying', 'on', true);

  -- 1. removals first, children first: a row replaced in the same changeset is gone before its successor
  for e in select x from jsonb_array_elements(public.kh_arr(p -> 'dels')) x
           order by coalesce((select s.ord from public.kh_sync_tables s where s.tbl = x ->> 't'), 0) desc loop
    select * into t from public.kh_sync_tables where tbl = e ->> 't';
    if not found then continue; end if;
    k := e -> 'k';
    if k ? 'owner_id' then k := k || own; end if;
    iv := coalesce((e ->> 'v')::bigint, 0);
    idev := coalesce(e ->> 'dev', '');
    maxv := greatest(maxv, iv);
    execute format('select coalesce(x.kh_v, 0), coalesce(x.kh_dev, '''') from public.%I x where %s', t.tbl, t.pk_cond) into lv, ldev using k;
    get diagnostics n = row_count;
    -- changed here after it was removed there: it stays
    if n > 0 and (lv, ldev) > (iv, idev) then continue; end if;
    if n > 0 then
      begin
        if t.tbl = 'kh_doc_entities' then docs := docs || (k ->> 'document_id')::uuid; end if;
        execute format('delete from public.%I x where %s', t.tbl, t.pk_cond) using k;
      exception when others then
        continue;
      end;
    end if;
    if t.tbl = 'kh_blobs' then paths := paths || (k ->> 'path'); end if;
    if t.tbl = 'kh_files' and e -> 'x' ->> 'path' is not null then paths := paths || (e -> 'x' ->> 'path'); end if;
    insert into public.kh_sync_tomb (tbl, pk, v, dev, x) values (t.tbl, k, iv, idev, e -> 'x')
    on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, at = now(), x = coalesce(excluded.x, public.kh_sync_tomb.x)
      where (public.kh_sync_tomb.v, public.kh_sync_tomb.dev) < (excluded.v, excluded.dev);
    delete from public.kh_sync_pending where tbl = t.tbl and pk = k;
  end loop;

  -- 2. rows, parents first
  for t in select * from public.kh_sync_tables order by ord loop
    select jsonb_agg(jsonb_build_object('d', x -> 'd')) into rows_ from jsonb_array_elements(batch) x where x ->> 't' = t.tbl;
    continue when rows_ is null;
    -- a file another device uploaded after its document was removed here: looked at below
    if t.tbl = 'kh_blobs' then paths := paths || array(select x -> 'd' ->> 'path' from jsonb_array_elements(rows_) x); end if;
    r := public.kh_sync_rows(t, rows_);
    applied := applied + (r ->> 'applied')::int; older := older + (r ->> 'older')::int;
    gone := gone + (r ->> 'gone')::int; parked := parked + (r ->> 'parked')::int;
    maxv := greatest(maxv, (r ->> 'maxv')::bigint);
    docs := docs || array(select jsonb_array_elements_text(r -> 'docs')::uuid);
    cats := cats || array(select jsonb_array_elements_text(r -> 'cats')::uuid);
    ents := ents || array(select jsonb_array_elements_text(r -> 'ents')::uuid);
  end loop;

  -- 3. rows kept earlier whose parent is here now (or was removed, or is known under another id);
  --    a row kept for another reason is tried a few times; nothing waits longer than 60 days
  delete from public.kh_sync_pending where since < now() - interval '60 days';
  for wt, wc in select distinct wait_t, wait_c from public.kh_sync_pending where wait_t is not null and wait_c is not null loop
    for t in select * from public.kh_sync_tables
              where tbl in (select distinct tbl from public.kh_sync_pending where wait_t = wt) order by ord loop
      execute format('select jsonb_agg(jsonb_build_object(''d'', p.row)) from public.kh_sync_pending p
                       where p.tbl = %L and p.wait_t = %L and p.wait_c = %L
                         and (exists (select 1 from public.%I r where r.%I::text = p.wait_v)
                              or exists (select 1 from public.kh_sync_alias a where a.tbl = %L and a.old_id = p.wait_v)
                              or exists (select 1 from public.kh_sync_tomb s where s.tbl = %L and s.pk = jsonb_build_object(p.wait_c, p.wait_v)))',
                     t.tbl, wt, wc, wt, wc, wt, wt)
        into rows_;
      continue when rows_ is null;
      r := public.kh_sync_rows(t, rows_);
      applied := applied + (r ->> 'applied')::int; gone := gone + (r ->> 'gone')::int;
      maxv := greatest(maxv, (r ->> 'maxv')::bigint);
      docs := docs || array(select jsonb_array_elements_text(r -> 'docs')::uuid);
      cats := cats || array(select jsonb_array_elements_text(r -> 'cats')::uuid);
      ents := ents || array(select jsonb_array_elements_text(r -> 'ents')::uuid);
    end loop;
  end loop;
  for t in select * from public.kh_sync_tables where tbl in (select tbl from public.kh_sync_pending where wait_t is null and tries < 4) order by ord loop
    select jsonb_agg(jsonb_build_object('d', row)) into rows_ from public.kh_sync_pending where tbl = t.tbl and wait_t is null and tries < 4;
    continue when rows_ is null;
    r := public.kh_sync_rows(t, rows_);
    applied := applied + (r ->> 'applied')::int;
  end loop;
  parked := (select count(*) from public.kh_sync_pending);

  -- 4. the clock, the search vectors (worked out here, not sent), and the bytes nothing uses any more
  perform public.kh_hlc_seen(maxv);
  docs := docs || coalesce((select array_agg(distinct de.document_id) from public.kh_doc_entities de where de.entity_id = any(ents)), '{}');
  if cardinality(cats) > 0 then
    docs := docs || coalesce((select array_agg(d.id) from public.kh_documents d where d.category_id = any(public.kh_category_tree_ids(cats))), '{}');
  end if;
  perform public.kh_reindex(z.x) from (select distinct unnest(docs) as x) z where exists (select 1 from public.kh_documents d where d.id = z.x);
  removed := public.kh_blob_gc(paths);
  return jsonb_build_object('applied', applied, 'older', older, 'gone', gone, 'parked', parked,
    'removed_paths', to_jsonb(removed), 'documents', (select count(distinct x) from unnest(docs) x));
end $$;

-- stored files whose rows were removed (here or on another device) and that no row uses any more:
-- this device forgets the bytes, does not upload them, and the copy in Drive is removed
-- (only paths known to be removed are touched: a file row still waiting for its document is kept)
create or replace function public.kh_blob_gc(cand text[] default null) returns text[]
language plpgsql security definer set search_path = public, extensions as $$
declare pth text; b public.kh_blobs; gone text[] := '{}';
begin
  for pth in
    select distinct z.p from (
      select unnest(coalesce(cand, '{}'::text[])) as p
      union all
      -- a file uploaded by another device whose document was already removed here
      select b2.path from public.kh_blobs b2
       where cand is null and exists (select 1 from public.kh_sync_tomb s where s.tbl = 'kh_files' and s.x ->> 'path' = b2.path)) z
  loop
    continue when pth is null;
    continue when exists (select 1 from public.kh_files f where f.path = pth);
    continue when exists (select 1 from public.kh_sync_pending q where q.tbl = 'kh_files' and q.row ->> 'path' = pth);
    continue when not exists (select 1 from public.kh_sync_tomb s where (s.tbl = 'kh_files' and s.x ->> 'path' = pth)
                                                                    or (s.tbl = 'kh_blobs' and s.pk ->> 'path' = pth));
    delete from public.kh_blob_queue where path = pth and op = 'up';
    select * into b from public.kh_blobs where path = pth;
    if found then
      insert into public.kh_blob_queue (path, op, drive_id, rank) values (pth, 'del', b.drive_id, 0)
      on conflict (path, op) do update set drive_id = excluded.drive_id, next_at = now();
      delete from public.kh_blobs where path = pth;
    end if;
    gone := gone || pth;
  end loop;
  return gone;
end $$;

-- ------------------------------------------------------------------ snapshots
-- one page of a table, search vectors included (a new device does not recompute them)
create or replace function public.kh_sync_dump(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.kh_sync_tables; lim int := least(greatest(coalesce((p ->> 'limit')::int, 2000), 1), 20000); rows_ jsonb; n int;
begin
  select * into t from public.kh_sync_tables where tbl = p ->> 't';
  if not found then raise exception 'unknown table'; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by %s), ''[]''::jsonb) from (select * from public.%I x where $1 is null or %s order by %s limit $2) x',
                 t.pk_order, t.tbl, t.pk_after, t.pk_order)
    into rows_ using case when jsonb_typeof(p -> 'after') = 'object' then p -> 'after' end, lim;
  n := jsonb_array_length(rows_);
  return jsonb_build_object('rows', rows_, 'done', n < lim,
    'after', case when n > 0 then public.kh_sync_key(t.pk, rows_ -> (n - 1)) end);
end $$;

create or replace function public.kh_sync_dump_tombs(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', tbl, 'k', pk, 'v', v, 'dev', dev) || case when x is not null then jsonb_build_object('x', x) else '{}'::jsonb end), '[]'::jsonb)
  from public.kh_sync_tomb where at > now() - interval '180 days'
$$;

-- rows still waiting for a parent: they go into a snapshot too (the changesets they came in are covered by it)
create or replace function public.kh_sync_dump_pending(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', tbl, 'd', row)), '[]'::jsonb) from public.kh_sync_pending
$$;

-- a new device: whole tables at once (nothing here yet, so no comparing of versions)
create or replace function public.kh_sync_load(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t public.kh_sync_tables; n int := 0; cl text; sel text; maxv bigint; own constant jsonb := jsonb_build_object('owner_id', auth.uid());
begin
  perform set_config('kh.applying', 'on', true);
  if jsonb_typeof(p -> 'tombs') = 'array' then
    insert into public.kh_sync_tomb (tbl, pk, v, dev, x)
    select x ->> 't', case when (x -> 'k') ? 'owner_id' then (x -> 'k') || own else x -> 'k' end, (x ->> 'v')::bigint, x ->> 'dev', x -> 'x'
      from jsonb_array_elements(p -> 'tombs') x
    on conflict (tbl, pk) do update set v = excluded.v, dev = excluded.dev, x = coalesce(excluded.x, public.kh_sync_tomb.x)
      where (public.kh_sync_tomb.v, public.kh_sync_tomb.dev) < (excluded.v, excluded.dev);
    select max((x ->> 'v')::bigint) into maxv from jsonb_array_elements(p -> 'tombs') x;
    perform public.kh_hlc_seen(maxv);
  end if;
  if p ->> 't' is null then return jsonb_build_object('rows', 0); end if;
  select * into t from public.kh_sync_tables where tbl = p ->> 't';
  if not found then raise exception 'unknown table'; end if;
  -- a link whose parent is not here is cleared; a row that cannot live without its parent is left out
  select string_agg(format('%I', c), ', '),
         string_agg(case when t.fks -> c ->> 'del' = 'n' and not coalesce((t.fks -> c ->> 'self')::boolean, false)
                         then format('case when %s then x.%I end', t.fks -> c ->> 'cond', c) else format('x.%I', c) end, ', ')
    into cl, sel
    from unnest(t.cols || case when t.tbl in ('kh_documents', 'kh_pages') then array['search'] else '{}'::text[] end) c;
  if t.self_ref is null then
    execute format('insert into public.%1$I (%2$s) select %4$s from (select (jsonb_populate_record(null::public.%1$I, e || $2)).* from jsonb_array_elements($1) e) x
                    where %3$s on conflict do nothing', t.tbl, cl, coalesce(t.fk_filter, 'true'), sel)
      using public.kh_arr(p -> 'rows'), own;
    get diagnostics n = row_count;
  else
    -- parents may come after their children: rows first, then the links between them
    execute format('insert into public.%1$I (%2$s) select %5$s from (select (jsonb_populate_record(null::public.%1$I, e || $2 || jsonb_build_object(%4$L, null))).*
                    from jsonb_array_elements($1) e) x where %3$s on conflict do nothing', t.tbl, cl, coalesce(t.fk_filter, 'true'), t.self_ref, sel)
      using public.kh_arr(p -> 'rows'), own;
    get diagnostics n = row_count;
    execute format('update public.%1$I x set %2$I = (e ->> %2$L)::uuid from jsonb_array_elements($1) e
                    where x.id = (e ->> ''id'')::uuid and e ->> %2$L is not null and exists (select 1 from public.%1$I y where y.id = (e ->> %2$L)::uuid)',
                   t.tbl, t.self_ref)
      using public.kh_arr(p -> 'rows');
  end if;
  select max((e ->> 'kh_v')::bigint) into maxv from jsonb_array_elements(public.kh_arr(p -> 'rows')) e;
  perform public.kh_hlc_seen(maxv);
  return jsonb_build_object('rows', n);
end $$;

-- a device joining an archive with nothing of its own: start clean (the AI key and the files stay)
create or replace function public.kh_sync_wipe(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t record;
begin
  perform set_config('kh.applying', 'on', true);
  update public.kh_categories set parent_id = null where parent_id is not null;
  update public.kh_locations set parent_id = null where parent_id is not null;
  update public.kh_entities set merged_into = null where merged_into is not null;
  for t in select tbl from public.kh_sync_tables order by ord desc loop
    execute format('delete from public.%I', t.tbl);
  end loop;
  delete from public.kh_sync_outbox;
  delete from public.kh_sync_tomb;
  delete from public.kh_sync_pending;
  delete from public.kh_sync_alias;
  delete from public.kh_blob_queue;
  delete from public.kh_mirror_dirty;
  return jsonb_build_object('ok', true);
end $$;

-- nothing made by the owner on this device yet (only the starting shelves and settings)
create or replace function public.kh_sync_pristine(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('pristine',
    not exists (select 1 from public.kh_documents) and not exists (select 1 from public.kh_entities)
    and not exists (select 1 from public.kh_locations) and not exists (select 1 from public.kh_collections)
    and not exists (select 1 from public.kh_categories where origin <> 'seed'),
    'documents', (select count(*) from public.kh_documents),
    'bytes', (select coalesce(sum(size), 0) from public.kh_files))
$$;

-- before joining an archive with documents of this device: its settings give way to the archive's
-- (the defaults written when this device first opened are newer, but they are not a choice of the owner)
create or replace function public.kh_sync_prepare_merge(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform set_config('kh.applying', 'on', true);
  update public.kh_settings set kh_v = 0, kh_dev = '';
  return jsonb_build_object('ok', true);
end $$;

-- after joining: this device's copies of the starting shelves merge into the archive's own
create or replace function public.kh_sync_fix_seeds(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := public.kh_sync_dev(); r record; n int := 0;
begin
  for r in select l.id as local_id, (select a.id from public.kh_categories a
                                      where a.origin = 'seed' and a.name_ar = l.name_ar and a.id <> l.id and coalesce(a.kh_dev, '') <> me
                                      order by a.id limit 1) as keep_id
             from public.kh_categories l
            where l.origin = 'seed' and (l.kh_dev is null or l.kh_dev = me) loop
    continue when r.keep_id is null;
    update public.kh_documents set category_id = r.keep_id where category_id = r.local_id;
    update public.kh_categories set parent_id = r.keep_id where parent_id = r.local_id;
    update public.kh_proposals set parent_id = r.keep_id where parent_id = r.local_id;
    update public.kh_proposals set result_category_id = r.keep_id where result_category_id = r.local_id;
    update public.kh_rejections set mapped_category_id = r.keep_id where mapped_category_id = r.local_id;
    delete from public.kh_categories where id = r.local_id;
    n := n + 1;
  end loop;
  return jsonb_build_object('merged', n);
end $$;

-- old tombstones, aliases and waiting rows (devices away for half a year start again from a snapshot)
create or replace function public.kh_sync_prune(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; b int; c int;
begin
  delete from public.kh_sync_tomb where at < now() - interval '180 days';
  get diagnostics a = row_count;
  delete from public.kh_sync_alias where at < now() - interval '180 days';
  delete from public.kh_sync_pending where since < now() - interval '60 days';
  get diagnostics b = row_count;
  -- an upload whose file row never came (a failed save) is forgotten after a day
  delete from public.kh_blob_queue q where q.op = 'up' and q.created_at < now() - interval '1 day'
     and not exists (select 1 from public.kh_files f where f.path = q.path);
  get diagnostics c = row_count;
  return jsonb_build_object('tombs', a, 'pending', b, 'uploads', c, 'orphans', cardinality(public.kh_blob_gc(null)));
end $$;

-- ------------------------------------------------------------------ this device's own notes
create or replace function public.kh_sync_meta(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  perform public.kh_sync_dev();
  if jsonb_typeof(p -> 'set') = 'object' then
    for r in select key, value from jsonb_each(p -> 'set') loop
      if jsonb_typeof(r.value) = 'null' then delete from public.kh_local_meta where key = r.key;
      else insert into public.kh_local_meta (key, value) values (r.key, r.value #>> '{}')
           on conflict (key) do update set value = excluded.value;
      end if;
    end loop;
    if p -> 'set' ? 'linked' then
      perform set_config('kh.capture', case when p -> 'set' ->> 'linked' = '1' then 'on' else 'off' end, false);
    end if;
  end if;
  return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.kh_local_meta where key <> 'schema');
end $$;

-- what the background loop needs every few seconds (cheap)
create or replace function public.kh_sync_tick(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'linked', public.kh_sync_on(),
    'outbox', (select count(*) from public.kh_sync_outbox),
    'outbox_first', (select min(at) from public.kh_sync_outbox),
    'outbox_last', (select max(at) from public.kh_sync_outbox),
    'uploads', (select count(*) from public.kh_blob_queue where op = 'up' and next_at <= now()),
    'removals', (select count(*) from public.kh_blob_queue where op = 'del' and next_at <= now()),
    'mirror', exists (select 1 from public.kh_mirror_dirty))
$$;

-- the full picture (for the settings page)
create or replace function public.kh_sync_status(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, extensions as $$
  select public.kh_sync_tick() || jsonb_build_object(
    'device', public.kh_sync_dev(),
    'pending', (select count(*) from public.kh_sync_pending),
    'uploads', (select count(*) from public.kh_blob_queue where op = 'up'),
    'upload_bytes', (select coalesce(sum(z.size), 0) from (select distinct on (q.path) f.size from public.kh_blob_queue q
                       join public.kh_files f on f.path = q.path where q.op = 'up') z),
    'stuck', (select count(*) from public.kh_blob_queue where tries >= 5),
    'last_error', (select error from public.kh_blob_queue where error is not null order by next_at desc limit 1),
    'removals', (select count(*) from public.kh_blob_queue where op = 'del'),
    'in_drive', (select count(*) from public.kh_blobs),
    'mirrored', (select count(*) from public.kh_mirror))
$$;

-- the synced tables, parents first (for snapshots)
create or replace function public.kh_sync_info(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', tbl, 'self', self_ref is not null) order by ord), '[]'::jsonb) from public.kh_sync_tables
$$;

-- ------------------------------------------------------------------ stored files ↔ Drive
-- joining: every stored file made on this device that is not in Drive yet
-- (the files of rows that came from another device are sent by that device)
create or replace function public.kh_blob_enqueue_all(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  insert into public.kh_blob_queue (path, op, rank)
  select f.path, 'up', min(case f.role when 'thumb' then 1 when 'page' then 2 else 3 end) from public.kh_files f
   where not exists (select 1 from public.kh_blobs b where b.path = f.path)
     and (f.kh_dev is null or f.kh_dev = public.kh_sync_dev())
   group by f.path
  on conflict (path, op) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('queued', n);
end $$;

-- the next files to send (small first: thumbnails, then pages, then originals) or to remove
create or replace function public.kh_blob_next(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare lim int := least(greatest(coalesce((p ->> 'limit')::int, 8), 1), 100); r jsonb;
begin
  select coalesce(jsonb_agg(z order by z.rank, z.created_at), '[]'::jsonb) into r from (
    select q.path, q.op, q.drive_id, q.tries, q.rank, q.created_at, f.role, f.mime, f.name, f.size
      from (select * from public.kh_blob_queue where next_at <= now() order by rank, created_at limit lim * 4) q
      left join lateral (select g.role, g.mime, g.name, g.size from public.kh_files g where g.path = q.path
                          order by case g.role when 'thumb' then 0 when 'page' then 1 else 2 end limit 1) f on true
     where q.op = 'del' or f.role is not null
     order by q.rank, q.created_at
     limit lim) z;
  return r;
end $$;

-- the bytes are not on this device (another device sends them): nothing to do here
create or replace function public.kh_blob_drop(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.kh_blob_queue where path = p ->> 'path' and op = 'up';
  return jsonb_build_object('ok', true);
end $$;

-- the Drive id is chosen before the first try: a retry can never make a second copy
create or replace function public.kh_blob_reserve(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare id text;
begin
  update public.kh_blob_queue set drive_id = coalesce(drive_id, p ->> 'drive_id')
   where path = p ->> 'path' and op = 'up' returning drive_id into id;
  return jsonb_build_object('drive_id', id);
end $$;

create or replace function public.kh_blob_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pth text := p ->> 'path';
begin
  if p ->> 'op' = 'del' then
    delete from public.kh_blob_queue where path = pth and op = 'del';
    return jsonb_build_object('ok', true);
  end if;
  delete from public.kh_blob_queue where path = pth and op = 'up';
  if exists (select 1 from public.kh_files f where f.path = pth) then
    insert into public.kh_blobs (path, drive_id, size, mime) values (pth, p ->> 'drive_id', (p ->> 'size')::bigint, p ->> 'mime')
    on conflict (path) do update set drive_id = excluded.drive_id, size = excluded.size, mime = excluded.mime, uploaded_at = now();
    return jsonb_build_object('ok', true, 'kept', true);
  end if;
  -- the document went away while its file was on the way: the copy in Drive goes too
  insert into public.kh_blob_queue (path, op, drive_id, rank) values (pth, 'del', p ->> 'drive_id', 0)
  on conflict (path, op) do update set drive_id = excluded.drive_id, next_at = now();
  return jsonb_build_object('ok', true, 'kept', false);
end $$;

create or replace function public.kh_blob_fail(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.kh_blob_queue set tries = tries + 1, error = left(p ->> 'error', 300),
    next_at = now() + make_interval(secs => greatest(coalesce((p ->> 'wait_s')::int, 60), 5))
   where path = p ->> 'path' and op = p ->> 'op';
  return jsonb_build_object('ok', true);
end $$;

-- try the files that failed again now (after a reconnection, or from the settings)
create or replace function public.kh_blob_retry(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, extensions as $$
  with u as (update public.kh_blob_queue set next_at = now(), tries = least(tries, 3) where next_at > now() returning 1)
  select jsonb_build_object('count', (select count(*) from u))
$$;

-- files no row needs any more (a document removed for good, a failed save): returns the paths whose
-- bytes may go from this device; the copy in Drive is removed (also when another device uploaded it)
create or replace function public.kh_blob_forget(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pth text; b public.kh_blobs; gone text[] := '{}';
begin
  for pth in select distinct x from jsonb_array_elements_text(public.kh_arr(p -> 'paths')) x loop
    continue when exists (select 1 from public.kh_files f where f.path = pth);
    delete from public.kh_blob_queue where path = pth and op = 'up';
    select * into b from public.kh_blobs where path = pth;
    if found then
      insert into public.kh_blob_queue (path, op, drive_id, rank) values (pth, 'del', b.drive_id, 0)
      on conflict (path, op) do update set drive_id = excluded.drive_id, next_at = now();
      delete from public.kh_blobs where path = pth;
    end if;
    gone := gone || pth;
  end loop;
  return jsonb_build_object('paths', to_jsonb(gone));
end $$;

-- where the bytes are in Drive
create or replace function public.kh_blob_where(p jsonb) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(b.path, b.drive_id), '{}'::jsonb) from public.kh_blobs b
   where b.path = any(public.kh_jtext(p -> 'paths'))
$$;

-- stored files that are in Drive and also kept on this device (to free space here)
create or replace function public.kh_blob_cached(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('path', b.path, 'role', f.role, 'pinned', d.pinned_offline)), '[]'::jsonb)
  from public.kh_blobs b
  join lateral (select g.role, g.document_id from public.kh_files g where g.path = b.path
                 order by case g.role when 'thumb' then 0 else 1 end limit 1) f on true
  join public.kh_documents d on d.id = f.document_id
$$;

-- ------------------------------------------------------------------ the readable copy in «خزانة»
-- «title (year).ext», without characters Drive or Windows dislike
create or replace function public.kh_mirror_name(did uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  with d as (select * from public.kh_documents where id = did),
  o as (select f.name, f.path from public.kh_files f where f.document_id = did and f.role = 'original' limit 1),
  b as (select btrim(regexp_replace(coalesce(nullif(btrim(d.title_ar), ''), nullif(btrim(d.title), ''),
                       nullif(regexp_replace(coalesce(d.file_name, ''), '\.[A-Za-z0-9]{1,8}$', ''), ''), 'وثيقة'),
                     '[\\/:*?"<>|[:cntrl:]]+', ' ', 'g')) as title,
               coalesce(d.academic_year, extract(year from d.doc_date)::int::text) as yr
          from d)
  select left(b.title, 120)
         || case when b.yr is not null and position(b.yr in b.title) = 0 then ' (' || b.yr || ')' else '' end
         || '.' || coalesce(lower(coalesce(substring((select name from o) from '\.([A-Za-z0-9]{1,8})$'),
                                           substring((select path from o) from '\.([A-Za-z0-9]{1,8})$'))),
                            case when exists (select 1 from o) then 'bin' else 'pdf' end)
  from b
$$;

-- linking (or switching the copy back on): every document is looked at once
create or replace function public.kh_mirror_mark_all(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  insert into public.kh_mirror_dirty (document_id) select id from public.kh_documents on conflict (document_id) do nothing;
  get diagnostics n = row_count;
  insert into public.kh_mirror_dirty (document_id) select document_id from public.kh_mirror on conflict (document_id) do nothing;
  insert into public.kh_mirror_dirty (document_id) values ('00000000-0000-0000-0000-000000000000') on conflict (document_id) do nothing;
  return jsonb_build_object('documents', n);
end $$;

-- what to copy, move, rename or remove in the visible folder: only the documents that changed
-- (the ones that need nothing are forgotten here); folders: the shelves changed
create or replace function public.kh_mirror_todo(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare lim int := least(greatest(coalesce((p ->> 'limit')::int, 20), 1), 200); items jsonb; folders boolean;
  nil constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  folders := exists (select 1 from public.kh_mirror_dirty where document_id = nil);
  with dirty as (
    select k.document_id, k.at from public.kh_mirror_dirty k
     where k.document_id <> nil and not (k.document_id = any(public.kh_juuid(p -> 'exclude')))
     order by k.at limit lim * 3),
  want as (
    select d.id, k.at as dirty_at, d.category_id, d.deleted_at is not null as trashed, public.kh_mirror_name(d.id) as name,
           (select f.path from public.kh_files f where f.document_id = d.id and f.role = 'original' limit 1) as orig,
           (select f.mime from public.kh_files f where f.document_id = d.id and f.role = 'original' limit 1) as mime,
           (select jsonb_agg(jsonb_build_object('path', f.path, 'width', f.width, 'height', f.height) order by f.page_no)
              from public.kh_files f where f.document_id = d.id and f.role = 'page') as pages
      from dirty k join public.kh_documents d on d.id = k.document_id
     where d.sensitivity <> 'vault' and d.state in ('ready', 'review')),
  w as (
    select want.*, case when orig is not null then 'o:' || orig when pages is not null then 'p:' || md5(pages::text) end as src
      from want),
  put as (
    select w.id, jsonb_build_object('action', 'put', 'document_id', w.id, 'dirty_at', w.dirty_at, 'category_id', w.category_id,
             'trashed', w.trashed, 'name', w.name, 'src', w.src, 'orig', w.orig, 'mime', w.mime, 'pages', w.pages, 'mirror', to_jsonb(m)) as j
      from w left join public.kh_mirror m on m.document_id = w.id
     where w.src is not null
       and (m.document_id is null or m.category_id is distinct from w.category_id or m.trashed <> w.trashed
            or m.name is distinct from w.name or m.src is distinct from w.src)),
  drop_ as (
    select m.document_id as id, jsonb_build_object('action', 'drop', 'document_id', m.document_id, 'dirty_at', k.at, 'mirror', to_jsonb(m)) as j
      from dirty k join public.kh_mirror m on m.document_id = k.document_id
     where not exists (select 1 from public.kh_documents d where d.id = m.document_id and d.sensitivity <> 'vault')),
  todo as (select id, j from drop_ union all select id, j from put),
  done as (
    delete from public.kh_mirror_dirty x using dirty k
     where x.document_id = k.document_id and x.at <= k.at and not exists (select 1 from todo where todo.id = k.document_id)
    returning 1)
  select coalesce((select jsonb_agg(j) from (select j from todo order by (j ->> 'action') = 'put', j ->> 'dirty_at' limit lim) z), '[]'::jsonb)
    into items;
  return jsonb_build_object('items', items, 'folders', folders);
end $$;

-- the folders are in order again
create or replace function public.kh_mirror_folders_done(p jsonb default '{}') returns jsonb
language sql security definer set search_path = public, extensions as $$
  with x as (delete from public.kh_mirror_dirty where document_id = '00000000-0000-0000-0000-000000000000'
               and at <= coalesce((p ->> 'at')::timestamptz, 'infinity') returning 1)
  select jsonb_build_object('ok', true)
$$;

-- just before a copy is made: is the document still outside the vault?
create or replace function public.kh_mirror_check(p jsonb) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', exists (select 1 from public.kh_documents d where d.id = public.kh_uuid(p ->> 'id') and d.sensitivity <> 'vault'))
$$;

create or replace function public.kh_mirror_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare did uuid := public.kh_uuid(p ->> 'document_id');
begin
  insert into public.kh_mirror (document_id, drive_id, folder, category_id, trashed, name, src, updated_at)
  values (did, p ->> 'drive_id', p ->> 'folder', public.kh_uuid(p ->> 'category_id'),
          coalesce((p ->> 'trashed')::boolean, false), p ->> 'name', p ->> 'src', now())
  on conflict (document_id) do update set drive_id = excluded.drive_id, folder = excluded.folder, category_id = excluded.category_id,
    trashed = excluded.trashed, name = excluded.name, src = excluded.src, updated_at = now();
  delete from public.kh_mirror_dirty where document_id = did and at <= coalesce((p ->> 'dirty_at')::timestamptz, 'infinity');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_mirror_drop(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare did uuid := public.kh_uuid(p ->> 'document_id');
begin
  delete from public.kh_mirror where document_id = did;
  delete from public.kh_mirror_dirty where document_id = did and at <= coalesce((p ->> 'dirty_at')::timestamptz, 'infinity');
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ device-mode adjustments
-- on a device the usage rows are written by the app itself (in the cloud, by the AI function)
create or replace function public.kh_usage_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.kh_ai_usage (op, model, document_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, batch, cost_usd)
  values (coalesce(p ->> 'op', 'other'), coalesce(p ->> 'model', ''), public.kh_uuid(p ->> 'document_id'),
          greatest(coalesce((p ->> 'input_tokens')::int, 0), 0), greatest(coalesce((p ->> 'output_tokens')::int, 0), 0),
          greatest(coalesce((p ->> 'cache_read_tokens')::int, 0), 0), greatest(coalesce((p ->> 'cache_write_tokens')::int, 0), 0),
          coalesce((p ->> 'batch')::boolean, false), greatest(coalesce((p ->> 'cost_usd')::numeric, 0), 0));
  return jsonb_build_object('ok', true);
end $$;

-- documents still to be read / understood. With several devices, one that another device has just
-- added (or is working on) is left to it: only this device's own, or ones left untouched for a while
create or replace function public.kh_pending(p jsonb default '{}') returns jsonb
language sql set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'state', state, 'detail', state_detail, 'title', coalesce(title_ar, title, file_name),
      'needs_ocr', needs_ocr, 'page_count', page_count) order by created_at), '[]'::jsonb)
  from public.kh_documents
  where owner_id = auth.uid() and deleted_at is null and state not in ('ready', 'review')
    and (claimed_at is null or claimed_at < now() - interval '10 minutes')
    and (kh_dev is null or kh_dev = public.kh_sync_dev()
         or kh_v < (extract(epoch from now() - interval '10 minutes') * 1000000)::bigint)
$$;
