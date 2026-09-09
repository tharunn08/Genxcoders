-- RetailMind AI — core schema
-- Run in the Supabase SQL editor, or: supabase db push

create extension if not exists "uuid-ossp";
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- enums

create type stock_status   as enum ('out_of_stock','critical','low','healthy','overstock');
create type risk_level     as enum ('low','medium','high','critical');
create type priority_level as enum ('low','medium','high','critical');
create type order_status   as enum ('draft','pending_approval','approved','rejected','ordered',
                                    'in_transit','partially_received','received','cancelled');
create type transfer_status as enum ('draft','pending','approved','rejected','in_transit','received','cancelled');
create type alert_type     as enum ('critical_stockout','low_stock','out_of_stock','overstock',
                                    'demand_surge','supplier_delay','pending_approval','import_error');
create type alert_state    as enum ('open','read','resolved','dismissed');
create type import_type    as enum ('products','inventory','sales','suppliers','replenishment','other');
create type import_status  as enum ('uploaded','profiled','mapped','validated','importing','completed','failed');
create type entity_status  as enum ('active','inactive','archived');

-- ---------------------------------------------------------------- identity

create table roles (
  id          smallint primary key,
  name        text not null unique,
  description text
);

insert into roles (id, name, description) values
  (1,'super_admin','Full system access'),
  (2,'admin','Products, inventory, imports, suppliers, approvals'),
  (3,'inventory_manager','Inventory, replenishment, orders, transfers'),
  (4,'store_manager','Assigned stores only');

-- Mirrors auth.users. Populated by the handle_new_user trigger (0002).
create table profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null unique,
  full_name      text,
  role_id        smallint not null default 4 references roles(id),
  is_active      boolean not null default true,
  email_verified boolean not null default false,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table stores (
  id         uuid primary key default uuid_generate_v4(),
  code       text not null unique,
  name       text not null,
  location   text,
  status     entity_status not null default 'active',
  created_at timestamptz not null default now()
);

