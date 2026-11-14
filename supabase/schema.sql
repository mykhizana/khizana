-- =====================================================================================
-- خزانة · Khizana — database (Supabase Postgres, and the same file in the browser via PGlite)
-- Safe to run again at any time: every statement is idempotent.
-- The app never touches tables directly: every request is one kh_* function
-- (one jsonb in, one jsonb out), so the device-only mode and the cloud mode behave the same.
-- =====================================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- ------------------------------------------------------------------ text helpers
-- Arabic + Latin normalisation, identical to src/lib/norm.ts:
-- no diacritics/tatweel, أ إ آ ٱ → ا, ى ی ئ → ي, ة → ه, ؤ → و, ک → ك, Eastern digits → 0-9,
-- é→e …, lower case, anything else → one space.
create or replace function public.kh_norm(t text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(regexp_replace(
    translate(
      regexp_replace(lower(coalesce(t, '')), '[ؐ-ًؚ-ٰٟـۖ-ۭ]', '', 'g'),
      'أإآٱىیئةؤک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ',
      'اااايييهوك01234567890123456789aaaaaaceeeeiiiinooooouuuuyyoa'),
    '[^0-9a-zء-ي]+', ' ', 'g'), '\s+', ' ', 'g'))
$$;

-- light stemmer (same rules as src/lib/norm.ts): الإداري / إدارة / الإدارية → ادار
create or replace function public.kh_stem(w text) returns text
language plpgsql immutable parallel safe as $$
declare s text := w; x text;
begin
  if s is null or length(s) < 4 then return s; end if;
  if s ~ '^[a-z]+$' then
    if length(s) > 4 and right(s, 1) = 's' then return left(s, length(s) - 1); end if;
    return s;
  end if;
  if s !~ '[ء-ي]' then return s; end if;
  foreach x in array array['وال','بال','كال','فال','لل','ال'] loop
    if left(s, length(x)) = x and length(s) - length(x) >= 3 then s := substr(s, length(x) + 1); exit; end if;
  end loop;
  foreach x in array array['ات','ون','ين','ان','ها','هم','هن','كم','نا','يه','ه','ي'] loop
    if right(s, length(x)) = x and length(s) - length(x) >= 3 then s := left(s, length(s) - length(x)); exit; end if;
  end loop;
  return s;
end $$;

-- words + their stems, ready for to_tsvector('simple', …)
create or replace function public.kh_terms(t text) returns text
language sql immutable parallel safe as $$
  with w as (select x from regexp_split_to_table(public.kh_norm(t), ' ') x where x <> '')
  select coalesce(string_agg(x, ' '), '') || ' ' ||
         coalesce((select string_agg(s, ' ') from (select public.kh_stem(x) s, x from w) z where s <> x), '')
  from w
$$;

create or replace function public.kh_stopword(w text) returns boolean
language sql immutable parallel safe as $$
  select w = any (array['في','من','على','عن','الى','الي','مع','او','ثم','التي','الذي','هذا','هذه','ذلك','تلك','كل','بين','عند','لدى','ما','لا','ان','قد','هو','هي',
    'le','la','les','de','des','du','et','en','un','une','pour','par','sur','au','aux','dans','avec','est',
    'el','los','las','del','y','una','por','para','con','al','que','the','of','and','in','on','for','to','a'])
$$;

-- a search phrase → tsquery: every word as a prefix, OR its stem ("and" = all words, "or" = any word)
create or replace function public.kh_tsquery(q text, mode text default 'and') returns tsquery
language plpgsql immutable as $$
declare w text; s text; parts text[] := '{}';
begin
  for w in select distinct x from regexp_split_to_table(public.kh_norm(q), ' ') x
           where x <> '' and (length(x) >= 2) and not public.kh_stopword(x) loop
    s := public.kh_stem(w);
    if s <> w then parts := parts || format('(%s:* | %s:*)', w, s);
    else parts := parts || format('%s:*', w); end if;
  end loop;
  if coalesce(array_length(parts, 1), 0) = 0 then return null; end if;
  return to_tsquery('simple', array_to_string(parts, case when mode = 'or' then ' | ' else ' & ' end));
end $$;

-- words that make a document type findable in four languages
create or replace function public.kh_type_words(t text) returns text
language sql immutable parallel safe as $$
  select case t
    when 'lecture' then 'محاضره درس مقرر cours lecture clase'
    when 'article' then 'مقال دراسه article articulo'
    when 'book' then 'كتاب مؤلف livre libro book ouvrage'
    when 'thesis' then 'اطروحه رساله بحث دكتوراه ماستر these tesis thesis memoire'
    when 'exam' then 'امتحان اختبار examen exam'
    when 'legal_text' then 'نص قانوني قانون ظهير مرسوم قرار loi decret ley texte juridique'
    when 'court_ruling' then 'حكم قرار قضائي محكمه jugement arret sentencia'
    when 'report' then 'تقرير rapport informe report'
    when 'presentation' then 'عرض شرائح presentation diapositives'
    when 'notes' then 'ملاحظات مذكرات notes apuntes'
    when 'diploma' then 'دبلوم شهاده جامعيه اجازه ماستر diplome titulo diploma'
    when 'transcript' then 'كشف نقط نقاط releve notes expediente transcript'
    when 'certificate' then 'شهاده اشهاد attestation certificat certificado certificate'
    when 'id_document' then 'هويه بطاقه جواز سفر اقامه passeport carte identite pasaporte dni nie tie passport'
    when 'civil_record' then 'حاله مدنيه عقد ازدياد ولاده زواج acte naissance mariage partida nacimiento'
    when 'contract' then 'عقد اتفاقيه contrat contrato contract'
    when 'invoice' then 'فاتوره facture factura invoice'
    when 'receipt' then 'وصل ايصال recu recibo receipt'
    when 'statement' then 'كشف بيان حساب releve extracto statement'
    when 'medical' then 'طبي تقرير طبي تحاليل medical medico rapport'
    when 'prescription' then 'وصفه طبيه ordonnance receta prescription'
    when 'letter' then 'رساله مراسله lettre carta letter courrier'
    when 'form' then 'استماره مطبوع formulaire formulario form'
    when 'photo' then 'صوره photo foto'
    else '' end
$$;

create or replace function public.kh_date(t text) returns date
language plpgsql immutable as $$
begin
  if t is null or t !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return t::date;
exception when others then return null;
end $$;

-- «2018/2019» → 2018
create or replace function public.kh_ay_year(t text) returns int
language sql immutable parallel safe as $$
  select nullif(substring(coalesce(t, '') from '(\d{4})'), '')::int
$$;

-- a person's name without titles: «الدكتور محمد بنعلي» / «Pr. M. BENALI» → «محمد بنعلي» / «m benali»
create or replace function public.kh_person_key(t text) returns text
language sql immutable parallel safe as $$
  -- two passes: «الاستاذ الدكتور محمد» loses both titles
  select btrim(regexp_replace(regexp_replace(' ' || replace(public.kh_norm(t), ' ', '  ') || ' ',
    ' (د|دكتور|الدكتور|دكتوره|الدكتوره|ذ|الاستاذ|استاذ|الاستاذه|استاذه|السيد|السيده|الحاج|pr|prof|professeur|professor|dr|docteur|doctor|doctora|mr|mme|mlle|m|sr|sra|don|dona|dra) ',
    ' ', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function public.kh_jtext(j jsonb) returns text[]
language sql immutable parallel safe as $$
  select coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end)), '{}')
$$;

create or replace function public.kh_juuid(j jsonb) returns uuid[]
language sql immutable parallel safe as $$
  select coalesce(array(select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) x
                        where x ~ '^[0-9a-fA-F-]{36}$'), '{}')
$$;

create or replace function public.kh_uuid(t text) returns uuid
language sql immutable parallel safe as $$
  select case when t ~ '^[0-9a-fA-F-]{36}$' then t::uuid end
$$;

-- an id made from what a row means (a link between two documents, a deadline, a box code): the
-- same thing made on two devices is the same row, never two rows fighting over one key
create or replace function public.kh_key_uuid(t text) returns uuid
language sql immutable parallel safe as $$
  select md5(t)::uuid
$$;

-- a request field that should be a list: anything else (missing, null) counts as an empty list
create or replace function public.kh_arr(j jsonb) returns jsonb
language sql immutable parallel safe as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$$;

-- ------------------------------------------------------------------ tables
create table if not exists public.kh_categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  parent_id uuid references public.kh_categories (id) on delete restrict,
  name_ar text not null,
  name_fr text,
  name_es text,
  name_en text,
  description text,
  aliases text[] not null default '{}',
  icon text,
  sort int not null default 0,
  origin text not null default 'owner' check (origin in ('seed', 'owner', 'ai')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kh_categories_owner on public.kh_categories (owner_id, parent_id);

create table if not exists public.kh_locations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  parent_id uuid references public.kh_locations (id) on delete set null,
  code text not null,
  name text not null,
  kind text not null default 'box' check (kind in ('box', 'folder', 'shelf', 'place', 'person', 'with_me', 'other')),
  place text,
  notes text,
  created_at timestamptz not null default now(),
  unique (owner_id, code)
);

create table if not exists public.kh_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  kind text not null default 'upload' check (kind in ('upload', 'scan', 'zip', 'folder', 'share', 'drop', 'email', 'import')),
  location_id uuid references public.kh_locations (id) on delete set null,
  label text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.kh_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  kind text not null default 'category' check (kind in ('category')),
  parent_id uuid references public.kh_categories (id) on delete set null,
  name_ar text not null,
  name_fr text,
  name_es text,
  name_en text,
  reason text,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'remapped')),
  auto boolean not null default false,
  result_category_id uuid references public.kh_categories (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists kh_proposals_open on public.kh_proposals (owner_id) where status = 'open';

create table if not exists public.kh_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  session_id uuid references public.kh_sessions (id) on delete set null,
  state text not null default 'new' check (state in ('new', 'reading', 'understanding', 'checking', 'ready', 'review', 'error', 'waiting')),
  state_detail text,
  source text not null default 'upload',
  file_name text,
  title text,
  title_ar text,
  summary_ar text,
  doc_type text,
  languages text[] not null default '{}',
  category_id uuid references public.kh_categories (id) on delete set null,
  proposal_id uuid references public.kh_proposals (id) on delete set null,
  category_confidence real,
  doc_date date,
  date_precision text,
  academic_year text,
  period_start date,
  period_end date,
  expiry_date date,
  identifiers jsonb not null default '[]',
  status jsonb not null default '{}',
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'private', 'vault')),
  keywords text[] not null default '{}',
  visual_features text,
  ai_reason text,
  ai_confidence real,
  ai_model text,
  ai_mode text,
  needs_ocr boolean not null default false,
  page_count int not null default 0,
  text_chars int not null default 0,
  text_hash text,
  minhash int[],
  original_location_id uuid references public.kh_locations (id) on delete set null,
  original_note text,
  pinned_offline boolean not null default false,
  favorite boolean not null default false,
  tags text[] not null default '{}',
  search tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  deleted_at timestamptz
);
-- columns added after the first version (safe on an existing database)
alter table public.kh_documents add column if not exists claimed_at timestamptz;
alter table public.kh_documents add column if not exists claimed_by text;
create index if not exists kh_documents_owner on public.kh_documents (owner_id, created_at desc);
create index if not exists kh_documents_search on public.kh_documents using gin (search);
create index if not exists kh_documents_category on public.kh_documents (category_id);
create index if not exists kh_documents_proposal on public.kh_documents (proposal_id) where proposal_id is not null;
create index if not exists kh_documents_texthash on public.kh_documents (owner_id, text_hash) where text_hash is not null;
create index if not exists kh_documents_pending on public.kh_documents (owner_id, state) where state not in ('ready', 'review');

create table if not exists public.kh_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  document_id uuid not null references public.kh_documents (id) on delete cascade,
  role text not null check (role in ('original', 'page', 'thumb', 'enhanced', 'export')),
  page_no int,
  path text not null,
  mime text,
  size bigint,
  sha256 text,
  width int,
  height int,
  name text,
  created_at timestamptz not null default now()
);
create index if not exists kh_files_doc on public.kh_files (document_id);
create index if not exists kh_files_sha on public.kh_files (owner_id, sha256) where sha256 is not null;
create index if not exists kh_files_path on public.kh_files (path);

create table if not exists public.kh_pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  document_id uuid not null references public.kh_documents (id) on delete cascade,
  page_no int not null,
  text text not null default '',
  text_source text,
  text_hash text,
  phash bigint,
  blank boolean not null default false,
  legibility text,
  width int,
  height int,
  search tsvector,
  unique (document_id, page_no)
);
create index if not exists kh_pages_search on public.kh_pages using gin (search);
create index if not exists kh_pages_owner_hash on public.kh_pages (owner_id, text_hash) where text_hash is not null;

create table if not exists public.kh_lsh (
  owner_id uuid not null default auth.uid(),
  document_id uuid not null references public.kh_documents (id) on delete cascade,
  band int not null,
  hash bigint not null,
  primary key (document_id, band)
);
create index if not exists kh_lsh_lookup on public.kh_lsh (owner_id, band, hash);

create table if not exists public.kh_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  from_id uuid not null references public.kh_documents (id) on delete cascade,
  to_id uuid not null references public.kh_documents (id) on delete cascade,
  relation text not null check (relation in ('same', 'better_copy', 'version', 'translation', 'part', 'annotated', 'related', 'attachment')),
  method text,
  confidence real,
  reason text,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (from_id, to_id, relation)
);
create index if not exists kh_links_to on public.kh_links (to_id);

create table if not exists public.kh_entities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('person', 'org', 'place')),
  name text not null,
  name_latin text,
  honorific text,
  aliases text[] not null default '{}',
  details jsonb not null default '{}',
  confirmed boolean not null default false,
  merged_into uuid references public.kh_entities (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists kh_entities_owner on public.kh_entities (owner_id, kind) where merged_into is null;

create table if not exists public.kh_doc_entities (
  owner_id uuid not null default auth.uid(),
  document_id uuid not null references public.kh_documents (id) on delete cascade,
  entity_id uuid not null references public.kh_entities (id) on delete cascade,
  role text not null default 'mentioned',
  as_written text,
  primary key (document_id, entity_id, role)
);
create index if not exists kh_doc_entities_entity on public.kh_doc_entities (entity_id);

create table if not exists public.kh_reviews (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('duplicate', 'person_match', 'person_new', 'low_confidence', 'split', 'backfill', 'error')),
  document_id uuid references public.kh_documents (id) on delete cascade,
  payload jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  decision jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists kh_reviews_open on public.kh_reviews (owner_id, kind) where status = 'open';

create table if not exists public.kh_rejections (
  owner_id uuid not null default auth.uid(),
  name_norm text not null,
  parent_id uuid,
  mapped_category_id uuid references public.kh_categories (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, name_norm)
);

create table if not exists public.kh_corrections (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid(),
  document_id uuid references public.kh_documents (id) on delete cascade,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index if not exists kh_corrections_doc on public.kh_corrections (document_id, field);

create table if not exists public.kh_deadlines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  document_id uuid references public.kh_documents (id) on delete cascade,
  kind text not null default 'expiry' check (kind in ('expiry', 'action', 'reminder')),
  due_date date not null,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  unique (document_id, kind, due_date)
);

create table if not exists public.kh_ai_usage (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid(),
  at timestamptz not null default now(),
  op text not null,
  model text not null,
  document_id uuid,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  batch boolean not null default false,
  cost_usd numeric(12, 6) not null default 0
);
create index if not exists kh_ai_usage_month on public.kh_ai_usage (owner_id, at);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'kh_ai_usage_cost_check') then
    alter table public.kh_ai_usage add constraint kh_ai_usage_cost_check check (cost_usd >= 0 and input_tokens >= 0 and output_tokens >= 0);
  end if;
