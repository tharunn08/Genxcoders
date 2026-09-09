-- RetailMind AI — row level security, helpers, triggers

-- ---------------------------------------------------------------- helpers

create or replace function auth_role() returns text
language sql stable security definer set search_path = public as $$
  select r.name from profiles p join roles r on r.id = p.role_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function is_staff() returns boolean
language sql stable as $$
  select auth_role() in ('super_admin','admin','inventory_manager')
$$;

create or replace function is_admin() returns boolean
language sql stable as $$
  select auth_role() in ('super_admin','admin')
$$;

-- Store managers see only assigned stores; everyone else sees all stores.
create or replace function has_store_access(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when auth_role() is null then false
    when auth_role() <> 'store_manager' then true
    else exists (select 1 from user_store_assignments a
                 where a.user_id = auth.uid() and a.store_id = target)
  end
$$;

-- ---------------------------------------------------------------- new user trigger

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, role_id, email_verified)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    coalesce((new.raw_user_meta_data->>'role_id')::smallint, 4),
    new.email_confirmed_at is not null
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Keep profiles.email_verified in step with Supabase's own confirmation state.
create or replace function sync_email_verified() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles
     set email_verified = new.email_confirmed_at is not null,
         email          = new.email,
         updated_at     = now()
   where id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email_confirmed_at, email on auth.users
  for each row execute function sync_email_verified();

-- ---------------------------------------------------------------- updated_at

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger products_touch   before update on products
  for each row execute function touch_updated_at();
create trigger profiles_touch   before update on profiles
  for each row execute function touch_updated_at();
create trigger po_touch         before update on purchase_orders
  for each row execute function touch_updated_at();
create trigger transfers_touch  before update on stock_transfers
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- enable RLS

alter table profiles                      enable row level security;
alter table stores                        enable row level security;
alter table user_store_assignments        enable row level security;
alter table categories                    enable row level security;
alter table subcategories                 enable row level security;
alter table suppliers                     enable row level security;
alter table products                      enable row level security;
alter table product_images                enable row level security;
alter table product_suppliers             enable row level security;
alter table inventory                     enable row level security;
alter table inventory_transactions        enable row level security;
alter table sales                         enable row level security;
alter table store_daily_sales             enable row level security;
alter table forecasts                     enable row level security;
alter table forecast_points               enable row level security;
alter table forecast_factors              enable row level security;
alter table replenishment_recommendations enable row level security;
alter table purchase_orders               enable row level security;
alter table purchase_order_items          enable row level security;
alter table stock_transfers               enable row level security;
alter table stock_transfer_items          enable row level security;
alter table alerts                        enable row level security;
alter table data_imports                  enable row level security;
alter table import_staging_rows           enable row level security;
alter table data_import_errors            enable row level security;
alter table unmatched_records             enable row level security;
alter table system_settings               enable row level security;
alter table audit_logs                    enable row level security;
alter table roles                         enable row level security;

-- ---------------------------------------------------------------- policies

-- Reference data: any signed-in user reads.
create policy read_roles on roles for select to authenticated using (true);
create policy read_categories on categories for select to authenticated using (true);
create policy read_subcategories on subcategories for select to authenticated using (true);
create policy read_products on products for select to authenticated using (true);
create policy read_product_images on product_images for select to authenticated using (true);
create policy read_suppliers on suppliers for select to authenticated using (true);
create policy read_product_suppliers on product_suppliers for select to authenticated using (true);
create policy read_settings on system_settings for select to authenticated using (true);

create policy write_categories on categories for all to authenticated
  using (is_admin()) with check (is_admin());
create policy write_subcategories on subcategories for all to authenticated
  using (is_admin()) with check (is_admin());
create policy write_products on products for all to authenticated
  using (is_admin()) with check (is_admin());
create policy write_product_images on product_images for all to authenticated
  using (is_admin()) with check (is_admin());
create policy write_suppliers on suppliers for all to authenticated
  using (is_staff()) with check (is_staff());
create policy write_product_suppliers on product_suppliers for all to authenticated
  using (is_staff()) with check (is_staff());
create policy write_settings on system_settings for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

-- Profiles: read own, admins read all, super admin writes all.
create policy read_own_profile on profiles for select to authenticated
  using (id = auth.uid() or is_admin());
create policy update_own_profile on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy admin_manage_profiles on profiles for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

create policy read_assignments on user_store_assignments for select to authenticated
  using (user_id = auth.uid() or is_admin());
create policy manage_assignments on user_store_assignments for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

-- Stores: managers see assigned, others see all.
create policy read_stores on stores for select to authenticated
  using (has_store_access(id));
create policy write_stores on stores for all to authenticated
  using (auth_role() = 'super_admin') with check (auth_role() = 'super_admin');

-- Store-scoped operational tables.
create policy read_inventory on inventory for select to authenticated
  using (has_store_access(store_id));
