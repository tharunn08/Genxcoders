-- RetailMind AI — 0003: fixes found during the import/performance audit.
--
-- Additive only. It creates nothing that 0001 or 0002 already made, drops
-- nothing, and changes no existing policy. Safe to run on a live project, and
-- safe to run twice.

-- ---------------------------------------------------------------- storage

-- 0002 creates the public `product-images` bucket but not `imports`, which was
-- left as a manual step in SUPABASE_SETUP.md. When it was missed, every file
-- upload failed at the storage write *after* the data_imports row had already
-- been inserted — which is why imports appeared to fail intermittently rather
-- than consistently. The backend now creates this bucket on demand as well;
-- this makes it explicit and reproducible.
insert into storage.buckets (id, name, public)
values ('imports', 'imports', false)
on conflict (id) do nothing;

-- Private bucket: admins only, in both directions. The backend reaches it with
-- the service-role key, so these policies govern any direct client access.
do $$
begin
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
end $$;

-- ---------------------------------------------------------------- catalog

-- The product form asks for a description; there was nowhere to put it. The API
-- degrades gracefully if this hasn't been run, but the field only persists once
-- it has.
alter table products add column if not exists description text;

-- ---------------------------------------------------------------- indexes

-- The computation layer now fetches sales for a whole page of products in one
-- query filtered by product_id, store_id and a date window. sales_product_date_idx
-- from 0001 covers (product_id, sale_date); adding store_id lets that query be
-- satisfied by a single index scan rather than a filter on top of one.
create index if not exists sales_product_store_date_idx
  on sales (product_id, store_id, sale_date desc);

-- Same shape for the lead-time lookup, which is now batched by product.
create index if not exists product_suppliers_product_idx
  on product_suppliers (product_id);

-- The inventory board orders by available_stock within a store.
create index if not exists inventory_store_available_idx
  on inventory (store_id, available_stock);

-- Store-level fallback curves are read by store over a date window.
create index if not exists store_daily_sales_store_date_idx
  on store_daily_sales (store_id, sale_date);

-- Products are listed with archived rows excluded and sorted by name.
create index if not exists products_status_name_idx
  on products (status, name);

-- The import wizard reads staging rows and errors by import.
create index if not exists unmatched_import_idx
  on unmatched_records (import_id);

-- ---------------------------------------------------------------- inventory writes
--
-- 0002 already grants inventory writes to is_staff() with store access, which
-- is what the new manual add/edit/adjust endpoints need. Nothing to change —
-- noted here so the permission model is traceable from this file.
