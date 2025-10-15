drop function if exists increment_usage(uuid, text, bigint, bigint, integer);

drop function if exists increment_usage(uuid, text, bigint, bigint);

drop function if exists increment_usage(uuid, text, bigint);

create function increment_usage_internal(
    tenant uuid,
    usage_month text,
    rows bigint,
    api bigint default 0,
    schedules int default 0
  ) returns usage_monthly
  language plpgsql
  as $$
  declare
    result usage_monthly;
  begin
    insert into usage_monthly as u (tenant_id, "month", rows_processed, api_calls, schedules_run)
    values (tenant, usage_month, rows, coalesce(api, 0), coalesce(schedules, 0))
    on conflict (tenant_id, "month") do update set
      rows_processed = u.rows_processed + excluded.rows_processed,
      api_calls = u.api_calls + excluded.api_calls,
      schedules_run = u.schedules_run + excluded.schedules_run
    returning * into result;

    return result;
  end;
  $$;

create function increment_usage(
    tenant uuid,
    month text,
    rows bigint,
    api bigint default 0,
    schedules int default 0
  ) returns usage_monthly
  language plpgsql
  as $$
  begin
    return increment_usage_internal(tenant, month, rows, api, schedules);
  end;
  $$;
