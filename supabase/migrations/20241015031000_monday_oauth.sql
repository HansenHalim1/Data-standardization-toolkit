create table if not exists monday_oauth_tokens (
  id bigserial primary key,
  account_id bigint not null,
  user_id bigint not null,
  access_token text not null,
  scopes text[] not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (account_id, user_id)
);

create index if not exists monday_oauth_tokens_account_id_idx on monday_oauth_tokens (account_id);
create index if not exists monday_oauth_tokens_user_id_idx on monday_oauth_tokens (user_id);