end $c$;

create table if not exists public.kh_ai_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  document_id uuid references public.kh_documents (id) on delete cascade,
  op text not null,
  status text not null default 'queued' check (status in ('queued', 'submitted', 'done', 'error')),
  batch_id text,
  custom_id text,
  request jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kh_ai_jobs_open on public.kh_ai_jobs (owner_id, status) where status in ('queued', 'submitted');

create table if not exists public.kh_settings (
  owner_id uuid not null default auth.uid(),
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

create table if not exists public.kh_audit (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid(),
  at timestamptz not null default now(),
  action text not null,
  document_id uuid,
  details jsonb not null default '{}'
);
create index if not exists kh_audit_owner on public.kh_audit (owner_id, at desc);

-- ready for phase 2 (dossiers, share links)
create table if not exists public.kh_collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  name text not null,
  kind text not null default 'collection' check (kind in ('collection', 'dossier', 'smart')),
  query jsonb,
  notes text,
  created_at timestamptz not null default now()
);
create table if not exists public.kh_collection_docs (
  owner_id uuid not null default auth.uid(),
  collection_id uuid not null references public.kh_collections (id) on delete cascade,
  document_id uuid not null references public.kh_documents (id) on delete cascade,
  position int not null default 0,
  requirement text,
  primary key (collection_id, document_id)
);
create table if not exists public.kh_share_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  token text not null unique,
  collection_id uuid references public.kh_collections (id) on delete cascade,
  document_id uuid references public.kh_documents (id) on delete cascade,
  label text,
  watermark text,
  password_hash text,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  views int not null default 0,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ triggers
-- (kh.applying: on a device, rows arriving from another device keep their own time and search vectors)
create or replace function public.kh_touch() returns trigger language plpgsql as $$
begin
  if current_setting('kh.applying', true) = 'on' then return new; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists kh_touch_documents on public.kh_documents;
create trigger kh_touch_documents before update on public.kh_documents for each row execute function public.kh_touch();
drop trigger if exists kh_touch_categories on public.kh_categories;
create trigger kh_touch_categories before update on public.kh_categories for each row execute function public.kh_touch();

create or replace function public.kh_page_vector() returns trigger language plpgsql
set search_path = public, extensions as $$
begin
  if current_setting('kh.applying', true) = 'on' and new.search is not null
     and (tg_op = 'INSERT' or new.search is distinct from old.search) then return new; end if;
  new.search := to_tsvector('simple', public.kh_terms(left(new.text, 200000)));
  return new;
end $$;
drop trigger if exists kh_page_vector on public.kh_pages;
create trigger kh_page_vector before insert or update of text on public.kh_pages for each row execute function public.kh_page_vector();

