-- RetailMind AI — 0006: warehouse team, order fulfilment, packing lists.
--
-- Additive only. It adds one role, a set of nullable columns, three new tables
-- and their policies. It drops nothing, changes no existing policy, and is safe
-- to run twice and safe to run on a live project.
--
-- Run in the Supabase SQL editor, or: supabase db push

-- ---------------------------------------------------------------- warehouse role
--
-- The store manager -> warehouse workflow needs an account type that is not a
-- store manager (so it is not scoped to one store) and not an admin (so it
-- cannot edit the catalogue). `has_store_access` already returns true for any
-- role other than store_manager, so the warehouse team sees every store's
-- orders without touching that function.

insert into roles (id, name, description) values
  (5, 'warehouse', 'Warehouse team: receives, picks, packs and ships store orders')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description;

-- ---------------------------------------------------------------- store address
--
-- The packing list and the order email both need somewhere to deliver to.
-- `location` already exists and is free text; `address` is the postal address
-- printed on the packing list.

alter table stores add column if not exists address        text;
alter table stores add column if not exists contact_phone  text;

comment on column stores.address is 'Delivery address printed on packing lists and order emails.';

-- ---------------------------------------------------------------- fulfilment
--
-- `purchase_orders.status` is the commercial state (draft -> approved ->
-- received) and is left exactly as it was. Fulfilment is a separate axis owned
-- by the warehouse: pending -> accepted -> picking -> packing -> packed ->
-- shipped -> delivered. Keeping them apart means nothing that already reads
-- `status` changes behaviour.

alter table purchase_orders add column if not exists fulfillment_status text not null default 'pending';
alter table purchase_orders add column if not exists order_source       text not null default 'internal';
alter table purchase_orders add column if not exists accepted_by        uuid references profiles(id) on delete set null;
alter table purchase_orders add column if not exists accepted_at        timestamptz;
alter table purchase_orders add column if not exists packed_by          uuid references profiles(id) on delete set null;
alter table purchase_orders add column if not exists packed_at          timestamptz;
alter table purchase_orders add column if not exists shipped_at         timestamptz;
alter table purchase_orders add column if not exists delivered_at       timestamptz;
alter table purchase_orders add column if not exists tracking_number    text;
alter table purchase_orders add column if not exists carrier            text;
alter table purchase_orders add column if not exists warehouse_notes    text;
alter table purchase_orders add column if not exists delivery_address   text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_fulfillment_status_check') then
    alter table purchase_orders add constraint purchase_orders_fulfillment_status_check
      check (fulfillment_status in ('pending','accepted','picking','packing',
                                    'packed','shipped','delivered','cancelled'));
  end if;
end $$;

comment on column purchase_orders.fulfillment_status is
  'Warehouse pipeline state. Independent of purchase_orders.status.';
comment on column purchase_orders.order_source is
  'store = raised by a store manager from the ordering catalogue; internal = replenishment/import.';

create index if not exists po_fulfilment_idx on purchase_orders (fulfillment_status, created_at desc);
create index if not exists po_requested_by_idx on purchase_orders (requested_by, created_at desc);

-- ---------------------------------------------------------------- order events
--
-- One row per status change, so the store manager's tracking view is a real
-- history rather than a single current value.

create table if not exists order_events (
  id          bigserial primary key,
  order_id    uuid not null references purchase_orders(id) on delete cascade,
  kind        text not null default 'fulfillment',   -- fulfillment | status | note
  from_state  text,
  to_state    text,
  note        text,
  actor_id    uuid references profiles(id) on delete set null,
  actor_name  text,
  created_at  timestamptz not null default now()
);
create index if not exists order_events_order_idx on order_events (order_id, created_at desc);

-- ---------------------------------------------------------------- packing lists

