-- RetailMind AI — 0005: product quantity settings, order notifications,
-- orders import, and reproducible storage buckets.
--
-- Additive only. It adds nullable columns, one new import_type enum value and
-- three storage buckets. It drops nothing and changes no existing policy.
-- Safe to run on a live project and safe to run twice.

-- ---------------------------------------------------------------- product quantity settings
--
-- Per-product overrides for the quantity-related thresholds the engine would
-- otherwise derive from global settings. NULL = fall back to the derived value,
-- so a project that never touches these behaves exactly as before. When a
-- product's quantity is edited (e.g. 170 -> 10) the inventory status, low stock
-- alerts, dashboard KPIs, AI insights and replenishment recommendations all
-- update automatically, because every one of those screens is computed from
-- these values + the live stock in the `inventory` table.

alter table products add column if not exists low_stock_threshold numeric(14,2);
alter table products add column if not exists reorder_point      numeric(14,2);
alter table products add column if not exists safety_stock       numeric(14,2);
alter table products add column if not exists target_stock       numeric(14,2);

comment on column products.low_stock_threshold is 'Units at or below which the product is flagged low stock. NULL = derived from global settings.';
comment on column products.reorder_point      is 'Stock level that triggers a replenishment recommendation. NULL = derived.';
comment on column products.safety_stock       is 'Extra units held to absorb demand and lead-time variability. NULL = derived.';
comment on column products.target_stock       is 'Optional maximum/target stock for this product. NULL = not set.';

-- ---------------------------------------------------------------- store notification email
--
-- Optional direct address for order notifications for a store. When empty the
-- system falls back to admin/inventory-manager profiles and the
-- ORDER_NOTIFICATION_EMAILS environment variable (see backend/.env.example).

alter table stores add column if not exists notification_email text;

comment on column stores.notification_email is 'Optional email that receives order notifications for this store.';

-- ---------------------------------------------------------------- orders import
--
-- The import wizard accepts purchase orders in addition to products,
-- inventory, sales, suppliers and replenishment.

do $$
begin
  if not exists (select 1 from pg_enum
                 where enumtypid = 'import_type'::regtype
                   and enumlabel = 'orders') then
    alter type import_type add value 'orders';
  end if;
end $$;

-- ---------------------------------------------------------------- storage buckets
--
-- Every bucket the app uses, created here so setup is one SQL script instead
-- of a hunt through docs. The backend also creates these on demand at startup
-- (see app/core/config.py ensure_storage_buckets), so a fresh project works
-- even before migrations are run.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('imports', 'imports', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('website-media', 'website-media', true)
on conflict (id) do nothing;

-- Storage policies (idempotent). Public read on the two public buckets so
-- images render for everyone; writes restricted to the same roles the backend
-- already enforces. The private `imports` bucket is admin-only in both
-- directions — the backend reaches it with the service-role key.
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'product_images_read') then
    create policy product_images_read on storage.objects for select
      using (bucket_id = 'product-images');
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'product_images_write') then
    create policy product_images_write on storage.objects for insert to authenticated
      with check (bucket_id = 'product-images' and is_admin());
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'product_images_update') then
    create policy product_images_update on storage.objects for update to authenticated
      using (bucket_id = 'product-images' and is_admin());
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'product_images_delete') then
    create policy product_images_delete on storage.objects for delete to authenticated
      using (bucket_id = 'product-images' and is_admin());
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'imports_read') then
    create policy imports_read on storage.objects for select to authenticated
      using (bucket_id = 'imports' and is_admin());
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'imports_write') then
    create policy imports_write on storage.objects for insert to authenticated
      with check (bucket_id = 'imports' and is_admin());
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'imports_update') then
    create policy imports_update on storage.objects for update to authenticated
      using (bucket_id = 'imports' and is_admin());
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'imports_delete') then
    create policy imports_delete on storage.objects for delete to authenticated
      using (bucket_id = 'imports' and is_admin());
  end if;

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

-- ---------------------------------------------------------------- order email log
--
-- Best-effort record of manager notification emails. The order itself is the
-- record of truth; if this table is missing the notification still works.

create table if not exists order_email_log (
  id         bigserial primary key,
  order_id   uuid references purchase_orders(id) on delete cascade,
  po_number  text,
  recipients jsonb,
  sent       boolean not null default false,
  error      text,
  created_at timestamptz not null default now()
);

create index if not exists order_email_log_order_idx on order_email_log (order_id, created_at desc);

-- ---------------------------------------------------------------- indexes
--
-- The exports read inventory joined to products and stores; keep those joins
-- cheap on large catalogs.

create index if not exists inventory_product_idx on inventory (product_id);
create index if not exists inventory_store_product_idx on inventory (store_id, product_id);