-- ------------------------------------------------------------------ security (row level)
-- The vault: a document marked 'vault' (IDs, passports, medical, bank) is visible only in a session
-- verified with the second factor (aal2). Everything that belongs to a document follows its visibility.
-- These helpers are SECURITY DEFINER so they can tell «hidden» from «absent»; each one only ever
-- looks at the caller's own rows.
create or replace function public.kh_doc_visible(did uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.kh_documents d where d.id = did and d.owner_id = auth.uid()
                 and (d.sensitivity <> 'vault' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'))
$$;

-- a person/organisation is visible when it has no document yet or at least one visible document
create or replace function public.kh_entity_visible(eid uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select not exists (select 1 from public.kh_doc_entities de where de.entity_id = eid)
      or exists (select 1 from public.kh_doc_entities de join public.kh_documents d on d.id = de.document_id
                 where de.entity_id = eid and d.owner_id = auth.uid()
                   and (d.sensitivity <> 'vault' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'))
$$;

-- a stored file may be used when no document row claims it yet (a fresh upload, a leftover)
-- or when the document that owns it is visible now
create or replace function public.kh_path_access(p_path text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select not exists (select 1 from public.kh_files f where f.path = p_path)
      or exists (select 1 from public.kh_files f join public.kh_documents d on d.id = f.document_id
                 where f.path = p_path and d.owner_id = auth.uid()
                   and (d.sensitivity <> 'vault' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'))
$$;

-- a file row may only name a path in its owner's folder, for a document of that owner, and a path
-- belongs to ONE document: nobody can «borrow» a vault file through a row of another document
create or replace function public.kh_files_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'UPDATE' and new.path is distinct from old.path then
    raise exception 'a stored file path cannot change';
  end if;
  if split_part(new.path, '/', 1) <> new.owner_id::text or new.path like '%..%' then
    raise exception 'file path outside the owner folder';
  end if;
  if not exists (select 1 from public.kh_documents d where d.id = new.document_id and d.owner_id = new.owner_id) then
    raise exception 'unknown document';
  end if;
  if exists (select 1 from public.kh_files f where f.path = new.path and f.document_id <> new.document_id and f.id <> new.id) then
    raise exception 'this file belongs to another document';
  end if;
  return new;
end $$;
drop trigger if exists kh_files_guard on public.kh_files;
create trigger kh_files_guard before insert or update on public.kh_files for each row execute function public.kh_files_guard();

-- putting a document INTO the vault needs no second factor (it only hides it)
create or replace function public.kh_vault_seal(did uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update public.kh_documents set sensitivity = 'vault' where id = did and owner_id = auth.uid()
$$;

-- the API form (one jsonb in) of kh_vault_seal, for the app
create or replace function public.kh_doc_seal(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $f$
begin
  perform public.kh_vault_seal(public.kh_uuid(p ->> 'id'));
  return jsonb_build_object('ok', true);
end $f$;

do $$
declare t text; vis text;
begin
  foreach t in array array['kh_categories','kh_locations','kh_sessions','kh_proposals','kh_documents','kh_files','kh_pages','kh_lsh',
    'kh_links','kh_entities','kh_doc_entities','kh_reviews','kh_rejections','kh_corrections','kh_deadlines','kh_ai_usage','kh_ai_jobs',
    'kh_settings','kh_audit','kh_collections','kh_collection_docs','kh_share_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_add', t);
    vis := case t
      when 'kh_documents' then $v$(sensitivity <> 'vault' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')$v$
      when 'kh_files' then 'public.kh_doc_visible(document_id)'
      when 'kh_pages' then 'public.kh_doc_visible(document_id)'
      when 'kh_lsh' then 'public.kh_doc_visible(document_id)'
      when 'kh_doc_entities' then 'public.kh_doc_visible(document_id)'
      when 'kh_collection_docs' then 'public.kh_doc_visible(document_id)'
      when 'kh_links' then 'public.kh_doc_visible(from_id) and public.kh_doc_visible(to_id)'
      when 'kh_entities' then 'public.kh_entity_visible(id)'
      when 'kh_reviews' then $v$(document_id is null or public.kh_doc_visible(document_id))
        and (payload ->> 'other_id' is null or public.kh_doc_visible(public.kh_uuid(payload ->> 'other_id')))$v$
      when 'kh_corrections' then '(document_id is null or public.kh_doc_visible(document_id))'
      when 'kh_deadlines' then '(document_id is null or public.kh_doc_visible(document_id))'
      when 'kh_audit' then '(document_id is null or public.kh_doc_visible(document_id))'
      when 'kh_ai_usage' then '(document_id is null or public.kh_doc_visible(document_id))'
      when 'kh_ai_jobs' then '(document_id is null or public.kh_doc_visible(document_id))'
      when 'kh_share_links' then '(document_id is null or public.kh_doc_visible(document_id))'
      else 'true' end;
    if t = 'kh_ai_usage' then
      -- usage is written by the AI function only (and by the device itself, as database owner);
      -- the signed-in user reads it, never writes, edits nor deletes it (the monthly cap counts it)
      execute format('create policy kh_ai_usage_own on public.kh_ai_usage for select to authenticated using (owner_id = auth.uid() and %s)', vis);
      execute 'revoke insert, update, delete on public.kh_ai_usage from authenticated';
      execute 'grant select on public.kh_ai_usage to authenticated';
    else
      execute format('create policy %I on public.%I for all to authenticated using (owner_id = auth.uid() and %s) with check (owner_id = auth.uid()%s)',
        t || '_own', t, vis, case when t in ('kh_files', 'kh_pages') then ' and public.kh_doc_visible(document_id)' else '' end);
      execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    end if;
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- documents files live in a private bucket: <owner>/<document>/<file>
insert into storage.buckets (id, name, public) values ('kh-files', 'kh-files', false) on conflict (id) do nothing;
-- read / replace / delete a stored file: only in your folder, and only when its document is visible
-- (a vault file stays out of reach without the second factor)
drop policy if exists kh_files_read on storage.objects;
create policy kh_files_read on storage.objects for select to authenticated using (
  bucket_id = 'kh-files' and (storage.foldername(name))[1] = auth.uid()::text and public.kh_path_access(name));
drop policy if exists kh_files_write on storage.objects;
create policy kh_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'kh-files' and (storage.foldername(name))[1] = auth.uid()::text and public.kh_path_access(name));
drop policy if exists kh_files_update on storage.objects;
create policy kh_files_update on storage.objects for update to authenticated using (
  bucket_id = 'kh-files' and (storage.foldername(name))[1] = auth.uid()::text and public.kh_path_access(name));
drop policy if exists kh_files_delete on storage.objects;
create policy kh_files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'kh-files' and (storage.foldername(name))[1] = auth.uid()::text and public.kh_path_access(name));

-- ------------------------------------------------------------------ internal helpers
create or replace function public.kh_setting(k text, fallback jsonb default null) returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce((select value from public.kh_settings where owner_id = auth.uid() and key = k), fallback)
$$;

-- full path of a category, root first: [{id, name_ar}, …]
create or replace function public.kh_category_path(cid uuid) returns jsonb
language sql stable set search_path = public, extensions as $$
  with recursive up as (
    select c.id, c.parent_id, c.name_ar, 0 as depth from public.kh_categories c where c.id = cid
    union all
    select c.id, c.parent_id, c.name_ar, up.depth + 1 from public.kh_categories c join up on c.id = up.parent_id where up.depth < 12)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name_ar) order by depth desc), '[]'::jsonb) from up
$$;

create or replace function public.kh_category_tree_ids(roots uuid[]) returns uuid[]
language sql stable set search_path = public, extensions as $$
  with recursive t as (
    select id from public.kh_categories where id = any(roots)
    union
    select c.id from public.kh_categories c join t on c.parent_id = t.id)
  select coalesce(array_agg(id), '{}') from t
$$;

-- recompute the document's search vector (title A · names/keywords B · summary C · text D)
-- SECURITY DEFINER so vault documents stay searchable after a restore or a rename made without the
-- second factor; it only reads and writes the caller's own document.
create or replace function public.kh_reindex(did uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d public.kh_documents; names text; cats text; body text; ids text;
begin
  select * into d from public.kh_documents where id = did and owner_id = auth.uid();
  if not found then return; end if;
  select string_agg(coalesce(e.name, '') || ' ' || coalesce(e.name_latin, '') || ' ' || array_to_string(e.aliases, ' '), ' ')
    into names from public.kh_doc_entities de join public.kh_entities e on e.id = de.entity_id where de.document_id = did;
  select string_agg(coalesce(c.name_ar, '') || ' ' || coalesce(c.name_fr, '') || ' ' || coalesce(c.name_es, '') || ' ' || coalesce(c.name_en, ''), ' ')
    into cats from public.kh_categories c where c.id = any(public.kh_category_ancestors(d.category_id));
  select left(string_agg(text, ' ' order by page_no), 20000) into body from public.kh_pages where document_id = did;
  select string_agg(coalesce(x ->> 'value', ''), ' ') into ids from jsonb_array_elements(coalesce(d.identifiers, '[]')) x;
  update public.kh_documents set search =
      setweight(to_tsvector('simple', public.kh_terms(concat_ws(' ', d.title, d.title_ar, regexp_replace(coalesce(d.file_name, ''), '\.[A-Za-z0-9]{1,5}$', '')))), 'A')
   || setweight(to_tsvector('simple', public.kh_terms(concat_ws(' ', array_to_string(d.keywords, ' '), names, ids, array_to_string(d.tags, ' ')))), 'B')
   || setweight(to_tsvector('simple', public.kh_terms(concat_ws(' ', d.summary_ar, d.visual_features, d.academic_year, cats, public.kh_type_words(d.doc_type), d.original_note))), 'C')
   || setweight(to_tsvector('simple', public.kh_terms(body)), 'D')
  where id = did and owner_id = auth.uid();
end $$;

create or replace function public.kh_category_ancestors(cid uuid) returns uuid[]
language sql stable set search_path = public, extensions as $$
  with recursive up as (
    select c.id, c.parent_id, 0 as depth from public.kh_categories c where c.id = cid
    union all
    select c.id, c.parent_id, up.depth + 1 from public.kh_categories c join up on c.id = up.parent_id where up.depth < 12)
  select coalesce(array_agg(id), '{}') from up
$$;

create or replace function public.kh_new_code() returns text
language plpgsql volatile set search_path = public, extensions as $$
declare alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; c text; i int;
begin
  loop
    c := '';
    for i in 1..5 loop c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.kh_locations where owner_id = auth.uid() and code = c);
  end loop;
  return c;
end $$;

-- ------------------------------------------------------------------ API: start-up
create or replace function public.kh_bootstrap(p jsonb default '{}') returns jsonb
language plpgsql set search_path = public, extensions as $$
declare r jsonb; parent uuid;
begin
  if not exists (select 1 from public.kh_categories where owner_id = auth.uid()) then
    insert into public.kh_categories (name_ar, name_fr, name_es, name_en, icon, sort, origin) values
      ('الدراسة والبحث العلمي', 'Études et recherche', 'Estudios e investigación', 'Studies & research', 'graduation-cap', 1, 'seed'),
      ('الهوية والحالة المدنية', 'Identité et état civil', 'Identidad y registro civil', 'Identity & civil status', 'id-card', 2, 'seed'),
      ('الإقامة والهجرة والسفر', 'Séjour, immigration et voyages', 'Residencia, inmigración y viajes', 'Residence, immigration & travel', 'plane', 3, 'seed'),
      ('الشهادات والدبلومات', 'Diplômes et attestations', 'Títulos y certificados', 'Diplomas & certificates', 'award', 4, 'seed'),
      ('الصحة', 'Santé', 'Salud', 'Health', 'heart-pulse', 5, 'seed'),
      ('العمل والمهنة', 'Travail et carrière', 'Trabajo y carrera', 'Work & career', 'briefcase', 6, 'seed'),
      ('المال والبنوك والضرائب', 'Finances, banques et impôts', 'Finanzas, bancos e impuestos', 'Money, banks & taxes', 'landmark', 7, 'seed'),
      ('السكن والعقار', 'Logement et immobilier', 'Vivienda e inmuebles', 'Housing & property', 'home', 8, 'seed'),
      ('المراسلات الإدارية', 'Correspondance administrative', 'Correspondencia administrativa', 'Administrative letters', 'mail', 9, 'seed'),
      ('العائلة', 'Famille', 'Familia', 'Family', 'users', 10, 'seed');
    update public.kh_categories set aliases = array[public.kh_norm(name_ar), public.kh_norm(name_fr), public.kh_norm(name_es), public.kh_norm(name_en)]
      where owner_id = auth.uid() and origin = 'seed';
  end if;
  insert into public.kh_settings (key, value) values
    ('autonomy', '"ask"'), ('monthly_cap_usd', '60'), ('alert_ratio', '0.8'), ('economy', 'false'), ('ai_model', '"claude-opus-5-5"')
  on conflict do nothing;
  select jsonb_object_agg(key, value) into r from public.kh_settings where owner_id = auth.uid();
  return jsonb_build_object('settings', r, 'owner', auth.uid());
end $$;

-- ------------------------------------------------------------------ API: settings & usage
create or replace function public.kh_settings_get(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.kh_settings where owner_id = auth.uid()
$$;

create or replace function public.kh_setting_set(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  if coalesce(p ->> 'key', '') !~ '^[a-z_]{2,40}$' then raise exception 'bad setting key'; end if;
  insert into public.kh_settings (key, value) values (p ->> 'key', coalesce(p -> 'value', 'null'))
  on conflict (owner_id, key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- device-only mode writes its own usage rows (in the cloud the AI function does it)
create or replace function public.kh_usage_add(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  insert into public.kh_ai_usage (op, model, document_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, batch, cost_usd)
  values (coalesce(p ->> 'op', 'other'), coalesce(p ->> 'model', ''), public.kh_uuid(p ->> 'document_id'),
          coalesce((p ->> 'input_tokens')::int, 0), coalesce((p ->> 'output_tokens')::int, 0),
          coalesce((p ->> 'cache_read_tokens')::int, 0), coalesce((p ->> 'cache_write_tokens')::int, 0),
          coalesce((p ->> 'batch')::boolean, false), coalesce((p ->> 'cost_usd')::numeric, 0));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_usage_summary(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  with m as (select * from public.kh_ai_usage where owner_id = auth.uid() and at >= date_trunc('month', now()))
  select jsonb_build_object(
    'month_cost', coalesce((select sum(cost_usd) from m), 0),
    'month_calls', (select count(*) from m),
    'total_cost', coalesce((select sum(cost_usd) from public.kh_ai_usage where owner_id = auth.uid()), 0),
    'by_op', coalesce((select jsonb_object_agg(op, c) from (select op, round(sum(cost_usd), 4) c from m group by op) z), '{}'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'cost', c) order by d) from (select at::date d, round(sum(cost_usd), 4) c from m group by 1) z), '[]'::jsonb),
    'tokens', jsonb_build_object('input', coalesce((select sum(input_tokens) from m), 0), 'output', coalesce((select sum(output_tokens) from m), 0)),
    'cap', public.kh_setting('monthly_cap_usd', '60'),
    'alert_ratio', public.kh_setting('alert_ratio', '0.8'))
$$;

create or replace function public.kh_audit_add(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  insert into public.kh_audit (action, document_id, details)
  values (coalesce(p ->> 'action', 'other'), public.kh_uuid(p ->> 'document_id'), coalesce(p -> 'details', '{}'));
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ API: places of the paper originals
create or replace function public.kh_locations_list(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('doc_count',
      (select count(*) from public.kh_documents d where d.original_location_id = l.id and d.deleted_at is null)) order by l.created_at), '[]'::jsonb)
  from public.kh_locations l where l.owner_id = auth.uid()
$$;

create or replace function public.kh_location_save(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare lid uuid := public.kh_uuid(p ->> 'id'); r public.kh_locations;
begin
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'name required'; end if;
  if lid is null then
    insert into public.kh_locations (id, code, name, kind, place, notes, parent_id)
    select public.kh_key_uuid('location|' || auth.uid() || '|' || c), c, btrim(p ->> 'name'), coalesce(p ->> 'kind', 'box'),
           nullif(btrim(p ->> 'place'), ''), nullif(btrim(p ->> 'notes'), ''), public.kh_uuid(p ->> 'parent_id')
    from (select coalesce(nullif(upper(btrim(p ->> 'code')), ''), public.kh_new_code()) as c) z
    returning * into r;
  else
    update public.kh_locations set name = btrim(p ->> 'name'), kind = coalesce(p ->> 'kind', kind), place = nullif(btrim(p ->> 'place'), ''),
      notes = nullif(btrim(p ->> 'notes'), ''), parent_id = public.kh_uuid(p ->> 'parent_id')
    where id = lid returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.kh_location_delete(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  delete from public.kh_locations where id = public.kh_uuid(p ->> 'id');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_location_by_code(p jsonb) returns jsonb
language sql stable set search_path = public, extensions as $$
  select to_jsonb(l) from public.kh_locations l where l.owner_id = auth.uid() and l.code = upper(btrim(p ->> 'code'))
$$;

create or replace function public.kh_session_start(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare sid uuid;
begin
  insert into public.kh_sessions (kind, location_id, label)
  values (coalesce(p ->> 'kind', 'upload'), public.kh_uuid(p ->> 'location_id'), nullif(p ->> 'label', ''))
  returning id into sid;
  return jsonb_build_object('id', sid);
end $$;

create or replace function public.kh_session_end(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  update public.kh_sessions set ended_at = now() where id = public.kh_uuid(p ->> 'id');
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ API: documents
-- before uploading: which of these files (by SHA-256) are already in the archive?
create or replace function public.kh_sha_lookup(p jsonb) returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('sha256', f.sha256, 'document_id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name),
      'created_at', d.created_at, 'deleted', d.deleted_at is not null, 'category_path', public.kh_category_path(d.category_id))), '[]'::jsonb)
  from public.kh_files f join public.kh_documents d on d.id = f.document_id
  where f.owner_id = auth.uid() and f.role = 'original' and f.sha256 = any(public.kh_jtext(p -> 'sha256s'))
$$;

create or replace function public.kh_doc_create(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare did uuid := coalesce(public.kh_uuid(p ->> 'id'), gen_random_uuid()); x jsonb; i int := 0;
begin
  insert into public.kh_documents (id, session_id, source, file_name, title, needs_ocr, page_count, text_chars, text_hash, minhash,
                                   original_location_id, sensitivity, state, state_detail, original_note)
  values (did, public.kh_uuid(p ->> 'session_id'), coalesce(p ->> 'source', 'upload'), p ->> 'file_name',
          nullif(p ->> 'title', ''), coalesce((p ->> 'needs_ocr')::boolean, false), coalesce((p ->> 'page_count')::int, 0),
          coalesce((p ->> 'text_chars')::int, 0), nullif(p ->> 'text_hash', ''),
          case when jsonb_typeof(p -> 'minhash') = 'array' then array(select (v)::int from jsonb_array_elements_text(p -> 'minhash') v) end,
          coalesce(public.kh_uuid(p ->> 'original_location_id'),
                   (select s.location_id from public.kh_sessions s where s.id = public.kh_uuid(p ->> 'session_id'))),
          -- a new document is never created inside the vault (it is sealed at the end of its processing)
          case when p ->> 'sensitivity' in ('normal', 'private') then p ->> 'sensitivity' else 'normal' end,
          coalesce(nullif(p ->> 'state', ''), 'new'), nullif(p ->> 'state_detail', ''), nullif(p ->> 'original_note', ''));
  for x in select * from jsonb_array_elements(public.kh_arr(p -> 'files')) loop
    insert into public.kh_files (id, document_id, role, page_no, path, mime, size, sha256, width, height, name)
    values (coalesce(public.kh_uuid(x ->> 'id'), gen_random_uuid()), did, x ->> 'role', (x ->> 'page_no')::int, x ->> 'path', x ->> 'mime',
            (x ->> 'size')::bigint, nullif(x ->> 'sha256', ''), (x ->> 'width')::int, (x ->> 'height')::int, x ->> 'name');
  end loop;
  for x in select * from jsonb_array_elements(public.kh_arr(p -> 'pages')) loop
    i := i + 1;
    insert into public.kh_pages (document_id, page_no, text, text_source, text_hash, phash, blank, width, height)
    values (did, coalesce((x ->> 'page_no')::int, i), coalesce(x ->> 'text', ''), x ->> 'text_source', nullif(x ->> 'text_hash', ''),
            nullif(x ->> 'phash', '')::bigint, coalesce((x ->> 'blank')::boolean, false), (x ->> 'width')::int, (x ->> 'height')::int);
  end loop;
  insert into public.kh_lsh (document_id, band, hash)
  select did, (b.ord - 1)::int, (b.v)::bigint from jsonb_array_elements_text(public.kh_arr(p -> 'lsh')) with ordinality as b(v, ord);
  perform public.kh_reindex(did);
  return jsonb_build_object('id', did);
end $$;

drop function if exists public.kh_files_add(jsonb);

-- after reading (OCR): page texts + the text fingerprints of the whole document
create or replace function public.kh_doc_set_text(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare did uuid := public.kh_uuid(p ->> 'id'); x jsonb;
begin
  for x in select * from jsonb_array_elements(public.kh_arr(p -> 'pages')) loop
    insert into public.kh_pages (document_id, page_no, text, text_source, text_hash, blank, legibility)
    values (did, (x ->> 'page_no')::int, coalesce(x ->> 'text', ''), x ->> 'text_source', nullif(x ->> 'text_hash', ''),
            coalesce((x ->> 'blank')::boolean, false), x ->> 'legibility')
    on conflict (document_id, page_no) do update set text = excluded.text, text_source = excluded.text_source,
      text_hash = excluded.text_hash, blank = excluded.blank or public.kh_pages.blank, legibility = excluded.legibility;
  end loop;
  update public.kh_documents set
    text_hash = coalesce(nullif(p ->> 'text_hash', ''), text_hash),
    text_chars = coalesce((p ->> 'text_chars')::int, text_chars),
    minhash = case when jsonb_typeof(p -> 'minhash') = 'array' then array(select (v)::int from jsonb_array_elements_text(p -> 'minhash') v) else minhash end,
    needs_ocr = coalesce((p ->> 'needs_ocr')::boolean, needs_ocr)
  where id = did;
  if jsonb_typeof(p -> 'lsh') = 'array' then
    delete from public.kh_lsh where document_id = did;
    insert into public.kh_lsh (document_id, band, hash)
    select did, (b.ord - 1)::int, (b.v)::bigint from jsonb_array_elements_text(p -> 'lsh') with ordinality as b(v, ord);
  end if;
  perform public.kh_reindex(did);
  return jsonb_build_object('ok', true);
end $$;

-- the end of processing: ready and, when it belongs there, into the vault — in one step, so the
-- document is never seen anywhere as «ready» outside the vault. SECURITY DEFINER: it works without the
-- second factor (it only finishes the caller's own document, and sealing only hides it).
create or replace function public.kh_doc_finish(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.kh_documents set state = 'ready', state_detail = null, claimed_at = null, claimed_by = null,
    sensitivity = case when coalesce((p ->> 'seal')::boolean, false) then 'vault' else sensitivity end
  where id = public.kh_uuid(p ->> 'id') and owner_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- a state change; while a document is being worked on it also renews the worker's claim on it,
-- any other state releases the claim
create or replace function public.kh_doc_state(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  update public.kh_documents set state = p ->> 'state', state_detail = p ->> 'detail',
    claimed_at = case when p ->> 'state' in ('reading', 'understanding', 'checking') then now() end,
    claimed_by = case when p ->> 'state' in ('reading', 'understanding', 'checking') then claimed_by end
  where id = public.kh_uuid(p ->> 'id');
  return jsonb_build_object('ok', true);
end $$;

-- documents still to be read / understood (resumed when the app opens again);
-- one being worked on elsewhere (another tab, another device) is skipped while its claim is fresh
create or replace function public.kh_pending(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'state', state, 'detail', state_detail, 'title', coalesce(title_ar, title, file_name),
      'needs_ocr', needs_ocr, 'page_count', page_count) order by created_at), '[]'::jsonb)
  from public.kh_documents
  where owner_id = auth.uid() and deleted_at is null and state not in ('ready', 'review')
    and (claimed_at is null or claimed_at < now() - interval '10 minutes')
$$;

-- take a document for processing; false when another worker holds a fresh claim on it
create or replace function public.kh_claim(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare did uuid;
begin
  update public.kh_documents set claimed_at = now(), claimed_by = p ->> 'worker'
  where id = public.kh_uuid(p ->> 'id') and deleted_at is null and state not in ('ready', 'review')
    and (claimed_at is null or claimed_at < now() - interval '10 minutes' or claimed_by = p ->> 'worker')
  returning id into did;
  return jsonb_build_object('ok', did is not null);
end $$;

-- the owner edits a document: every changed field is remembered (the AI will not overwrite it again)
create or replace function public.kh_doc_update(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare did uuid := public.kh_uuid(p ->> 'id'); f jsonb := coalesce(p -> 'fields', '{}'); d public.kh_documents; k text;
        by_owner boolean := coalesce((p ->> 'by_owner')::boolean, true);
begin
  select * into d from public.kh_documents where id = did;
  if not found then raise exception 'document not found'; end if;
  if by_owner then
    for k in select x from jsonb_object_keys(f) x
             where x in ('title', 'title_ar', 'summary_ar', 'doc_type', 'category_id', 'doc_date', 'academic_year', 'expiry_date',
                         'sensitivity', 'languages', 'status') loop
      if (to_jsonb(d) -> k) is distinct from (f -> k) then
        insert into public.kh_corrections (document_id, field, old_value, new_value) values (did, k, to_jsonb(d) -> k, f -> k);
      end if;
    end loop;
  end if;
  update public.kh_documents set
    title = case when f ? 'title' then nullif(f ->> 'title', '') else title end,
    title_ar = case when f ? 'title_ar' then nullif(f ->> 'title_ar', '') else title_ar end,
    summary_ar = case when f ? 'summary_ar' then f ->> 'summary_ar' else summary_ar end,
    doc_type = case when f ? 'doc_type' then nullif(f ->> 'doc_type', '') else doc_type end,
    category_id = case when f ? 'category_id' then public.kh_uuid(f ->> 'category_id') else category_id end,
    proposal_id = case when f ? 'category_id' then null else proposal_id end,
    doc_date = case when f ? 'doc_date' then public.kh_date(f ->> 'doc_date') else doc_date end,
    date_precision = case when f ? 'date_precision' then f ->> 'date_precision' else date_precision end,
    academic_year = case when f ? 'academic_year' then nullif(f ->> 'academic_year', '') else academic_year end,
    expiry_date = case when f ? 'expiry_date' then public.kh_date(f ->> 'expiry_date') else expiry_date end,
    -- «into the vault» is applied last by kh_vault_seal (a session without the second factor may do it too)
    sensitivity = case when f ? 'sensitivity' then
                    case when f ->> 'sensitivity' in ('normal', 'private') then f ->> 'sensitivity'
                         when f ->> 'sensitivity' = 'vault' then case when sensitivity = 'vault' then 'vault' else 'private' end
                         else 'normal' end
                  else sensitivity end,
    original_location_id = case when f ? 'original_location_id' then public.kh_uuid(f ->> 'original_location_id') else original_location_id end,
    original_note = case when f ? 'original_note' then nullif(f ->> 'original_note', '') else original_note end,
    favorite = case when f ? 'favorite' then coalesce((f ->> 'favorite')::boolean, false) else favorite end,
    pinned_offline = case when f ? 'pinned_offline' then coalesce((f ->> 'pinned_offline')::boolean, false) else pinned_offline end,
    tags = case when f ? 'tags' then public.kh_jtext(f -> 'tags') else tags end,
    languages = case when f ? 'languages' then public.kh_jtext(f -> 'languages') else languages end,
    status = case when f ? 'status' then coalesce(f -> 'status', '{}') else status end,
    source = case when f ? 'source' then coalesce(nullif(f ->> 'source', ''), source) else source end,
    state = case when f ? 'state' then f ->> 'state' else state end
  where id = did;
  if f ? 'expiry_date' and public.kh_date(f ->> 'expiry_date') is not null then
    insert into public.kh_deadlines (id, document_id, kind, due_date, title)
    values (public.kh_key_uuid('deadline|' || did || '|expiry|' || public.kh_date(f ->> 'expiry_date')), did, 'expiry', public.kh_date(f ->> 'expiry_date'),
            coalesce(d.title_ar, d.title, d.file_name, 'وثيقة') || ' — تنتهي صلاحيتها')
    on conflict do nothing;
  end if;
  perform public.kh_reindex(did);
  if f ->> 'sensitivity' = 'vault' then perform public.kh_vault_seal(did); end if;
  return jsonb_build_object('ok', true, 'sealed', f ->> 'sensitivity' = 'vault');
end $$;

create or replace function public.kh_doc_delete(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare ids uuid[] := public.kh_juuid(p -> 'ids');
begin
  if public.kh_uuid(p ->> 'id') is not null then ids := ids || public.kh_uuid(p ->> 'id'); end if;
  update public.kh_documents set deleted_at = now() where id = any(ids) and deleted_at is null;
  insert into public.kh_audit (action, document_id) select 'delete', x from unnest(ids) x;
  return jsonb_build_object('ok', true, 'count', coalesce(array_length(ids, 1), 0));
end $$;

create or replace function public.kh_doc_restore(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  update public.kh_documents set deleted_at = null where id = public.kh_uuid(p ->> 'id');
  insert into public.kh_audit (action, document_id) values ('restore', public.kh_uuid(p ->> 'id'));
  return jsonb_build_object('ok', true);
end $$;

-- definitive removal: returns the storage paths so the caller removes the files too
create or replace function public.kh_doc_purge(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare ids uuid[] := public.kh_juuid(p -> 'ids'); paths jsonb;
begin
  if public.kh_uuid(p ->> 'id') is not null then ids := ids || public.kh_uuid(p ->> 'id'); end if;
  if coalesce((p ->> 'trash_older_than_days')::int, 0) > 0 then
    ids := ids || array(select id from public.kh_documents where owner_id = auth.uid() and deleted_at < now() - make_interval(days => (p ->> 'trash_older_than_days')::int));
  end if;
  select coalesce(jsonb_agg(path), '[]'::jsonb) into paths from public.kh_files where document_id = any(ids);
  delete from public.kh_documents where id = any(ids);
  return jsonb_build_object('ok', true, 'paths', paths, 'count', coalesce(array_length(ids, 1), 0));
end $$;

create or replace function public.kh_doc_get(p jsonb) returns jsonb
language sql stable set search_path = public, extensions as $$
  select to_jsonb(d) - 'search' - 'minhash' || jsonb_build_object(
    'category_path', public.kh_category_path(d.category_id),
    'proposal', (select to_jsonb(pr) from public.kh_proposals pr where pr.id = d.proposal_id and pr.status = 'open'),
    'location', (select to_jsonb(l) from public.kh_locations l where l.id = d.original_location_id),
    'files', coalesce((select jsonb_agg(to_jsonb(f) order by f.role, f.page_no nulls first) from public.kh_files f where f.document_id = d.id), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(jsonb_build_object('page_no', pg.page_no, 'text', left(pg.text, 60000), 'blank', pg.blank,
                'legibility', pg.legibility, 'text_source', pg.text_source, 'width', pg.width, 'height', pg.height) order by pg.page_no)
              from public.kh_pages pg where pg.document_id = d.id), '[]'::jsonb),
    'entities', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'name', e.name, 'name_latin', e.name_latin,
                'honorific', e.honorific, 'role', de.role, 'as_written', de.as_written, 'confirmed', e.confirmed) order by e.kind, e.name)
              from public.kh_doc_entities de join public.kh_entities e on e.id = de.entity_id where de.document_id = d.id), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'relation', k.relation, 'method', k.method, 'confidence', k.confidence,
                'reason', k.reason, 'confirmed', k.confirmed, 'direction', case when k.from_id = d.id then 'out' else 'in' end,
                'other_id', o.id, 'other_title', coalesce(o.title_ar, o.title, o.file_name), 'other_deleted', o.deleted_at is not null))
              from public.kh_links k join public.kh_documents o on o.id = case when k.from_id = d.id then k.to_id else k.from_id end
              where k.from_id = d.id or k.to_id = d.id), '[]'::jsonb),
    'deadlines', coalesce((select jsonb_agg(to_jsonb(x) order by x.due_date) from public.kh_deadlines x where x.document_id = d.id), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from public.kh_reviews r where r.document_id = d.id and r.status = 'open'), '[]'::jsonb),
    'corrected', coalesce((select jsonb_agg(distinct c.field) from public.kh_corrections c where c.document_id = d.id), '[]'::jsonb))
  from public.kh_documents d where d.id = public.kh_uuid(p ->> 'id')
$$;

-- a scanned stack → separate documents: [{first_page, last_page, title_ar}] (pages and their files move)
create or replace function public.kh_doc_split(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
  src public.kh_documents; seg jsonb; nid uuid; ids uuid[] := '{}'; a int; b int; removed jsonb := '[]';
begin
  select * into src from public.kh_documents where id = public.kh_uuid(p ->> 'id');
  if not found then raise exception 'document not found'; end if;
  for seg in select * from jsonb_array_elements(public.kh_arr(p -> 'segments')) loop
    a := (seg ->> 'first_page')::int; b := (seg ->> 'last_page')::int;
    if a is null or b is null or b < a then continue; end if;
    if not exists (select 1 from public.kh_pages where document_id = src.id and page_no between a and b) then continue; end if;
    insert into public.kh_documents (session_id, source, file_name, title_ar, needs_ocr, page_count, original_location_id, state, sensitivity)
    values (src.session_id, case when src.source = 'stack' then 'scan' else src.source end,
            coalesce(nullif(seg ->> 'title_ar', ''), src.file_name), nullif(seg ->> 'title_ar', ''), false,
            (select count(*) from public.kh_pages where document_id = src.id and page_no between a and b),
            src.original_location_id, 'new', case when src.sensitivity = 'private' then 'private' else 'normal' end)
    returning id into nid;
    update public.kh_files set document_id = nid, page_no = page_no - a + 1 where document_id = src.id and role = 'page' and page_no between a and b;
    update public.kh_pages set document_id = nid, page_no = page_no - a + 1 where document_id = src.id and page_no between a and b;
    -- the first page image doubles as the thumbnail
    insert into public.kh_files (document_id, role, page_no, path, mime, size, width, height, name)
    select nid, 'thumb', null, f.path, f.mime, f.size, f.width, f.height, f.name from public.kh_files f
    where f.document_id = nid and f.role = 'page' and f.page_no = 1 limit 1;
    ids := ids || nid;
  end loop;
  if not exists (select 1 from public.kh_pages where document_id = src.id) then
    -- what the emptied stack still owned (its own thumbnail): returned so the stored bytes go too
    select coalesce(jsonb_agg(f.path), '[]'::jsonb) into removed from public.kh_files f
     where f.document_id = src.id and not exists (select 1 from public.kh_files g where g.path = f.path and g.document_id <> src.id);
    delete from public.kh_files where document_id = src.id;
    delete from public.kh_documents where id = src.id;
  else
    update public.kh_documents set page_count = (select count(*) from public.kh_pages where document_id = src.id),
      state = 'new', state_detail = null where id = src.id;
  end if;
  return jsonb_build_object('ids', to_jsonb(ids), 'removed_paths', removed);
end $$;

-- ------------------------------------------------------------------ API: duplicates (layers 1-6)
-- candidates for one document, with every signal; the app decides (and asks the owner when unsure)
create or replace function public.kh_dup_candidates(p jsonb) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare me public.kh_documents; r jsonb;
begin
  select * into me from public.kh_documents where id = public.kh_uuid(p ->> 'id');
  if not found then return '[]'::jsonb; end if;
  with
  l1 as (select distinct f2.document_id as other from public.kh_files f1
           join public.kh_files f2 on f2.sha256 = f1.sha256 and f2.document_id <> f1.document_id and f2.role = 'original' and f2.owner_id = me.owner_id
         where f1.document_id = me.id and f1.role = 'original' and f1.sha256 is not null),
  l2 as (select d.id as other from public.kh_documents d
         where me.text_hash is not null and me.text_chars >= 40 and d.text_hash = me.text_hash and d.id <> me.id and d.owner_id = me.owner_id),
  l3 as (select pb.document_id as other, count(distinct pa.page_no) as n
         from public.kh_pages pa join public.kh_pages pb
           on pb.owner_id = me.owner_id and pb.document_id <> pa.document_id and pb.phash is not null and not pb.blank
          and pb.phash not in (0, -1) and bit_count((pa.phash # pb.phash)::bit(64)) <= 10
         where pa.document_id = me.id and pa.phash is not null and not pa.blank and pa.phash not in (0, -1) and pa.page_no <= 80
         group by pb.document_id),
  l5 as (select pb.document_id as other, count(distinct pa.page_no) as n
         from public.kh_pages pa join public.kh_pages pb
           on pb.owner_id = me.owner_id and pb.text_hash = pa.text_hash and pb.document_id <> pa.document_id
         where pa.document_id = me.id and pa.text_hash is not null and length(pa.text) >= 40
         group by pb.document_id),
  l4 as (select x.other,
                (select count(*) from generate_subscripts(me.minhash, 1) i where me.minhash[i] = d.minhash[i])::real
                  / greatest(array_length(me.minhash, 1), 1) as sim
         from (select distinct b.document_id as other from public.kh_lsh a
                 join public.kh_lsh b on b.owner_id = me.owner_id and b.band = a.band and b.hash = a.hash and b.document_id <> a.document_id
               where a.document_id = me.id) x
         join public.kh_documents d on d.id = x.other
         where me.minhash is not null and d.minhash is not null and array_length(d.minhash, 1) = array_length(me.minhash, 1)),
  l6 as (select d.id as other, count(*) as n
         from public.kh_documents d,
              jsonb_array_elements(coalesce(me.identifiers, '[]')) a,
              jsonb_array_elements(coalesce(d.identifiers, '[]')) b
         where d.owner_id = me.owner_id and d.id <> me.id and d.deleted_at is null
           and a ->> 'kind' = b ->> 'kind'
           and a ->> 'kind' in ('passport_no', 'id_no', 'residence_no', 'certificate_no', 'case_no', 'invoice_no', 'student_no', 'isbn', 'reference', 'account_no')
           and length(regexp_replace(public.kh_norm(a ->> 'value'), ' ', '', 'g')) >= 4
           and regexp_replace(public.kh_norm(a ->> 'value'), ' ', '', 'g') = regexp_replace(public.kh_norm(b ->> 'value'), ' ', '', 'g')
         group by d.id),
  ids as (select other from l1 union select other from l2 union select other from l3 union select other from l4 where sim >= 0.45
          union select other from l5 union select other from l6)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name), 'file_name', d.file_name, 'doc_type', d.doc_type,
      'languages', d.languages, 'page_count', d.page_count, 'text_chars', d.text_chars, 'deleted', d.deleted_at is not null,
      'created_at', d.created_at, 'needs_ocr', d.needs_ocr, 'summary_ar', d.summary_ar,
      'sha256', exists (select 1 from l1 where l1.other = d.id),
      'text_equal', exists (select 1 from l2 where l2.other = d.id),
      'visual_pages', coalesce((select n from l3 where l3.other = d.id), 0),
      'text_pages', coalesce((select n from l5 where l5.other = d.id), 0),
      'minhash', (select sim from l4 where l4.other = d.id),
      'identity', coalesce((select n from l6 where l6.other = d.id), 0),
      'pixels', (select max(coalesce(f.width, 0) * coalesce(f.height, 0)) from public.kh_files f where f.document_id = d.id and f.role in ('page', 'original')),
      'size', (select sum(f.size) from public.kh_files f where f.document_id = d.id and f.role = 'original'),
      'linked', exists (select 1 from public.kh_links k where (k.from_id = me.id and k.to_id = d.id) or (k.from_id = d.id and k.to_id = me.id)))), '[]'::jsonb)
  into r
  from ids join public.kh_documents d on d.id = ids.other;
  return r;
end $$;

-- «صوّر لتتحقق»: a photographed page → the archived pages that look the same (dHash distance)
create or replace function public.kh_phash_lookup(p jsonb) returns jsonb
language sql stable set search_path = public, extensions as $$
  -- the hash is checked inside a CASE (evaluated in order) so bad input gives no rows, never an error
  with h as (
    select case when (p ->> 'phash') ~ '^-?[0-9]{1,19}$'
                 and (p ->> 'phash')::numeric between -9223372036854775808 and 9223372036854775807
                then (p ->> 'phash')::bigint end as v,
           least(greatest(coalesce((p ->> 'max')::int, 10), 0), 16) as maxd),
  hits as (
    select d.id, coalesce(d.title_ar, d.title, d.file_name) as title, d.category_id, pg.page_no,
           bit_count((pg.phash # h.v)::bit(64)) as dist
    from h, public.kh_pages pg join public.kh_documents d on d.id = pg.document_id
    where h.v is not null and d.owner_id = auth.uid() and d.deleted_at is null
      and pg.phash is not null and not pg.blank and pg.phash not in (0, -1)
      and bit_count((pg.phash # h.v)::bit(64)) <= h.maxd
    order by 5 limit 5)
  select coalesce(jsonb_agg(jsonb_build_object('document_id', x.id, 'title', x.title, 'page_no', x.page_no, 'distance', x.dist,
           'category_path', public.kh_category_path(x.category_id),
           'thumb', (select f.path from public.kh_files f where f.document_id = x.id and f.role = 'thumb' limit 1)) order by x.dist), '[]'::jsonb)
  from hits x
$$;

create or replace function public.kh_link_set(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare a uuid := public.kh_uuid(p ->> 'from_id'); b uuid := public.kh_uuid(p ->> 'to_id');
begin
  if a is null or b is null or a = b then raise exception 'bad link'; end if;
  if coalesce((p ->> 'replace')::boolean, false) then
    -- the other links between the two (the same link stays the same row: updated below, never removed and remade)
    delete from public.kh_links where ((from_id = a and to_id = b) or (from_id = b and to_id = a))
      and not (from_id = a and to_id = b and relation = p ->> 'relation');
  end if;
  insert into public.kh_links (id, from_id, to_id, relation, method, confidence, reason, confirmed)
  values (public.kh_key_uuid('link|' || a || '|' || b || '|' || coalesce(p ->> 'relation', '')), a, b, p ->> 'relation', p ->> 'method',
          (p ->> 'confidence')::real, p ->> 'reason', coalesce((p ->> 'confirmed')::boolean, false))
  on conflict (from_id, to_id, relation) do update set method = excluded.method, confidence = excluded.confidence,
    reason = coalesce(excluded.reason, public.kh_links.reason),
    confirmed = case when coalesce((p ->> 'replace')::boolean, false) then excluded.confirmed else excluded.confirmed or public.kh_links.confirmed end;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_link_remove(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  delete from public.kh_links where id = public.kh_uuid(p ->> 'id');
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ API: reviews (questions for the owner)
create or replace function public.kh_review_add(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare rid uuid; did uuid := public.kh_uuid(p ->> 'document_id'); other text := p -> 'payload' ->> 'other_id';
begin
  -- one open question of a kind per document and subject; for two look-alikes, one question per PAIR
  -- (A asking about B and B asking about A would let both be thrown away)
  if p ->> 'kind' = 'duplicate' and other is not null then
    select id into rid from public.kh_reviews
     where kind = 'duplicate' and status = 'open'
       and ((document_id = did and payload ->> 'other_id' = other) or (document_id = public.kh_uuid(other) and payload ->> 'other_id' = did::text))
     limit 1;
    if rid is not null then return jsonb_build_object('id', rid); end if;
  end if;
  select id into rid from public.kh_reviews
   where document_id is not distinct from did and kind = p ->> 'kind' and status = 'open'
     and coalesce(payload ->> 'other_id', '') = coalesce(other, '')
     and coalesce(payload ->> 'entity_id', '') = coalesce(p -> 'payload' ->> 'entity_id', '');
  if rid is null then
    insert into public.kh_reviews (kind, document_id, payload) values (p ->> 'kind', public.kh_uuid(p ->> 'document_id'), coalesce(p -> 'payload', '{}'))
    returning id into rid;
  else
    update public.kh_reviews set payload = coalesce(p -> 'payload', payload) where id = rid;
  end if;
  return jsonb_build_object('id', rid);
end $$;

create or replace function public.kh_reviews_list(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
        'doc', (select jsonb_build_object('id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name), 'doc_type', d.doc_type,
                   'summary_ar', d.summary_ar, 'page_count', d.page_count, 'category_path', public.kh_category_path(d.category_id),
                   'thumb', (select f.path from public.kh_files f where f.document_id = d.id and f.role = 'thumb' limit 1))
                from public.kh_documents d where d.id = r.document_id and d.deleted_at is null)) order by r.created_at desc)
      from public.kh_reviews r where r.owner_id = auth.uid() and r.status = 'open'
        and (r.document_id is null or exists (select 1 from public.kh_documents d where d.id = r.document_id and d.deleted_at is null))), '[]'::jsonb),
    'proposals', coalesce((select jsonb_agg(to_jsonb(pr) || jsonb_build_object(
        'parent_path', public.kh_category_path(pr.parent_id),
        'docs', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name), 'doc_type', d.doc_type,
                   'thumb', (select f.path from public.kh_files f where f.document_id = d.id and f.role = 'thumb' limit 1)) order by d.created_at)
                 from public.kh_documents d where d.proposal_id = pr.id and d.deleted_at is null), '[]'::jsonb)) order by pr.created_at)
      from public.kh_proposals pr where pr.owner_id = auth.uid() and pr.status = 'open'
        and exists (select 1 from public.kh_documents d where d.proposal_id = pr.id and d.deleted_at is null)), '[]'::jsonb))
$$;

create or replace function public.kh_counts(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'reviews', (select count(*) from public.kh_reviews r where r.owner_id = auth.uid() and r.status = 'open'
                  and (r.document_id is null or exists (select 1 from public.kh_documents d where d.id = r.document_id and d.deleted_at is null))),
    'proposals', (select count(*) from public.kh_proposals pr where pr.owner_id = auth.uid() and pr.status = 'open'
                  and exists (select 1 from public.kh_documents d where d.proposal_id = pr.id and d.deleted_at is null)),
    'pending', (select count(*) from public.kh_documents d where d.owner_id = auth.uid() and d.deleted_at is null and d.state not in ('ready', 'review')),
    'documents', (select count(*) from public.kh_documents d where d.owner_id = auth.uid() and d.deleted_at is null),
    'trash', (select count(*) from public.kh_documents d where d.owner_id = auth.uid() and d.deleted_at is not null))
$$;

-- ------------------------------------------------------------------ API: the AI card → the archive
-- Applies what the AI understood: fields, category (or a proposal, following the autonomy setting),
-- people/organisations/places (matched to the registry; unsure matches become questions), deadlines.
create or replace function public.kh_doc_apply_ai(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
  did uuid := public.kh_uuid(p ->> 'id');
  c jsonb := coalesce(p -> 'card', '{}');
  d public.kh_documents;
  corrected text[];
  cat jsonb := coalesce(c -> 'category', '{}');
  existing uuid := public.kh_uuid(cat ->> 'existing_id');
  prop jsonb := case when jsonb_typeof(cat -> 'proposal') = 'object' then cat -> 'proposal' end;
  conf real := coalesce((cat ->> 'confidence')::real, 0.5);
  autonomy text := coalesce(public.kh_setting('autonomy', '"ask"') #>> '{}', 'ask');
  new_cat uuid; parent uuid; pid uuid; pname text; rej public.kh_rejections; proposal_new boolean := false;
  x jsonb; ent uuid; best uuid; best_sim real; key_ar text; key_lat text; kw text[]; reviews int := 0;
  people_new jsonb := '[]';
begin
  select * into d from public.kh_documents where id = did;
  if not found then raise exception 'document not found'; end if;
  select coalesce(array_agg(distinct field), '{}') into corrected from public.kh_corrections where document_id = did;

  select coalesce(array_agg(distinct k), '{}') into kw from (
    select btrim(v) k from jsonb_each(case when jsonb_typeof(c -> 'keywords') = 'object' then c -> 'keywords' else '{}' end) e,
                          jsonb_array_elements_text(case when jsonb_typeof(e.value) = 'array' then e.value else '[]' end) v
    where btrim(v) <> '') z;

  update public.kh_documents set
    doc_type = case when 'doc_type' = any(corrected) then doc_type else coalesce(nullif(c ->> 'doc_type', ''), doc_type) end,
    title = case when 'title' = any(corrected) then title else coalesce(nullif(c ->> 'title', ''), title) end,
    title_ar = case when 'title_ar' = any(corrected) then title_ar else coalesce(nullif(c ->> 'title_ar', ''), title_ar) end,
    summary_ar = case when 'summary_ar' = any(corrected) then summary_ar else coalesce(nullif(c ->> 'summary_ar', ''), summary_ar) end,
    languages = case when 'languages' = any(corrected) then languages else coalesce(nullif(public.kh_jtext(c -> 'languages'), '{}'), languages) end,
    doc_date = case when 'doc_date' = any(corrected) then doc_date else coalesce(public.kh_date(c #>> '{dates,document_date}'), doc_date) end,
    date_precision = case when 'doc_date' = any(corrected) then date_precision else coalesce(c #>> '{dates,precision}', date_precision) end,
    academic_year = case when 'academic_year' = any(corrected) then academic_year else coalesce(nullif(c #>> '{dates,academic_year}', ''), academic_year) end,
    period_start = coalesce(public.kh_date(c #>> '{dates,period_start}'), period_start),
    period_end = coalesce(public.kh_date(c #>> '{dates,period_end}'), period_end),
    expiry_date = case when 'expiry_date' = any(corrected) then expiry_date else coalesce(public.kh_date(c #>> '{dates,expiry_date}'), expiry_date) end,
    identifiers = case when jsonb_typeof(c -> 'identifiers') = 'array' then c -> 'identifiers' else identifiers end,
    status = case when 'status' = any(corrected) then status else coalesce(c -> 'status', status) end,
    -- 'vault' is written as 'private' here; the worker seals it last (kh_vault_seal), once everything is done
    sensitivity = case when 'sensitivity' = any(corrected) then sensitivity
                       when sensitivity = 'vault' then sensitivity
                       when coalesce(c ->> 'sensitivity', '') = 'vault' then 'private'
                       when coalesce(c ->> 'sensitivity', '') in ('normal', 'private') then c ->> 'sensitivity' else sensitivity end,
    keywords = case when coalesce(array_length(kw, 1), 0) > 0 then kw else keywords end,
    visual_features = coalesce(nullif(c ->> 'visual_features', ''), visual_features),
    ai_reason = coalesce(nullif(c ->> 'reason_ar', ''), ai_reason),
    ai_confidence = coalesce((c ->> 'confidence')::real, ai_confidence),
    ai_model = coalesce(p ->> 'model', ai_model),
    ai_mode = coalesce(p ->> 'mode', ai_mode),
    processed_at = now()
  where id = did;

  -- ---------------- category
  if not ('category_id' = any(corrected)) then
    if existing is not null and not exists (select 1 from public.kh_categories where id = existing and not archived) then existing := null; end if;
    parent := public.kh_uuid(prop ->> 'parent_id');
    if parent is not null and not exists (select 1 from public.kh_categories where id = parent and not archived) then parent := existing; end if;
    if prop is not null and coalesce(btrim(prop ->> 'name_ar'), '') <> '' then
      pname := public.kh_norm(prop ->> 'name_ar');
      -- the same name already exists (in any language)? use it: categories never duplicate either
      select id into new_cat from public.kh_categories
       where owner_id = auth.uid() and not archived
         and (public.kh_norm(name_ar) = pname or pname = any(aliases)
              -- an empty French/English name never matches anything
              or (public.kh_norm(prop ->> 'name_fr') <> '' and public.kh_norm(name_fr) = public.kh_norm(prop ->> 'name_fr'))
              or (public.kh_norm(prop ->> 'name_en') <> '' and public.kh_norm(name_en) = public.kh_norm(prop ->> 'name_en')))
       limit 1;
      if new_cat is null then
        select * into rej from public.kh_rejections where owner_id = auth.uid() and name_norm = pname;
        if found then
          new_cat := coalesce(rej.mapped_category_id, parent, existing);
        else
          -- an open proposal with the same or a very close name under the same parent: group them
          select id into pid from public.kh_proposals
           where owner_id = auth.uid() and status = 'open' and parent_id is not distinct from parent
             and (public.kh_norm(name_ar) = pname or similarity(public.kh_norm(name_ar), pname) >= 0.6)
           order by similarity(public.kh_norm(name_ar), pname) desc limit 1;
          if pid is null then
            insert into public.kh_proposals (parent_id, name_ar, name_fr, name_es, name_en, reason)
            values (parent, btrim(prop ->> 'name_ar'), nullif(btrim(prop ->> 'name_fr'), ''), nullif(btrim(prop ->> 'name_es'), ''),
                    nullif(btrim(prop ->> 'name_en'), ''), nullif(btrim(prop ->> 'reason_ar'), ''))
            returning id into pid;
            proposal_new := true;
          end if;
          if autonomy = 'auto' or (autonomy = 'ask_top' and parent is not null) then
            select result_category_id into new_cat from public.kh_proposals where id = pid and status = 'accepted';
            if new_cat is null then
              insert into public.kh_categories (parent_id, name_ar, name_fr, name_es, name_en, origin, aliases)
              select parent_id, name_ar, name_fr, name_es, name_en, 'ai',
                     array_remove(array[public.kh_norm(name_ar), public.kh_norm(name_fr), public.kh_norm(name_es), public.kh_norm(name_en)], '')
              from public.kh_proposals where id = pid returning id into new_cat;
              update public.kh_proposals set status = 'accepted', auto = true, result_category_id = new_cat, resolved_at = now() where id = pid;
              update public.kh_documents set category_id = new_cat, proposal_id = null where proposal_id = pid;
            end if;
            pid := null;
          end if;
        end if;
      end if;
      if pid is not null then
        update public.kh_documents set category_id = coalesce(parent, existing), proposal_id = pid, category_confidence = conf where id = did;
      else
        update public.kh_documents set category_id = coalesce(new_cat, existing, parent), proposal_id = null, category_confidence = conf where id = did;
      end if;
    else
      update public.kh_documents set category_id = existing, proposal_id = null, category_confidence = conf where id = did;
    end if;
  end if;

  -- ---------------- people / organisations / places
  if not ('entities' = any(corrected)) then
    delete from public.kh_doc_entities where document_id = did;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(c -> 'people') = 'array' then c -> 'people' else '[]' end) loop
      key_ar := public.kh_person_key(x ->> 'name_ar');
      key_lat := public.kh_person_key(x ->> 'name_latin');
      if coalesce(key_ar, '') = '' and coalesce(key_lat, '') = '' then continue; end if;
      best := null; best_sim := 0;
      select e.id into best from public.kh_entities e
       where e.owner_id = auth.uid() and e.kind = 'person' and e.merged_into is null
         and ((key_ar <> '' and key_ar = any(e.aliases)) or (key_lat <> '' and key_lat = any(e.aliases)))
       limit 1;
      if best is not null then
        best_sim := 1;
      else
        select e.id, greatest(
                 coalesce((select max(similarity(key_ar, a)) from unnest(e.aliases) a where key_ar <> ''), 0),
                 coalesce((select max(similarity(key_lat, a)) from unnest(e.aliases) a where key_lat <> ''), 0))
          into best, best_sim
          from public.kh_entities e
         where e.owner_id = auth.uid() and e.kind = 'person' and e.merged_into is null
         order by 2 desc limit 1;
      end if;
      if best is not null and best_sim >= 0.82 then
        ent := best;
        update public.kh_entities set
          aliases = array(select distinct a from unnest(aliases || array_remove(array[key_ar, key_lat], '')) a where a <> ''),
          name_latin = coalesce(name_latin, nullif(btrim(x ->> 'name_latin'), '')),
          honorific = coalesce(honorific, nullif(btrim(x ->> 'honorific'), ''))
        where id = ent;
      else
        insert into public.kh_entities (kind, name, name_latin, honorific, aliases, details)
        values ('person', coalesce(nullif(btrim(x ->> 'name_ar'), ''), btrim(x ->> 'name_latin')), nullif(btrim(x ->> 'name_latin'), ''),
                nullif(btrim(x ->> 'honorific'), ''), array_remove(array[key_ar, key_lat], ''),
                jsonb_strip_nulls(jsonb_build_object('field', nullif(x ->> 'field', ''), 'institution', nullif(x ->> 'institution', ''))))
        returning id into ent;
        if best is not null and best_sim >= 0.45 then
          insert into public.kh_reviews (kind, document_id, payload) values ('person_match', did,
            jsonb_build_object('entity_id', ent, 'candidate_id', best, 'similarity', round(best_sim::numeric, 2),
                               'name', coalesce(nullif(btrim(x ->> 'name_ar'), ''), x ->> 'name_latin'), 'role', x ->> 'role',
                               'candidate_name', (select name from public.kh_entities where id = best)));
          reviews := reviews + 1;
        elsif coalesce(x ->> 'role', '') in ('professor', 'author', 'supervisor', 'physician') then
          people_new := people_new || jsonb_build_object('entity_id', ent, 'name', coalesce(nullif(btrim(x ->> 'name_ar'), ''), x ->> 'name_latin'), 'role', x ->> 'role');
        end if;
      end if;
      insert into public.kh_doc_entities (document_id, entity_id, role, as_written)
      values (did, ent, coalesce(nullif(x ->> 'role', ''), 'mentioned'), nullif(x ->> 'as_written', ''))
      on conflict do nothing;
    end loop;

    for x in select jsonb_build_object('kind', 'org', 'name', o ->> 'name', 'latin', o ->> 'name_latin', 'role', 'organization',
                                       'details', jsonb_strip_nulls(jsonb_build_object('type', o ->> 'kind', 'city', o ->> 'city')))
             from jsonb_array_elements(case when jsonb_typeof(c -> 'organizations') = 'array' then c -> 'organizations' else '[]' end) o
             union all
             select jsonb_build_object('kind', 'place', 'name', pl ->> 'name_ar', 'latin', pl ->> 'name_latin', 'role', coalesce(pl ->> 'role', 'mentioned'),
                                       'details', jsonb_strip_nulls(jsonb_build_object('country', pl ->> 'country')))
             from jsonb_array_elements(case when jsonb_typeof(c -> 'places') = 'array' then c -> 'places' else '[]' end) pl loop
      key_ar := public.kh_norm(x ->> 'name');
      key_lat := public.kh_norm(x ->> 'latin');
      if coalesce(key_ar, '') = '' and coalesce(key_lat, '') = '' then continue; end if;
      select e.id into ent from public.kh_entities e
       where e.owner_id = auth.uid() and e.kind = x ->> 'kind' and e.merged_into is null
         and ((key_ar <> '' and key_ar = any(e.aliases)) or (key_lat <> '' and key_lat = any(e.aliases))
              or (key_ar <> '' and exists (select 1 from unnest(e.aliases) a where similarity(a, key_ar) >= 0.85)))
       limit 1;
      if ent is null then
        insert into public.kh_entities (kind, name, name_latin, aliases, details, confirmed)
        values (x ->> 'kind', coalesce(nullif(btrim(x ->> 'name'), ''), btrim(x ->> 'latin')), nullif(btrim(x ->> 'latin'), ''),
                array_remove(array[key_ar, key_lat], ''), coalesce(x -> 'details', '{}'), true)
        returning id into ent;
      else
        update public.kh_entities set aliases = array(select distinct a from unnest(aliases || array_remove(array[key_ar, key_lat], '')) a where a <> '')
        where id = ent;
      end if;
      insert into public.kh_doc_entities (document_id, entity_id, role) values (did, ent, x ->> 'role') on conflict do nothing;
      ent := null;
    end loop;
  end if;

  if jsonb_array_length(people_new) > 0 then
    insert into public.kh_reviews (kind, document_id, payload) values ('person_new', did, jsonb_build_object('people', people_new));
    reviews := reviews + 1;
  end if;

  -- ---------------- deadlines (expiry + what a letter asks for)
  select * into d from public.kh_documents where id = did;
  if d.expiry_date is not null then
    insert into public.kh_deadlines (id, document_id, kind, due_date, title)
    values (public.kh_key_uuid('deadline|' || did || '|expiry|' || d.expiry_date), did, 'expiry', d.expiry_date,
            coalesce(d.title_ar, d.title, 'وثيقة') || ' — تنتهي صلاحيتها') on conflict do nothing;
  end if;
  insert into public.kh_deadlines (id, document_id, kind, due_date, title)
  select public.kh_key_uuid('deadline|' || did || '|action|' || public.kh_date(z ->> 'date')), did, 'action', public.kh_date(z ->> 'date'),
         coalesce(nullif(z ->> 'title_ar', ''), 'إجراء مطلوب')
  from jsonb_array_elements(case when jsonb_typeof(c -> 'deadlines') = 'array' then c -> 'deadlines' else '[]' end) z
  where public.kh_date(z ->> 'date') is not null
  on conflict do nothing;

  -- ---------------- an unsure reading: one question (and an old question closes when the new reading is sure)
  if coalesce((c ->> 'confidence')::real, 1) >= 0.55 and (d.category_id is not null or d.proposal_id is not null) then
    update public.kh_reviews set status = 'dismissed', resolved_at = now(), decision = '{"auto": true}'
     where document_id = did and kind = 'low_confidence' and status = 'open';
  end if;
  if coalesce((c ->> 'confidence')::real, 1) < 0.55 or (d.category_id is null and d.proposal_id is null) then
    insert into public.kh_reviews (kind, document_id, payload)
    select 'low_confidence', did, jsonb_build_object('confidence', c ->> 'confidence', 'reason', c ->> 'reason_ar')
    where not exists (select 1 from public.kh_reviews where document_id = did and kind = 'low_confidence' and status = 'open');
    reviews := reviews + 1;
  end if;

  perform public.kh_reindex(did);
  return jsonb_build_object('category_id', d.category_id, 'proposal_id', d.proposal_id, 'proposal_new', proposal_new, 'reviews', reviews,
    'seal', not ('sensitivity' = any(corrected)) and coalesce(c ->> 'sensitivity', '') = 'vault');
end $$;

-- ------------------------------------------------------------------ API: categories & proposals
create or replace function public.kh_categories_list(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
      'doc_count', (select count(*) from public.kh_documents d where d.category_id = c.id and d.deleted_at is null))
    order by c.sort, c.name_ar), '[]'::jsonb)
  from public.kh_categories c where c.owner_id = auth.uid() and (not c.archived or coalesce((p ->> 'archived')::boolean, false))
$$;

create or replace function public.kh_category_save(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare cid uuid := public.kh_uuid(p ->> 'id'); par uuid := public.kh_uuid(p ->> 'parent_id'); r public.kh_categories;
begin
  if coalesce(btrim(p ->> 'name_ar'), '') = '' then raise exception 'name required'; end if;
  if cid is not null and par is not null and par = any(public.kh_category_tree_ids(array[cid])) then
    raise exception 'a category cannot move inside itself';
  end if;
  if cid is null then
    insert into public.kh_categories (parent_id, name_ar, name_fr, name_es, name_en, description, icon, origin, aliases)
    values (par, btrim(p ->> 'name_ar'), nullif(btrim(p ->> 'name_fr'), ''), nullif(btrim(p ->> 'name_es'), ''), nullif(btrim(p ->> 'name_en'), ''),
            nullif(btrim(p ->> 'description'), ''), nullif(p ->> 'icon', ''), 'owner',
            array_remove(array[public.kh_norm(p ->> 'name_ar'), public.kh_norm(p ->> 'name_fr'), public.kh_norm(p ->> 'name_es'), public.kh_norm(p ->> 'name_en')], ''))
    returning * into r;
  else
    update public.kh_categories set parent_id = par, name_ar = btrim(p ->> 'name_ar'), name_fr = nullif(btrim(p ->> 'name_fr'), ''),
      name_es = nullif(btrim(p ->> 'name_es'), ''), name_en = nullif(btrim(p ->> 'name_en'), ''), description = nullif(btrim(p ->> 'description'), ''),
      icon = coalesce(nullif(p ->> 'icon', ''), icon),
      aliases = array(select distinct a from unnest(aliases || array_remove(array[public.kh_norm(p ->> 'name_ar'), public.kh_norm(p ->> 'name_fr'),
                 public.kh_norm(p ->> 'name_es'), public.kh_norm(p ->> 'name_en')], '')) a where a <> '')
    where id = cid returning * into r;
    perform public.kh_reindex(d.id) from public.kh_documents d where d.category_id = any(public.kh_category_tree_ids(array[cid]));
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.kh_category_merge(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare a uuid := public.kh_uuid(p ->> 'from_id'); b uuid := public.kh_uuid(p ->> 'into_id');
begin
  if a is null or b is null or a = b then raise exception 'bad merge'; end if;
  if b = any(public.kh_category_tree_ids(array[a])) then raise exception 'cannot merge into a sub-category'; end if;
  update public.kh_documents set category_id = b where category_id = a;
  update public.kh_categories set parent_id = b where parent_id = a;
  update public.kh_categories set aliases = array(select distinct x from unnest(aliases || (select aliases from public.kh_categories where id = a)) x)
   where id = b;
  update public.kh_proposals set parent_id = b where parent_id = a;
  update public.kh_categories set archived = true where id = a;
  perform public.kh_reindex(d.id) from public.kh_documents d where d.category_id = b;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_category_delete(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare cid uuid := public.kh_uuid(p ->> 'id'); par uuid;
begin
  select parent_id into par from public.kh_categories where id = cid;
  update public.kh_documents set category_id = par where category_id = cid;
  update public.kh_categories set parent_id = par where parent_id = cid;
  update public.kh_proposals set parent_id = par where parent_id = cid;
  update public.kh_categories set archived = true where id = cid;
  return jsonb_build_object('ok', true);
end $$;

-- the owner answers a proposal: accept (maybe with a new name / place), reject, or «put it in that category»
create or replace function public.kh_proposal_resolve(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
  pr public.kh_proposals; act text := p ->> 'action'; e jsonb := coalesce(p -> 'edits', '{}');
  cid uuid; par uuid; moved uuid[]; q tsquery; backfill jsonb := '[]';
begin
  select * into pr from public.kh_proposals where id = public.kh_uuid(p ->> 'id') and status = 'open';
  if not found then raise exception 'proposal not found'; end if;
  select coalesce(array_agg(id), '{}') into moved from public.kh_documents where proposal_id = pr.id;
  if act = 'accept' then
    par := case when e ? 'parent_id' then public.kh_uuid(e ->> 'parent_id') else pr.parent_id end;
    insert into public.kh_categories (parent_id, name_ar, name_fr, name_es, name_en, origin, aliases)
    values (par, coalesce(nullif(btrim(e ->> 'name_ar'), ''), pr.name_ar), coalesce(nullif(btrim(e ->> 'name_fr'), ''), pr.name_fr),
            coalesce(nullif(btrim(e ->> 'name_es'), ''), pr.name_es), coalesce(nullif(btrim(e ->> 'name_en'), ''), pr.name_en), 'ai', '{}')
    returning id into cid;
    update public.kh_categories set aliases = array_remove(array[public.kh_norm(name_ar), public.kh_norm(name_fr), public.kh_norm(name_es),
      public.kh_norm(name_en), public.kh_norm(pr.name_ar)], '') where id = cid;
    update public.kh_categories set aliases = array(select distinct a from unnest(aliases) a) where id = cid;
    update public.kh_documents set category_id = cid, proposal_id = null where proposal_id = pr.id;
    update public.kh_proposals set status = 'accepted', result_category_id = cid, resolved_at = now() where id = pr.id;
    -- older documents that may belong here (same parent branch or unclassified), for the owner to confirm
    select public.kh_tsquery(concat_ws(' ', c.name_ar, c.name_fr, c.name_es, c.name_en), 'or') into q from public.kh_categories c where c.id = cid;
    if q is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'rank', rank) order by rank desc), '[]'::jsonb) into backfill from (
        select d.id, coalesce(d.title_ar, d.title, d.file_name) as title, ts_rank_cd(d.search, q) as rank
        from public.kh_documents d
        where d.owner_id = auth.uid() and d.deleted_at is null and not (d.id = any(moved)) and d.search @@ q
          and (d.category_id is null or d.category_id = any(public.kh_category_tree_ids(array[par])) or par is null)
          and d.category_id is distinct from cid
        order by rank desc limit 40) z
      where rank >= 0.05;
    end if;
    if jsonb_array_length(backfill) > 0 then
      insert into public.kh_reviews (kind, payload) values ('backfill', jsonb_build_object('category_id', cid, 'category_name',
        (select name_ar from public.kh_categories where id = cid), 'docs', backfill));
    end if;
  elsif act = 'reject' then
    update public.kh_documents set proposal_id = null where proposal_id = pr.id;
    update public.kh_proposals set status = 'rejected', resolved_at = now() where id = pr.id;
    insert into public.kh_rejections (name_norm, parent_id) values (public.kh_norm(pr.name_ar), pr.parent_id)
    on conflict (owner_id, name_norm) do update set parent_id = excluded.parent_id, mapped_category_id = null;
  elsif act = 'remap' then
    cid := public.kh_uuid(p ->> 'category_id');
    if cid is null or not exists (select 1 from public.kh_categories where id = cid) then raise exception 'category not found'; end if;
    update public.kh_documents set category_id = cid, proposal_id = null where proposal_id = pr.id;
    update public.kh_proposals set status = 'remapped', result_category_id = cid, resolved_at = now() where id = pr.id;
    insert into public.kh_rejections (name_norm, parent_id, mapped_category_id) values (public.kh_norm(pr.name_ar), pr.parent_id, cid)
    on conflict (owner_id, name_norm) do update set mapped_category_id = excluded.mapped_category_id;
    update public.kh_categories set aliases = array(select distinct a from unnest(aliases || public.kh_norm(pr.name_ar)) a) where id = cid;
  else
    raise exception 'unknown action';
  end if;
  perform public.kh_reindex(x) from unnest(moved) x;
  return jsonb_build_object('ok', true, 'category_id', cid, 'moved', coalesce(array_length(moved, 1), 0), 'backfill', backfill);
end $$;

create or replace function public.kh_move_docs(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare ids uuid[] := public.kh_juuid(p -> 'ids'); cid uuid := public.kh_uuid(p ->> 'category_id');
begin
  update public.kh_documents set category_id = cid, proposal_id = null where id = any(ids);
  insert into public.kh_corrections (document_id, field, new_value) select x, 'category_id', to_jsonb(cid) from unnest(ids) x;
  perform public.kh_reindex(x) from unnest(ids) x;
  return jsonb_build_object('ok', true, 'count', coalesce(array_length(ids, 1), 0));
end $$;

-- ------------------------------------------------------------------ API: people, organisations, places
create or replace function public.kh_entities_list(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(z order by (z ->> 'doc_count')::int desc, z ->> 'name'), '[]'::jsonb) from (
    select to_jsonb(e) - 'aliases' || jsonb_build_object(
      'doc_count', (select count(distinct de.document_id) from public.kh_doc_entities de join public.kh_documents d on d.id = de.document_id
                    where de.entity_id = e.id and d.deleted_at is null),
      'roles', (select coalesce(jsonb_agg(distinct de.role), '[]'::jsonb) from public.kh_doc_entities de where de.entity_id = e.id),
      'years', (select jsonb_build_object('from', min(extract(year from d.doc_date)), 'to', max(extract(year from d.doc_date)))
                from public.kh_doc_entities de join public.kh_documents d on d.id = de.document_id where de.entity_id = e.id and d.deleted_at is null)) as z
    from public.kh_entities e
    where e.owner_id = auth.uid() and e.merged_into is null
      and (coalesce(p ->> 'kind', '') = '' or e.kind = p ->> 'kind')
      and (coalesce(p ->> 'q', '') = '' or exists (select 1 from unnest(e.aliases || public.kh_norm(e.name)) a
                                                   where a like '%' || public.kh_person_key(p ->> 'q') || '%' or similarity(a, public.kh_person_key(p ->> 'q')) >= 0.4))
    limit coalesce((p ->> 'limit')::int, 500)) s
$$;

create or replace function public.kh_entity_get(p jsonb) returns jsonb
language sql stable set search_path = public, extensions as $$
  select to_jsonb(e) || jsonb_build_object(
    'docs', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name), 'doc_type', d.doc_type,
                'doc_date', d.doc_date, 'date_precision', d.date_precision, 'academic_year', d.academic_year, 'role', de.role, 'category_path', public.kh_category_path(d.category_id),
                'thumb', (select f.path from public.kh_files f where f.document_id = d.id and f.role = 'thumb' limit 1))
                order by d.doc_date desc nulls last, d.created_at desc)
              from public.kh_doc_entities de join public.kh_documents d on d.id = de.document_id
              where de.entity_id = e.id and d.deleted_at is null), '[]'::jsonb),
    'related', coalesce((select jsonb_agg(z) from (
                select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'count', count(*)) z
                from public.kh_doc_entities a join public.kh_doc_entities b on b.document_id = a.document_id and b.entity_id <> a.entity_id
                join public.kh_entities o on o.id = b.entity_id
                where a.entity_id = e.id and o.merged_into is null
                group by o.id, o.name, o.kind order by count(*) desc limit 12) q), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(z) from (
                select jsonb_build_object('id', c.id, 'name', c.name_ar, 'count', count(*)) z
                from public.kh_doc_entities de join public.kh_documents d on d.id = de.document_id join public.kh_categories c on c.id = d.category_id
                where de.entity_id = e.id and d.deleted_at is null group by c.id, c.name_ar order by count(*) desc limit 8) q), '[]'::jsonb))
  from public.kh_entities e where e.id = public.kh_uuid(p ->> 'id')
$$;

create or replace function public.kh_entity_save(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare eid uuid := public.kh_uuid(p ->> 'id');
begin
  update public.kh_entities set
    name = coalesce(nullif(btrim(p ->> 'name'), ''), name),
    name_latin = case when p ? 'name_latin' then nullif(btrim(p ->> 'name_latin'), '') else name_latin end,
    honorific = case when p ? 'honorific' then nullif(btrim(p ->> 'honorific'), '') else honorific end,
    details = case when p ? 'details' then coalesce(p -> 'details', '{}') else details end,
    confirmed = coalesce((p ->> 'confirmed')::boolean, confirmed),
    aliases = array(select distinct a from unnest(aliases || array_remove(array[public.kh_person_key(p ->> 'name'), public.kh_person_key(p ->> 'name_latin')], '')) a where a <> '')
  where id = eid;
  perform public.kh_reindex(de.document_id) from public.kh_doc_entities de where de.entity_id = eid;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kh_entity_merge(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare a uuid := public.kh_uuid(p ->> 'from_id'); b uuid := public.kh_uuid(p ->> 'into_id');
begin
  if a is null or b is null or a = b then raise exception 'bad merge'; end if;
  insert into public.kh_doc_entities (document_id, entity_id, role, as_written)
  select document_id, b, role, as_written from public.kh_doc_entities where entity_id = a on conflict do nothing;
  delete from public.kh_doc_entities where entity_id = a;
  update public.kh_entities set aliases = array(select distinct x from unnest(aliases || (select aliases from public.kh_entities where id = a)) x),
    name_latin = coalesce(name_latin, (select name_latin from public.kh_entities where id = a)),
    honorific = coalesce(honorific, (select honorific from public.kh_entities where id = a)), confirmed = true
  where id = b;
  update public.kh_entities set merged_into = b where id = a;
  update public.kh_reviews set status = 'done', resolved_at = now(), decision = jsonb_build_object('merged_into', b)
   where status = 'open' and kind in ('person_match') and (payload ->> 'entity_id')::text = a::text;
  perform public.kh_reindex(de.document_id) from public.kh_doc_entities de where de.entity_id = b;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ API: answering a question
create or replace function public.kh_review_resolve(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare r public.kh_reviews; dec jsonb := coalesce(p -> 'decision', '{}'); x jsonb;
begin
  select * into r from public.kh_reviews where id = public.kh_uuid(p ->> 'id');
  if not found then raise exception 'question not found'; end if;
  if r.kind = 'person_match' then
    if coalesce((dec ->> 'same')::boolean, false) then
      perform public.kh_entity_merge(jsonb_build_object('from_id', r.payload ->> 'entity_id', 'into_id', r.payload ->> 'candidate_id'));
    else
      update public.kh_entities set confirmed = true where id = public.kh_uuid(r.payload ->> 'entity_id');
    end if;
  elsif r.kind = 'person_new' then
    for x in select * from jsonb_array_elements(coalesce(r.payload -> 'people', '[]')) loop
      if public.kh_uuid(dec -> 'merge' ->> (x ->> 'entity_id')) is not null then
        perform public.kh_entity_merge(jsonb_build_object('from_id', x ->> 'entity_id', 'into_id', dec -> 'merge' ->> (x ->> 'entity_id')));
      else
        update public.kh_entities set confirmed = true where id = public.kh_uuid(x ->> 'entity_id');
      end if;
    end loop;
  elsif r.kind = 'backfill' then
    if jsonb_typeof(dec -> 'ids') = 'array' then
      perform public.kh_move_docs(jsonb_build_object('ids', dec -> 'ids', 'category_id', r.payload ->> 'category_id'));
    end if;
  elsif r.kind = 'duplicate' then
    -- never throw a copy away when the one we keep is already gone
    if dec ->> 'discard' = 'new' and not exists (select 1 from public.kh_documents d
         where d.id = public.kh_uuid(r.payload ->> 'other_id') and d.deleted_at is null) then
      raise exception 'الوثيقة الأخرى لم تعد موجودة: لا يمكن حذف هذه';
    end if;
    if dec ->> 'discard' = 'existing' and not exists (select 1 from public.kh_documents d where d.id = r.document_id and d.deleted_at is null) then
      raise exception 'هذه الوثيقة لم تعد موجودة: لا يمكن حذف الأخرى';
    end if;
    update public.kh_reviews set status = 'done', decision = dec, resolved_at = now()
     where kind = 'duplicate' and status = 'open' and id <> r.id
       and ((document_id = r.document_id and payload ->> 'other_id' = r.payload ->> 'other_id')
         or (document_id = public.kh_uuid(r.payload ->> 'other_id') and payload ->> 'other_id' = r.document_id::text));
    if dec ? 'relation' and dec ->> 'relation' <> 'different' then
      perform public.kh_link_set(jsonb_build_object('from_id', r.document_id, 'to_id', r.payload ->> 'other_id', 'relation', dec ->> 'relation',
        'method', coalesce(r.payload ->> 'method', 'owner'), 'confidence', 1, 'confirmed', true, 'replace', true,
        'reason', r.payload ->> 'reason'));
    elsif dec ->> 'relation' = 'different' then
      delete from public.kh_links where (from_id = r.document_id and to_id = public.kh_uuid(r.payload ->> 'other_id'))
                                    or (to_id = r.document_id and from_id = public.kh_uuid(r.payload ->> 'other_id'));
    end if;
    if dec ->> 'discard' = 'new' then
      perform public.kh_doc_delete(jsonb_build_object('id', r.document_id));
    elsif dec ->> 'discard' = 'existing' then
      perform public.kh_doc_delete(jsonb_build_object('id', r.payload ->> 'other_id'));
    end if;
  elsif r.kind = 'low_confidence' then
    update public.kh_documents set ai_confidence = greatest(coalesce(ai_confidence, 0), 0.9) where id = r.document_id;
  end if;
  update public.kh_reviews set status = case when coalesce((p ->> 'dismiss')::boolean, false) then 'dismissed' else 'done' end,
    decision = dec, resolved_at = now() where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------------ API: search
-- one helper returns the matching ids for a query (all words / any word / fuzzy) and the filters
create or replace function public.kh_search_hits(f jsonb, tsq tsquery, fuzzy text, cats uuid[])
returns table (id uuid, rank real, best_page int)
language sql stable set search_path = public, extensions as $$
  select d.id,
    (case
       when tsq is not null then greatest(ts_rank_cd('{0.05, 0.2, 0.5, 1.0}', d.search, tsq),
                                          coalesce(pg.r, 0) * 0.6)
       when fuzzy is not null then greatest(word_similarity(fuzzy, public.kh_norm(concat_ws(' ', d.title, d.title_ar, d.file_name))),
                                            coalesce((select max(word_similarity(fuzzy, a)) from public.kh_doc_entities de
                                                      join public.kh_entities e on e.id = de.entity_id, unnest(e.aliases) a
                                                      where de.document_id = d.id), 0))
       else 0 end)::real as rank,
    pg.page_no as best_page
  from public.kh_documents d
  left join lateral (
    select x.page_no, ts_rank_cd(x.search, tsq) as r from public.kh_pages x
    where tsq is not null and x.document_id = d.id and x.search @@ tsq
    order by ts_rank_cd(x.search, tsq) desc limit 1) pg on true
  where d.owner_id = auth.uid()
    and (case when coalesce((f ->> 'deleted')::boolean, false) then d.deleted_at is not null else d.deleted_at is null end)
    and (cats is null or d.category_id = any(cats))
    and (not (f ? 'uncategorized') or (d.category_id is null and d.proposal_id is null))
    and (not (f ? 'doc_types') or d.doc_type = any(public.kh_jtext(f -> 'doc_types')))
    and (not (f ? 'year_from') or coalesce(extract(year from d.doc_date)::int, public.kh_ay_year(d.academic_year)) >= (f ->> 'year_from')::int)
    and (not (f ? 'year_to') or coalesce(extract(year from d.doc_date)::int, public.kh_ay_year(d.academic_year)) <= (f ->> 'year_to')::int)
    and (not (f ? 'entity_ids') or exists (select 1 from public.kh_doc_entities de where de.document_id = d.id and de.entity_id = any(public.kh_juuid(f -> 'entity_ids'))))
    and (not (f ? 'languages') or d.languages && public.kh_jtext(f -> 'languages'))
    and (not (f ? 'location_id') or d.original_location_id = public.kh_uuid(f ->> 'location_id'))
    and (not (f ? 'sensitivity') or d.sensitivity = f ->> 'sensitivity')
    and (not (f ? 'states') or d.state = any(public.kh_jtext(f -> 'states')))
    and (not (f ? 'favorite') or d.favorite)
    and (not (f ? 'ai_mode') or d.ai_mode is not distinct from nullif(f ->> 'ai_mode', 'none'))
    and (not (f ? 'pinned') or d.pinned_offline)
    and (not (f ? 'proposal_id') or d.proposal_id = public.kh_uuid(f ->> 'proposal_id'))
    and (not (f ? 'session_id') or d.session_id = public.kh_uuid(f ->> 'session_id'))
    and (not (f ? 'ids') or d.id = any(public.kh_juuid(f -> 'ids')))
    and (not (f ? 'expiring') or (d.expiry_date is not null and d.expiry_date <= current_date + (f ->> 'expiring')::int))
    and (tsq is null or d.search @@ tsq or pg.page_no is not null)
    and (fuzzy is null or tsq is not null
         or word_similarity(fuzzy, public.kh_norm(concat_ws(' ', d.title, d.title_ar, d.file_name))) >= 0.45
         or exists (select 1 from public.kh_doc_entities de join public.kh_entities e on e.id = de.entity_id, unnest(e.aliases) a
                    where de.document_id = d.id and word_similarity(fuzzy, a) >= 0.5))
$$;

create or replace function public.kh_search(p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare
  q text := nullif(btrim(coalesce(p ->> 'q', '')), '');
  f jsonb := coalesce(p -> 'filters', '{}');
  lim int := least(greatest(coalesce((p ->> 'limit')::int, 30), 1), 200);
  off int := greatest(coalesce((p ->> 'offset')::int, 0), 0);
  sort text := coalesce(p ->> 'sort', case when nullif(btrim(coalesce(p ->> 'q', '')), '') is null then 'newest' else 'relevance' end);
  cats uuid[]; tsq tsquery; fuzzy text; mode text := 'none'; n int; result jsonb; qn text[];
begin
  if jsonb_typeof(f -> 'category_ids') = 'array' and jsonb_array_length(f -> 'category_ids') > 0 then
    cats := public.kh_category_tree_ids(public.kh_juuid(f -> 'category_ids'));
  end if;
  if q is not null then
    tsq := public.kh_tsquery(q, 'and'); mode := 'all';
    select count(*) into n from public.kh_search_hits(f, tsq, null, cats);
    if n = 0 then
      tsq := public.kh_tsquery(q, 'or'); mode := 'any';
      select count(*) into n from public.kh_search_hits(f, tsq, null, cats);
    end if;
    if n = 0 or tsq is null then
      tsq := null; fuzzy := public.kh_norm(q); mode := 'fuzzy';
    end if;
  end if;
  select array(select x from regexp_split_to_table(public.kh_norm(q), ' ') x where length(x) >= 2 and not public.kh_stopword(x)) into qn;

  with hits as (select * from public.kh_search_hits(f, tsq, fuzzy, cats)),
  docs as (select d.*, h.rank, h.best_page from hits h join public.kh_documents d on d.id = h.id),
  ranked as (
    select docs.*, row_number() over (order by
      case when sort = 'relevance' then docs.rank end desc nulls last,
      case when sort in ('doc_date', 'relevance') then coalesce(docs.doc_date, make_date(public.kh_ay_year(docs.academic_year), 9, 1)) end desc nulls last,
      case when sort = 'oldest' then coalesce(docs.doc_date, make_date(public.kh_ay_year(docs.academic_year), 9, 1)) end asc nulls last,
      case when sort = 'title' then coalesce(docs.title_ar, docs.title, docs.file_name) end asc,
      docs.created_at desc) as ord
    from docs),
  page as (select * from ranked where ord > off and ord <= off + lim)
  select jsonb_build_object(
    'mode', mode,
    'total', (select count(*) from hits),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.id, 'title', x.title, 'title_ar', x.title_ar, 'file_name', x.file_name, 'summary_ar', x.summary_ar, 'doc_type', x.doc_type,
        'doc_date', x.doc_date, 'date_precision', x.date_precision, 'academic_year', x.academic_year, 'expiry_date', x.expiry_date,
        'languages', x.languages, 'state', x.state, 'state_detail', x.state_detail, 'page_count', x.page_count, 'sensitivity', x.sensitivity,
        'favorite', x.favorite, 'pinned_offline', x.pinned_offline, 'created_at', x.created_at, 'deleted_at', x.deleted_at,
        'category_id', x.category_id, 'category_path', public.kh_category_path(x.category_id), 'proposal_id', x.proposal_id,
        'proposal_name', (select pr.name_ar from public.kh_proposals pr where pr.id = x.proposal_id and pr.status = 'open'),
        'location', (select l.name from public.kh_locations l where l.id = x.original_location_id),
        'thumb', (select fl.path from public.kh_files fl where fl.document_id = x.id and fl.role = 'thumb' limit 1),
        'people', (select coalesce(jsonb_agg(z), '[]'::jsonb) from (select jsonb_build_object('id', e.id, 'name', e.name, 'role', de.role) z
                   from public.kh_doc_entities de join public.kh_entities e on e.id = de.entity_id
                   where de.document_id = x.id and e.kind = 'person' limit 3) q),
        'rank', x.rank, 'best_page', x.best_page,
        'snippet', case when coalesce(array_length(qn, 1), 0) > 0 then (
          select substr(pg.text, greatest(1, pos - 140), 420)
          from public.kh_pages pg, lateral (select coalesce(nullif((select min(nullif(strpos(public.kh_norm(pg.text), w), 0)) from unnest(qn) w), 0), 1) as pos) s
          where pg.document_id = x.id and pg.page_no = coalesce(x.best_page, 1)) end)
      order by x.ord) from page x), '[]'::jsonb),
    'facets', case when coalesce((p ->> 'facets')::boolean, true) then jsonb_build_object(
      'doc_type', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc) from
                   (select doc_type k, count(*) c from docs where doc_type is not null group by doc_type) z), '[]'::jsonb),
      'category', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c)) from
                   (select category_id k, count(*) c from docs where category_id is not null group by category_id) z), '[]'::jsonb),
      'year', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by k desc) from
                   (select coalesce(extract(year from doc_date)::int, public.kh_ay_year(academic_year)) k, count(*) c from docs
                    where coalesce(extract(year from doc_date)::int, public.kh_ay_year(academic_year)) is not null group by 1) z), '[]'::jsonb),
      'language', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc) from
                   (select unnest(languages) k, count(*) c from docs group by 1) z), '[]'::jsonb),
      'person', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'name', nm, 'count', c) order by c desc) from
                   (select e.id k, e.name nm, count(distinct de.document_id) c from docs join public.kh_doc_entities de on de.document_id = docs.id
                    join public.kh_entities e on e.id = de.entity_id where e.kind = 'person' group by e.id, e.name order by 3 desc limit 15) z), '[]'::jsonb),
      'location', coalesce((select jsonb_agg(jsonb_build_object('key', k, 'name', nm, 'count', c) order by c desc) from
                   (select l.id k, l.name nm, count(*) c from docs join public.kh_locations l on l.id = docs.original_location_id group by l.id, l.name) z), '[]'::jsonb))
    end,
    'suggestions', case when mode = 'fuzzy' and q is not null then coalesce((select jsonb_agg(s) from (
        select distinct on (s) s from (
          select e.name as s, word_similarity(public.kh_norm(q), a) as w from public.kh_entities e, unnest(e.aliases) a
          where e.owner_id = auth.uid() and e.merged_into is null
          union all
          select c.name_ar, word_similarity(public.kh_norm(q), public.kh_norm(c.name_ar)) from public.kh_categories c where c.owner_id = auth.uid() and not c.archived
        ) z where w >= 0.35 order by s, w desc limit 5) y), '[]'::jsonb) end)
  into result;
  return result;
