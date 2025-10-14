create extension if not exists "uuid-ossp";

create table if not exists tenants (
  id uuid primary key,
  monday_account_id text unique not null,
  region text,
  plan text not null default 'free',
  seats int not null default 1,
  updated_at timestamptz
);

create table if not exists entitlements (
  tenant_id uuid primary key references tenants(id),
  plan text not null,
  seats int not null default 1,
  raw jsonb,
  updated_at timestamptz
);

create table if not exists recipes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  version int not null,
  json jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz
);

create table if not exists runs (
  id uuid primary key,
  tenant_id uuid not null,
  recipe_id uuid not null,
  recipe_version int not null,
  status text not null check (status in ('queued','previewing','running','success','failed','canceled')),
  idempotency_key text,
  rows_in bigint,
  rows_out bigint,
  errors jsonb,
  preview jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_by text,
  updated_at timestamptz
);

create table if not exists usage_monthly (
  tenant_id uuid not null,
  month text not null,
  rows_processed bigint not null default 0,
  api_calls bigint not null default 0,
  schedules_run int not null default 0,
  primary key (tenant_id, month)
);

create table if not exists audit (
  id uuid primary key,
  tenant_id uuid not null,
  actor text,
  action text not null,
  entity text,
  entity_id text,
  diff jsonb,
  created_at timestamptz default now()
);

create or replace function increment_usage(
  tenant uuid,
  month text,
  rows bigint,
  api bigint default 0,
  schedules int default 0
) returns usage_monthly
language plpgsql
as $$
declare
  result usage_monthly;
begin
  insert into usage_monthly (tenant_id, month, rows_processed, api_calls, schedules_run)
  values (tenant, month, rows, api, schedules)
  on conflict (tenant_id, month) do update set
    rows_processed = usage_monthly.rows_processed + excluded.rows_processed,
    api_calls = usage_monthly.api_calls + excluded.api_calls,
    schedules_run = usage_monthly.schedules_run + excluded.schedules_run
  returning * into result;

  return result;
end;
$$;
