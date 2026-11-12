// The Assay: Postgres schema. Applied by src/lib/db/index.ts on first use (idempotent). One file, embedded so it ships in every bundle.
export const SCHEMA_SQL = `

create table if not exists coins (
  mint            text primary key,
  pool_id         text not null unique,
  network         text not null,
  name            text not null,
  symbol          text not null,
  uri             text not null default '',
  image           text,
  description     text,
  socials         jsonb not null default '{}'::jsonb,
  creator         text not null,
  created_at      timestamptz not null,
  create_sig      text,
  decimals        int not null default 6,
  supply          numeric not null,
  total_sell      numeric not null,
  fund_target_lamports numeric not null,
  token_2022      boolean not null default false,
  transfer_fee_bps int not null default 0,
  status          text not null default 'live',        -- live | graduating (curve full) | graduated (on the AMM)
  graduated_at    timestamptz,
  price_sol       double precision not null default 0,
  mcap_sol        double precision not null default 0,
  real_b_lamports numeric not null default 0,
  progress        double precision not null default 0,
  vol_sol         double precision not null default 0,  -- lifetime curve volume
  vol_24h_sol     double precision not null default 0,
  trades          int not null default 0,
  holders         int,
  top10_share     double precision,
  dev_buy_pct     double precision not null default 0,
  initial_buy_sol double precision not null default 0,
  last_trade_at   timestamptz,
  latest_tier     text,
  latest_checkpoint text,
  flagged_at      timestamptz,
  indexed_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists coins_created_idx on coins (created_at desc);
create index if not exists coins_status_idx on coins (status, created_at desc);
alter table coins add column if not exists rewards_checked_at timestamptz; -- last rewards attempt, whatever came of it
alter table coins add column if not exists hidden_at timestamptz;  -- taken down by the operator: not shown anywhere
alter table coins add column if not exists hidden_reason text;

create table if not exists trades (
  sig         text primary key,
  mint        text not null references coins(mint) on delete cascade,
  slot        bigint not null,
  ts          timestamptz not null,
  side        text not null,              -- buy | sell
  wallet      text not null,
  sol_lamports numeric not null,          -- SOL paid (buy) or received (sell)
  token_base   numeric not null,          -- tokens received (buy) or sold (sell), base units
  price_sol    double precision not null,
  referrer     text                       -- caller wallet when a share fee was paid
);
create index if not exists trades_mint_ts_idx on trades (mint, ts);
create index if not exists trades_wallet_idx on trades (wallet);
create index if not exists trades_referrer_idx on trades (referrer) where referrer is not null;

-- One row per sealed reading. The hash chain is global, ordered by seq.
create table if not exists readings (
  seq         bigint primary key,
  t           timestamptz not null,
  mint        text not null references coins(mint) on delete cascade,
  checkpoint  text not null,              -- launch | m1 | m5
  score       double precision not null,
  pct         double precision not null,
  tier        text not null,
  model       text not null,
  pool_n      int not null,
  features    jsonb not null,
  signals     jsonb not null default '[]'::jsonb,
  prev        text not null,
  hash        text not null unique
);
create index if not exists readings_mint_idx on readings (mint, checkpoint);

create table if not exists callers (
  wallet      text primary key,
  code        text not null unique,
  handle      text,
  channel     text,                        -- telegram | x | discord | other
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

create table if not exists rewards (
  id          bigserial primary key,
  mint        text not null references coins(mint) on delete cascade,
  run_at      timestamptz not null default now(),
  withheld_base numeric not null,
  sol_lamports numeric not null,
  holders     int not null,
  sigs        jsonb not null default '[]'::jsonb,
  status      text not null default 'done'
);

create table if not exists kv (
  k text primary key,
  v jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists readings_skipped (
  mint       text not null,
  checkpoint text not null,
  reason     text not null,
  at         timestamptz not null default now(),
  primary key (mint, checkpoint)
);

-- Coin images and metadata JSON when no blob store is configured (small files only; served from /api/files/:id).
create table if not exists files (
  id           text primary key,
  content_type text not null,
  bytes        bytea not null,
  size         int not null,
  created_at   timestamptz not null default now()
);
`;