end $$;

-- ------------------------------------------------------------------ API: overview, deadlines, backup
create or replace function public.kh_overview(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'documents', (select count(*) from public.kh_documents where owner_id = auth.uid() and deleted_at is null),
    'pages', (select coalesce(sum(page_count), 0) from public.kh_documents where owner_id = auth.uid() and deleted_at is null),
    'people', (select count(*) from public.kh_entities where owner_id = auth.uid() and kind = 'person' and merged_into is null),
    'categories', (select count(*) from public.kh_categories where owner_id = auth.uid() and not archived),
    'locations', (select count(*) from public.kh_locations where owner_id = auth.uid()),
    'duplicates_avoided', (select count(*) from public.kh_audit where owner_id = auth.uid() and action = 'duplicate_skipped'),
    'by_type', coalesce((select jsonb_object_agg(doc_type, c) from (select doc_type, count(*) c from public.kh_documents
                 where owner_id = auth.uid() and deleted_at is null and doc_type is not null group by doc_type) z), '{}'::jsonb),
    'deadlines', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'due_date', x.due_date, 'title', x.title, 'kind', x.kind,
                   'document_id', x.document_id) order by x.due_date) from public.kh_deadlines x
                 join public.kh_documents d on d.id = x.document_id and d.deleted_at is null
                 where x.owner_id = auth.uid() and not x.done and x.due_date <= current_date + 180 and x.due_date >= current_date - 30), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(z) from (select jsonb_build_object('id', d.id, 'title', coalesce(d.title_ar, d.title, d.file_name),
                   'doc_type', d.doc_type, 'state', d.state, 'created_at', d.created_at, 'page_count', d.page_count,
                   'category_path', public.kh_category_path(d.category_id),
                   'thumb', (select f.path from public.kh_files f where f.document_id = d.id and f.role = 'thumb' limit 1)) z
                 from public.kh_documents d where d.owner_id = auth.uid() and d.deleted_at is null order by d.created_at desc limit 12) q), '[]'::jsonb))
