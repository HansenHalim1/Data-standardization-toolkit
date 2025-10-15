drop function if exists increment_usage(uuid, text, bigint, bigint, integer);

drop function if exists increment_usage(uuid, text, bigint, bigint);

drop function if exists increment_usage(uuid, text, bigint);

create function increment_usage(
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
    insert into usage_monthly (tenant_id, "month", rows_processed, api_calls, schedules_run)
    values (tenant, month, rows, api, schedules)
    on conflict (tenant_id, "month") do update set
      rows_processed = usage_monthly.rows_processed + excluded.rows_processed,
      api_calls = usage_monthly.api_calls + excluded.api_calls,
      schedules_run = usage_monthly.schedules_run + excluded.schedules_run
    returning * into result;

    return result;
  end;
  $$;
