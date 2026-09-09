-- RetailMind AI — 0004: site administration (branding, media library, announcements).
--
-- Additive only. It creates two new tables, one public storage bucket and a set
-- of branding keys in system_settings. It changes nothing that 0001-0003 made
-- and is safe to run twice.
--
-- Run in the Supabase SQL editor, or: supabase db push

-- ---------------------------------------------------------------- branding
--
-- The design tokens (peach / deep wine / white / ivory) are NOT customizable —
-- they live in the frontend. What a super admin can manage from the panel is
-- text and approved images, stored here as ordinary system_settings rows so the
-- existing GET /api/settings and audit machinery apply unchanged.

insert into system_settings (key, value, description) values
  ('branding.platform_name',            '"RetailMind AI"', 'Platform name shown across the app'),
  ('branding.short_name',               '"RetailMind"', 'Short brand name for tight spaces'),
  ('branding.website_title',            '"RetailMind AI — Predict smarter. Stock smarter. Sell better."', 'Browser tab title'),
  ('branding.website_subtitle',         '"AI-powered retail intelligence and smart inventory platform"', 'Subtitle under the platform name'),
  ('branding.company_name',             '"RetailMind"', 'Company / organisation name'),
  ('branding.support_email',            'null', 'Support email shown on admin pages'),
  ('branding.footer_text',              '"RetailMind AI"', 'Footer text'),
  ('branding.logo_url',                 'null', 'Main website logo (public URL)'),
  ('branding.logo_light_url',           'null', 'Logo for light surfaces'),
  ('branding.logo_dark_url',            'null', 'Logo for dark surfaces'),
  ('branding.favicon_url',              'null', 'Browser favicon'),
  ('branding.login_logo_url',           'null', 'Logo on the sign-in page'),
  ('branding.dashboard_logo_url',       'null', 'Logo in the app sidebar'),
  ('branding.login_welcome_title',      '"Welcome to RetailMind AI"', 'Sign-in page welcome title'),
  ('branding.login_welcome_subtitle',   '"Inventory intelligence for smarter retail decisions."', 'Sign-in page subtitle'),
  ('branding.login_background_url',     'null', 'Optional sign-in page background image'),
  ('branding.login_announcement',       'null', 'Optional notice on the sign-in page'),
  ('branding.dashboard_welcome_title',  'null', 'Optional dashboard welcome title'),
  ('branding.dashboard_welcome_message','null', 'Optional dashboard welcome message'),
  ('branding.dashboard_banner_url',     'null', 'Optional dashboard banner image'),
  ('branding.announcement_banner',      'null', 'Optional global announcement banner text')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- media library

create table if not exists site_media (
  id           uuid primary key default uuid_generate_v4(),
  filename     text not null,
  storage_path text not null,
  url          text not null,
  mime_type    text,
  size_bytes   integer,
  category     text not null default 'general',  -- logo | login | banner | announcement | general
  uploaded_by  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table site_media enable row level security;

drop policy if exists read_site_media on site_media;
create policy read_site_media on site_media for select to authenticated using (true);

drop policy if exists write_site_media on site_media;
create policy write_site_media on site_media for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

-- ---------------------------------------------------------------- announcements

create table if not exists announcements (
  id           uuid primary key default uuid_generate_v4(),
  title        text not null,
  message      text not null,
  image_url    text,
  priority     priority_level not null default 'medium',
  target_roles jsonb,                      -- null = everyone; else array of role names
  start_at     timestamptz,
  end_at       timestamptz,
  is_published boolean not null default false,
  created_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table announcements enable row level security;

drop policy if exists read_announcements on announcements;
create policy read_announcements on announcements for select to authenticated using (true);

drop policy if exists write_announcements on announcements;
create policy write_announcements on announcements for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

drop trigger if exists announcements_touch on announcements;
create trigger announcements_touch before update on announcements
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public)
values ('website-media','website-media', true)
on conflict (id) do nothing;

-- Public read so branding images render for everyone; writes are super admin
-- only. The backend reaches the bucket with the service-role key, so these
-- policies govern any direct client access.
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'website_media_read') then
    create policy website_media_read on storage.objects for select
      using (bucket_id = 'website-media');
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'website_media_write') then
    create policy website_media_write on storage.objects for insert to authenticated
      with check (bucket_id = 'website-media' and auth_role() = 'super_admin');
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'website_media_update') then
    create policy website_media_update on storage.objects for update to authenticated
      using (bucket_id = 'website-media' and auth_role() = 'super_admin');
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'website_media_delete') then
    create policy website_media_delete on storage.objects for delete to authenticated
      using (bucket_id = 'website-media' and auth_role() = 'super_admin');
  end if;
end $$;