$$;

create or replace function public.kh_deadline_done(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  update public.kh_deadlines set done = coalesce((p ->> 'done')::boolean, true) where id = public.kh_uuid(p ->> 'id');
  return jsonb_build_object('ok', true);
end $$;

-- the deadline radar: every deadline the caller may see (a closed vault hides its documents' ones)
create or replace function public.kh_deadlines_list(p jsonb default '{}') returns jsonb
language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'due_date', x.due_date, 'title', x.title, 'kind', x.kind, 'done', x.done,
      'document_id', x.document_id, 'doc_title', coalesce(d.title_ar, d.title, d.file_name), 'doc_type', d.doc_type,
      'vault', coalesce(d.sensitivity = 'vault', false)) order by x.done, x.due_date), '[]'::jsonb)
  from public.kh_deadlines x left join public.kh_documents d on d.id = x.document_id
  where x.owner_id = auth.uid() and (x.document_id is null or d.deleted_at is null)
    and (coalesce((p ->> 'with_done')::boolean, false) or not x.done)
$$;

-- what the phone reminders (Google Calendar) are made of: every open deadline, the vault's included,
-- but those without their title or their document's (a lock screen must not show them). SECURITY
-- DEFINER so a closed vault does not delete its reminders; only the caller's own rows.
create or replace function public.kh_reminders_source(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'due_date', x.due_date, 'kind', x.kind,
      'title', case when d.sensitivity = 'vault' then null else x.title end,
      'document_id', x.document_id,
      'doc_title', case when d.sensitivity = 'vault' then null else coalesce(d.title_ar, d.title, d.file_name) end,
      'vault', coalesce(d.sensitivity = 'vault', false)) order by x.due_date), '[]'::jsonb)
  from public.kh_deadlines x left join public.kh_documents d on d.id = x.document_id
  where x.owner_id = auth.uid() and not x.done and (x.document_id is null or d.deleted_at is null)