create policy write_inventory on inventory for all to authenticated
  using (is_staff() and has_store_access(store_id))
  with check (is_staff() and has_store_access(store_id));

create policy read_inv_tx on inventory_transactions for select to authenticated
  using (has_store_access(store_id));
create policy write_inv_tx on inventory_transactions for insert to authenticated
  with check (is_staff() and has_store_access(store_id));

create policy read_sales on sales for select to authenticated
  using (has_store_access(store_id));
create policy write_sales on sales for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_store_sales on store_daily_sales for select to authenticated
  using (has_store_access(store_id));
create policy write_store_sales on store_daily_sales for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_forecasts on forecasts for select to authenticated
  using (has_store_access(store_id));
create policy write_forecasts on forecasts for all to authenticated
  using (is_staff()) with check (is_staff());

create policy read_forecast_points on forecast_points for select to authenticated
  using (exists (select 1 from forecasts f
                 where f.id = forecast_id and has_store_access(f.store_id)));
create policy write_forecast_points on forecast_points for all to authenticated
  using (is_staff()) with check (is_staff());

create policy read_forecast_factors on forecast_factors for select to authenticated
  using (exists (select 1 from forecasts f
                 where f.id = forecast_id and has_store_access(f.store_id)));
create policy write_forecast_factors on forecast_factors for all to authenticated
  using (is_staff()) with check (is_staff());

create policy read_recs on replenishment_recommendations for select to authenticated
  using (has_store_access(store_id));
create policy write_recs on replenishment_recommendations for all to authenticated
  using (is_staff()) with check (is_staff());

-- Orders: store managers create and read for their stores; staff approve.
create policy read_orders on purchase_orders for select to authenticated
  using (has_store_access(store_id));
create policy create_orders on purchase_orders for insert to authenticated
  with check (has_store_access(store_id));
create policy update_orders on purchase_orders for update to authenticated
  using (is_staff() or (requested_by = auth.uid() and status = 'draft'))
  with check (is_staff() or (requested_by = auth.uid() and status in ('draft','pending_approval')));

create policy read_order_items on purchase_order_items for select to authenticated
  using (exists (select 1 from purchase_orders o
                 where o.id = purchase_order_id and has_store_access(o.store_id)));
create policy write_order_items on purchase_order_items for all to authenticated
  using (exists (select 1 from purchase_orders o
                 where o.id = purchase_order_id and has_store_access(o.store_id)))
  with check (exists (select 1 from purchase_orders o
                 where o.id = purchase_order_id and has_store_access(o.store_id)));

create policy read_transfers on stock_transfers for select to authenticated
  using (has_store_access(source_store_id) or has_store_access(dest_store_id));
create policy create_transfers on stock_transfers for insert to authenticated
  with check (has_store_access(source_store_id) or has_store_access(dest_store_id));
create policy update_transfers on stock_transfers for update to authenticated
  using (is_staff()) with check (is_staff());

create policy read_transfer_items on stock_transfer_items for select to authenticated
  using (exists (select 1 from stock_transfers t where t.id = transfer_id
                 and (has_store_access(t.source_store_id) or has_store_access(t.dest_store_id))));
create policy write_transfer_items on stock_transfer_items for all to authenticated
  using (exists (select 1 from stock_transfers t where t.id = transfer_id
                 and (has_store_access(t.source_store_id) or has_store_access(t.dest_store_id))))
  with check (exists (select 1 from stock_transfers t where t.id = transfer_id
                 and (has_store_access(t.source_store_id) or has_store_access(t.dest_store_id))));

create policy read_alerts on alerts for select to authenticated
  using (store_id is null or has_store_access(store_id));
create policy update_alerts on alerts for update to authenticated
  using (store_id is null or has_store_access(store_id))
  with check (store_id is null or has_store_access(store_id));
create policy write_alerts on alerts for insert to authenticated
  with check (is_staff());

-- Imports and audit: admin only.
create policy read_imports on data_imports for select to authenticated using (is_admin());
create policy write_imports on data_imports for all to authenticated
  using (is_admin()) with check (is_admin());
create policy rw_staging on import_staging_rows for all to authenticated
  using (is_admin()) with check (is_admin());
create policy rw_import_errors on data_import_errors for all to authenticated
  using (is_admin()) with check (is_admin());
create policy rw_unmatched on unmatched_records for all to authenticated
  using (is_admin()) with check (is_admin());

create policy read_audit on audit_logs for select to authenticated
  using (auth_role() = 'super_admin');

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public)
values ('product-images','product-images', true)
on conflict (id) do nothing;

create policy product_images_read on storage.objects for select
  using (bucket_id = 'product-images');
create policy product_images_write on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and is_admin());
create policy product_images_update on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and is_admin());
create policy product_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and is_admin());
