insert into tenants (id, monday_account_id, region, plan, seats, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'demo-account', 'us-east-1', 'starter', 5, now())
on conflict (monday_account_id) do nothing;

insert into entitlements (tenant_id, plan, seats, raw, updated_at)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'starter',
    5,
    jsonb_build_object(
      'source', 'seed',
      'features', jsonb_build_object(
        'fuzzyMatching', false,
        'schedules', true,
        'apiAccess', false
      )
    ),
    now()
  )
on conflict (tenant_id) do nothing;

insert into recipes (id, tenant_id, name, version, json, created_at)
values
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'CRM Contacts',
    1,
    jsonb_build_object(
      'id', 'crm',
      'name', 'CRM Contacts',
      'version', 1,
      'steps', jsonb_build_array(
        jsonb_build_object(
          'type', 'map_columns',
          'config', jsonb_build_object(
            'mapping', jsonb_build_object(
              'FirstName', 'first_name',
              'LastName', 'last_name',
              'Email', 'email'
            )
          )
        ),
        jsonb_build_object(
          'type', 'write_back',
          'config', jsonb_build_object(
            'strategy', 'monday_upsert',
            'keyColumn', 'email'
          )
        )
      )
    ),
    now()
  )
on conflict (id) do nothing;