$$;

-- a deadline added by the owner (with or without a document); the same one twice is one row
create or replace function public.kh_deadline_add(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare did uuid := public.kh_uuid(p ->> 'document_id'); due date := public.kh_date(p ->> 'due_date');
        t text := nullif(btrim(coalesce(p ->> 'title', '')), ''); k text := coalesce(nullif(p ->> 'kind', ''), 'reminder'); nid uuid;
begin
  if due is null or t is null then raise exception 'a title and a date are needed'; end if;
  if k not in ('expiry', 'action', 'reminder') then k := 'reminder'; end if;
  nid := public.kh_key_uuid('deadline|' || coalesce(did::text, 'none') || '|' || k || '|' || due::text || case when did is null then '|' || t else '' end);
  insert into public.kh_deadlines (id, document_id, kind, due_date, title) values (nid, did, k, due, left(t, 300))
  on conflict (id) do update set title = excluded.title, done = false;
  return jsonb_build_object('id', nid);
end $$;

create or replace function public.kh_deadline_delete(p jsonb) returns jsonb
language plpgsql set search_path = public, extensions as $$
begin
  delete from public.kh_deadlines where id = public.kh_uuid(p ->> 'id') and owner_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- a full copy of the owner's rows (files are copied by the app); used for backups and moving to the cloud
create or replace function public.kh_export(p jsonb default '{}') returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare r jsonb := '{}'; t text;
begin
  foreach t in array array['kh_categories','kh_locations','kh_sessions','kh_proposals','kh_documents','kh_files','kh_pages','kh_lsh','kh_links',
    'kh_entities','kh_doc_entities','kh_reviews','kh_rejections','kh_corrections','kh_deadlines','kh_settings','kh_collections','kh_collection_docs'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x) - ''search'' - ''owner_id''), ''[]''::jsonb) from public.%I x where x.owner_id = auth.uid()', t)
      into strict p;
    r := r || jsonb_build_object(t, p);
  end loop;
  return jsonb_build_object('format', 'khizana-backup', 'version', 1, 'exported_at', now(), 'tables', r);