create table if not exists packing_lists (
  id            uuid primary key default uuid_generate_v4(),
  order_id      uuid not null references purchase_orders(id) on delete cascade,
  packing_number text not null unique,
  store_id      uuid references stores(id) on delete set null,
  store_name    text,
  store_address text,
  store_manager text,
  packed_by     uuid references profiles(id) on delete set null,
  packed_by_name text,
  packing_date  date not null default current_date,
  total_lines   integer not null default 0,
  total_units   numeric(14,2) not null default 0,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists packing_lists_order_idx on packing_lists (order_id, created_at desc);

create table if not exists packing_list_items (
  id              uuid primary key default uuid_generate_v4(),
  packing_list_id uuid not null references packing_lists(id) on delete cascade,
  product_id      uuid references products(id) on delete set null,
  sku             text,
  product_name    text,
  image_url       text,
  mrp             numeric(12,2),
  quantity        numeric(14,2) not null default 0,
  packed_quantity numeric(14,2) not null default 0
);
create index if not exists packing_list_items_idx on packing_list_items (packing_list_id);

-- ---------------------------------------------------------------- warehouse settings
--
-- Configurable warehouse recipients. Never a hard-coded personal address: the
-- backend reads this key first, then stores.notification_email, then the
-- ORDER_NOTIFICATION_EMAILS environment variable.

insert into system_settings (key, value, description) values
  ('warehouse.notification_email', 'null',
   'Comma-separated warehouse team address(es) that receive new store orders'),
  ('warehouse.name', '"Central Warehouse"', 'Warehouse name printed on packing lists'),
  ('warehouse.address', 'null', 'Warehouse address printed on packing lists')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- RLS
--
-- The warehouse team reads every order and may update the fulfilment columns.
-- A store manager reads and writes events only for their own stores' orders.
-- Every write the app performs goes through the backend service-role key after
-- an explicit role check, so these policies govern direct client access.

alter table order_events       enable row level security;
alter table packing_lists      enable row level security;
alter table packing_list_items enable row level security;

drop policy if exists read_order_events on order_events;
create policy read_order_events on order_events for select to authenticated
  using (exists (select 1 from purchase_orders o
                 where o.id = order_id and has_store_access(o.store_id)));

drop policy if exists write_order_events on order_events;
create policy write_order_events on order_events for insert to authenticated
  with check (auth_role() in ('super_admin','admin','inventory_manager','warehouse'));

drop policy if exists read_packing_lists on packing_lists;
create policy read_packing_lists on packing_lists for select to authenticated
  using (exists (select 1 from purchase_orders o
                 where o.id = order_id and has_store_access(o.store_id)));

drop policy if exists write_packing_lists on packing_lists;
create policy write_packing_lists on packing_lists for all to authenticated
  using (auth_role() in ('super_admin','admin','warehouse'))
  with check (auth_role() in ('super_admin','admin','warehouse'));

drop policy if exists read_packing_list_items on packing_list_items;
create policy read_packing_list_items on packing_list_items for select to authenticated
  using (exists (select 1 from packing_lists p
                 join purchase_orders o on o.id = p.order_id
                 where p.id = packing_list_id and has_store_access(o.store_id)));

drop policy if exists write_packing_list_items on packing_list_items;
create policy write_packing_list_items on packing_list_items for all to authenticated
  using (auth_role() in ('super_admin','admin','warehouse'))
  with check (auth_role() in ('super_admin','admin','warehouse'));

-- The warehouse team must be able to move an order through the pipeline.
-- 0002 restricted purchase_orders writes to staff; this widens it to include
-- the warehouse role without loosening anything else.
drop policy if exists warehouse_update_orders on purchase_orders;
create policy warehouse_update_orders on purchase_orders for update to authenticated
  using (auth_role() = 'warehouse') with check (auth_role() = 'warehouse');

-- ---------------------------------------------------------------- store sales import
--
-- 03_sales_history is store-level daily takings, not SKU-level sales, so it
-- needs its own import type rather than being forced through `sales`.

do $$
begin
  if not exists (select 1 from pg_enum
                 where enumtypid = 'import_type'::regtype
                   and enumlabel = 'store_sales') then
    alter type import_type add value 'store_sales';
  end if;
end $$;

-- ---------------------------------------------------------------- backfill
--
-- Existing orders predate the fulfilment axis. Anything already received is
-- delivered; anything in transit is shipped; everything else starts pending.

update purchase_orders set fulfillment_status = 'delivered'
  where status = 'received' and fulfillment_status = 'pending';
update purchase_orders set fulfillment_status = 'shipped'
  where status in ('in_transit','partially_received') and fulfillment_status = 'pending';
update purchase_orders set fulfillment_status = 'cancelled'
  where status in ('cancelled','rejected') and fulfillment_status = 'pending';