create table user_store_assignments (
  user_id  uuid not null references profiles(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  primary key (user_id, store_id)
);

-- ---------------------------------------------------------------- catalog

create table categories (
  id   uuid primary key default uuid_generate_v4(),
  name text not null unique
);

create table subcategories (
  id          uuid primary key default uuid_generate_v4(),
  category_id uuid not null references categories(id) on delete cascade,
  name        text not null,
  unique (category_id, name)
);

create table suppliers (
  id                  uuid primary key default uuid_generate_v4(),
  code                text unique,
  name                text not null,
  contact_email       text,
  contact_phone       text,
  avg_lead_time_days  numeric(6,2) not null default 7,
  status              entity_status not null default 'active',
  created_at          timestamptz not null default now()
);

create table products (
  id             uuid primary key default uuid_generate_v4(),
  sku            text not null unique,
  barcode        text,
  name           text not null,
  category_id    uuid references categories(id) on delete set null,
  subcategory_id uuid references subcategories(id) on delete set null,
  mrp            numeric(12,2),
  cost_price     numeric(12,2),
  image_url      text,
  status         entity_status not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index products_barcode_idx on products (barcode) where barcode is not null;
create index products_name_trgm   on products using gin (name gin_trgm_ops);
create index products_category_idx on products (category_id);

create table product_images (
  id         uuid primary key default uuid_generate_v4(),
  product_id uuid not null references products(id) on delete cascade,
  url        text not null,
  is_primary boolean not null default false,
  source     text not null default 'import',   -- import | upload
  created_at timestamptz not null default now()
);
create index product_images_product_idx on product_images (product_id);

create table product_suppliers (
  product_id     uuid not null references products(id) on delete cascade,
  supplier_id    uuid not null references suppliers(id) on delete cascade,
  lead_time_days numeric(6,2),
  is_primary     boolean not null default true,
  primary key (product_id, supplier_id)
);

-- ---------------------------------------------------------------- inventory

create table inventory (
  id              uuid primary key default uuid_generate_v4(),
  product_id      uuid not null references products(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  current_stock   numeric(14,2) not null default 0,
  available_stock numeric(14,2) not null default 0,
  warehouse_stock numeric(14,2) not null default 0,
  stock_on_route  numeric(14,2) not null default 0,
  stock_on_order  numeric(14,2) not null default 0,
  inventory_value numeric(16,2),
  updated_at      timestamptz not null default now(),
  unique (product_id, store_id)
);
create index inventory_store_idx on inventory (store_id);

create table inventory_transactions (
  id             uuid primary key default uuid_generate_v4(),
  product_id     uuid not null references products(id) on delete cascade,
  store_id       uuid not null references stores(id) on delete cascade,
  delta          numeric(14,2) not null,
  reason         text not null,          -- import | order_received | transfer_in | transfer_out | manual
  reference_type text,
  reference_id   uuid,
  note           text,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index inv_tx_product_idx on inventory_transactions (product_id, store_id, created_at desc);

-- SKU-level sales. Aggregate store sales live in store_daily_sales.
create table sales (
  id            uuid primary key default uuid_generate_v4(),
  product_id    uuid not null references products(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  sale_date     date not null,
  quantity_sold numeric(14,2) not null default 0,
  sales_amount  numeric(16,2),
  source        text not null default 'import',
  unique (product_id, store_id, sale_date)
);
create index sales_date_idx on sales (sale_date);
create index sales_product_date_idx on sales (product_id, sale_date desc);

create table store_daily_sales (
  id           uuid primary key default uuid_generate_v4(),
  store_id     uuid not null references stores(id) on delete cascade,
  sale_date    date not null,
  total_amount numeric(16,2),
  total_units  numeric(14,2),
  unique (store_id, sale_date)
);

-- ---------------------------------------------------------------- forecasting

create table forecasts (
  id               uuid primary key default uuid_generate_v4(),
  product_id       uuid not null references products(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  horizon_days     smallint not null,
  method           text not null,               -- moving_average | weighted_ma | linear_trend
  basis            text not null,               -- sku_history | store_pattern_derived
  avg_daily_demand numeric(12,3) not null,
  total_forecast   numeric(14,2) not null,
  confidence       numeric(5,2),                -- 0-100
  trend_direction  text,                        -- up | down | flat
  trend_pct        numeric(7,2),
  history_days     smallint,
  generated_at     timestamptz not null default now()
);
create index forecasts_lookup_idx on forecasts (product_id, store_id, generated_at desc);

create table forecast_points (
  id            uuid primary key default uuid_generate_v4(),
  forecast_id   uuid not null references forecasts(id) on delete cascade,
  forecast_date date not null,
  predicted_qty numeric(12,3) not null,
  lower_bound   numeric(12,3),
  upper_bound   numeric(12,3)
);
create index forecast_points_idx on forecast_points (forecast_id, forecast_date);

-- Explainability: one row per contributing factor, derived from real metrics.
create table forecast_factors (
  id          uuid primary key default uuid_generate_v4(),
  forecast_id uuid not null references forecasts(id) on delete cascade,
  factor      text not null,
  impact      text not null,        -- low | medium | high
  direction   text not null,        -- positive | negative | neutral
  detail      text not null,
  weight      numeric(5,2)
);

-- ---------------------------------------------------------------- replenishment

create table replenishment_recommendations (
  id                  uuid primary key default uuid_generate_v4(),
  product_id          uuid not null references products(id) on delete cascade,
  store_id            uuid not null references stores(id) on delete cascade,
  forecast_id         uuid references forecasts(id) on delete set null,
  current_stock       numeric(14,2) not null,
  avg_daily_demand    numeric(12,3) not null,
  forecast_demand     numeric(14,2) not null,
  safety_stock        numeric(14,2) not null,
  lead_time_days      numeric(6,2) not null,
  reorder_point       numeric(14,2) not null,
  recommended_qty     numeric(14,2) not null,
  days_of_stock       numeric(10,2),
  stockout_risk_score numeric(5,2),
  risk               risk_level,
  expected_stockout_date date,
  priority           priority_level not null default 'medium',
  reason             text,
  status             text not null default 'open',  -- open | actioned | dismissed
  generated_at       timestamptz not null default now(),
  unique (product_id, store_id, generated_at)
);
create index replen_open_idx on replenishment_recommendations (store_id, priority, status);

-- ---------------------------------------------------------------- orders

create table purchase_orders (
  id             uuid primary key default uuid_generate_v4(),
  po_number      text not null unique,
  store_id       uuid not null references stores(id),
  supplier_id    uuid references suppliers(id) on delete set null,
  status         order_status not null default 'draft',
  priority       priority_level not null default 'medium',
  requested_by   uuid references profiles(id) on delete set null,
  approved_by    uuid references profiles(id) on delete set null,
  requested_date date not null default current_date,
  expected_date  date,
  received_date  date,
  notes          text,
  rejection_reason text,
  total_value    numeric(16,2),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index po_store_status_idx on purchase_orders (store_id, status);

create table purchase_order_items (
  id                uuid primary key default uuid_generate_v4(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id        uuid not null references products(id),
  recommendation_id uuid references replenishment_recommendations(id) on delete set null,
  quantity          numeric(14,2) not null,
  received_quantity numeric(14,2) not null default 0,
  unit_price        numeric(12,2),
  line_total        numeric(16,2)
);
create index poi_order_idx on purchase_order_items (purchase_order_id);

-- ---------------------------------------------------------------- transfers

create table stock_transfers (
  id             uuid primary key default uuid_generate_v4(),
  transfer_number text not null unique,
  source_store_id uuid not null references stores(id),
  dest_store_id   uuid not null references stores(id),
  status          transfer_status not null default 'draft',
  priority        priority_level not null default 'medium',
  requested_by    uuid references profiles(id) on delete set null,
  approved_by     uuid references profiles(id) on delete set null,
  reason          text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (source_store_id <> dest_store_id)
);

create table stock_transfer_items (
  id                uuid primary key default uuid_generate_v4(),
  transfer_id       uuid not null references stock_transfers(id) on delete cascade,
  product_id        uuid not null references products(id),
  quantity          numeric(14,2) not null,
  received_quantity numeric(14,2) not null default 0
);

-- ---------------------------------------------------------------- alerts

create table alerts (
  id            uuid primary key default uuid_generate_v4(),
  type          alert_type not null,
  priority      priority_level not null default 'medium',
  store_id      uuid references stores(id) on delete cascade,
  product_id    uuid references products(id) on delete cascade,
  title         text not null,
  message       text not null,
  recommended_action text,
  state         alert_state not null default 'open',
  resolved_by   uuid references profiles(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index alerts_feed_idx on alerts (store_id, state, created_at desc);

-- ---------------------------------------------------------------- imports

create table data_imports (
  id             uuid primary key default uuid_generate_v4(),
  filename       text not null,
  file_type      text not null,          -- xlsx | csv | json
  sheet_name     text,
  import_type    import_type not null default 'other',
  status         import_status not null default 'uploaded',
  storage_path   text,
  total_rows     integer not null default 0,
  valid_rows     integer not null default 0,
  invalid_rows   integer not null default 0,
  duplicate_rows integer not null default 0,
  created_count  integer not null default 0,
  updated_count  integer not null default 0,
  skipped_count  integer not null default 0,
  failed_count   integer not null default 0,
  column_mapping jsonb,
  detected_headers jsonb,
  options        jsonb,
  target_store_id uuid references stores(id) on delete set null,
  uploaded_by    uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

-- Raw rows are preserved exactly as uploaded; nothing is deleted on import.
create table import_staging_rows (
  id         bigserial primary key,
  import_id  uuid not null references data_imports(id) on delete cascade,
  row_number integer not null,
  raw        jsonb not null
);
create index staging_import_idx on import_staging_rows (import_id, row_number);

create table data_import_errors (
  id         bigserial primary key,
  import_id  uuid not null references data_imports(id) on delete cascade,
  row_number integer,
  column_name text,
  error_code text not null,
  message    text not null,
  raw        jsonb
);
create index import_errors_idx on data_import_errors (import_id);

-- Rows that could not be matched to a product, queued for admin review.
create table unmatched_records (
  id          uuid primary key default uuid_generate_v4(),
  import_id   uuid not null references data_imports(id) on delete cascade,
  row_number  integer,
  import_type import_type not null,
  raw         jsonb not null,
  candidate_product_id uuid references products(id) on delete set null,
  state       text not null default 'pending',  -- pending | matched | created | ignored
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index unmatched_pending_idx on unmatched_records (state, created_at desc);

-- ---------------------------------------------------------------- system

create table system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

insert into system_settings (key, value, description) values
  ('safety_days',        '5',        'Days of demand held as safety stock'),
  ('safety_method',      '"days"',   'days | percentage | variability'),
  ('safety_percentage',  '20',       'Used when safety_method = percentage'),
  ('service_level_z',    '1.65',     'Z score for variability-based safety stock (95%)'),
  ('default_lead_time',  '7',        'Fallback supplier lead time in days'),
  ('forecast_horizon',   '14',       'Default forecast horizon in days'),
  ('forecast_method',    '"weighted_ma"', 'moving_average | weighted_ma | linear_trend'),
  ('risk_critical_days', '3',        'Days of stock at or below this = critical'),
  ('risk_low_days',      '7',        'Days of stock at or below this = low'),
  ('overstock_days',     '60',       'Days of stock above this = overstock'),
  ('otp_expiry_minutes', '10',       'Email OTP validity window'),
  ('review_period_days', '7',        'Order review cycle used in reorder quantity');

create table audit_logs (
  id          bigserial primary key,
  user_id     uuid references profiles(id) on delete set null,
  user_email  text,
  action      text not null,
  entity_type text,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index audit_recent_idx on audit_logs (created_at desc);