end $$;

-- restore / move: rows keep their ids; what already exists is left untouched.
-- SECURITY DEFINER so a restore also brings back the vault (and keeps it searchable) without the
-- second factor; every row is forced to the caller, and a row pointing at a document that is not
-- the caller's (or not in the backup) is skipped.
create or replace function public.kh_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t text; n int := 0; total int := 0; tb jsonb := coalesce(p -> 'tables', '{}'); cond text;
  mine constant text := 'exists (select 1 from public.kh_documents d where d.id = public.kh_uuid(x ->> %L) and d.owner_id = auth.uid())';
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if coalesce(p ->> 'format', '') <> 'khizana-backup' then raise exception 'not a khizana backup'; end if;
  -- categories and entities point to themselves: parents first, then the rest
  foreach t in array array['kh_categories','kh_locations','kh_sessions','kh_proposals','kh_documents','kh_files','kh_pages','kh_lsh','kh_links',
    'kh_entities','kh_doc_entities','kh_reviews','kh_rejections','kh_corrections','kh_deadlines','kh_settings','kh_collections','kh_collection_docs'] loop
    if t in ('kh_categories', 'kh_entities', 'kh_locations') then
      execute format($q$
        with recursive src as (select * from jsonb_populate_recordset(null::public.%1$I, $1)),
        ordered as (
          select s.*, 0 as lvl from src s where s.%2$I is null or not exists (select 1 from src s2 where s2.id = s.%2$I)
          union all
          select s.*, o.lvl + 1 from src s join ordered o on s.%2$I = o.id where o.lvl < 20)
        insert into public.%1$I overriding system value
        select (jsonb_populate_record(null::public.%1$I, to_jsonb(o) - 'lvl' || jsonb_build_object('owner_id', auth.uid()))).*
        from ordered o order by lvl on conflict do nothing$q$, t, case t when 'kh_entities' then 'merged_into' else 'parent_id' end)
      using public.kh_arr(tb -> t);
    elsif t = 'kh_corrections' then
      -- fresh ids (the identity sequence keeps working); the same correction is never added twice
      insert into public.kh_corrections (owner_id, document_id, field, old_value, new_value, created_at)
      select auth.uid(), public.kh_uuid(x ->> 'document_id'), x ->> 'field', x -> 'old_value', x -> 'new_value', coalesce((x ->> 'created_at')::timestamptz, now())
      from jsonb_array_elements(public.kh_arr(tb -> t)) x
      where exists (select 1 from public.kh_documents d where d.id = public.kh_uuid(x ->> 'document_id') and d.owner_id = auth.uid())
        and not exists (select 1 from public.kh_corrections c where c.owner_id = auth.uid() and c.document_id = public.kh_uuid(x ->> 'document_id')
                        and c.field = x ->> 'field' and c.created_at = (x ->> 'created_at')::timestamptz);
    else
      cond := case t
        when 'kh_files' then format(mine, 'document_id')
        when 'kh_pages' then format(mine, 'document_id')
        when 'kh_lsh' then format(mine, 'document_id')
        when 'kh_deadlines' then format(mine, 'document_id')
        when 'kh_links' then format(mine, 'from_id') || ' and ' || format(mine, 'to_id')
        when 'kh_doc_entities' then format(mine, 'document_id') || ' and exists (select 1 from public.kh_entities e where e.id = public.kh_uuid(x ->> ''entity_id'') and e.owner_id = auth.uid())'
        when 'kh_reviews' then '(x ->> ''document_id'' is null or ' || format(mine, 'document_id') || ')'
        when 'kh_collection_docs' then format(mine, 'document_id') || ' and exists (select 1 from public.kh_collections c where c.id = public.kh_uuid(x ->> ''collection_id'') and c.owner_id = auth.uid())'
        else 'true' end;
      execute format('insert into public.%1$I overriding system value select (jsonb_populate_record(null::public.%1$I, x || jsonb_build_object(''owner_id'', auth.uid()))).*
                      from jsonb_array_elements($1) x where %2$s on conflict do nothing', t, cond)
      using public.kh_arr(tb -> t);
    end if;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  perform public.kh_reindex(d.id) from public.kh_documents d where d.owner_id = auth.uid() and d.search is null;
  return jsonb_build_object('ok', true, 'rows', total);
end $$;

-- the vault: how many documents are hidden until the second factor is entered
create or replace function public.kh_vault_count(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('count', (select count(*) from public.kh_documents where owner_id = auth.uid() and sensitivity = 'vault' and deleted_at is null))
$$;

-- ------------------------------------------------------------------ privileges: the app (signed in) only
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'kh\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
