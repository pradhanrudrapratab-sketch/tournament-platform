-- All money is integer paise. Timestamps are UTC (timestamptz).

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  firebase_uid TEXT NOT NULL UNIQUE,
  username TEXT,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','host','super_admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  suspended_at TIMESTAMPTZ,
  suspension_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_username_uq ON users (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE games (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  creation_enabled BOOLEAN NOT NULL DEFAULT true,
  coming_soon BOOLEAN NOT NULL DEFAULT false,
  display_order INT NOT NULL DEFAULT 0
);
INSERT INTO games (slug, name, enabled, coming_soon, display_order) VALUES
  ('minecraft', 'Minecraft', true, false, 1),
  ('free-fire', 'Free Fire', true, false, 2),
  ('bgmi', 'BGMI', false, true, 3);

CREATE TABLE host_game_permissions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  game_id INT NOT NULL REFERENCES games(id),
  publish_policy TEXT NOT NULL DEFAULT 'approval' CHECK (publish_policy IN ('direct','approval')),
  can_manage_results BOOLEAN NOT NULL DEFAULT false,
  can_finalize_results BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_id)
);

CREATE TABLE tournaments (
  id BIGSERIAL PRIMARY KEY,
  game_id INT NOT NULL REFERENCES games(id),
  host_id BIGINT NOT NULL REFERENCES users(id),
  host_limited BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL,
  description TEXT,
  format TEXT NOT NULL DEFAULT 'solo',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','published','registration_closed','full','scheduled','live','pending_result','completed','cancelled')),
  approval_requested BOOLEAN NOT NULL DEFAULT false,
  entry_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee_paise >= 0),
  prize_pool_paise BIGINT NOT NULL DEFAULT 0 CHECK (prize_pool_paise >= 0),
  capacity INT NOT NULL CHECK (capacity > 0),
  registration_opens_at TIMESTAMPTZ,
  registration_closes_at TIMESTAMPTZ,
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  room_id_enc TEXT,
  room_password_enc TEXT,
  reveal_offset_seconds INT,
  rules TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active tournament per regular host, enforced by the database.
CREATE UNIQUE INDEX one_active_tournament_per_host ON tournaments (host_id)
  WHERE host_limited AND status IN ('published','registration_closed','full','scheduled','live','pending_result');
CREATE INDEX tournaments_status_start_idx ON tournaments (status, scheduled_start_at);

CREATE TABLE registrations (
  id BIGSERIAL PRIMARY KEY,
  tournament_id BIGINT NOT NULL REFERENCES tournaments(id),
  player_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('reserved','confirmed','absent','cancelled','expired','refunded')),
  slot_number INT NOT NULL,
  entry_fee_paise BIGINT NOT NULL CHECK (entry_fee_paise >= 0),
  payment_method TEXT CHECK (payment_method IN ('wallet','gateway','free')),
  order_id TEXT,
  resale_id BIGINT,
  reservation_expires_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX reg_active_player_uq ON registrations (tournament_id, player_id) WHERE status IN ('reserved','confirmed');
CREATE UNIQUE INDEX reg_active_slot_uq ON registrations (tournament_id, slot_number) WHERE status IN ('reserved','confirmed');
CREATE INDEX reg_player_idx ON registrations (player_id);

CREATE TABLE slot_resales (
  id BIGSERIAL PRIMARY KEY,
  tournament_id BIGINT NOT NULL REFERENCES tournaments(id),
  slot_number INT NOT NULL,
  original_registration_id BIGINT NOT NULL REFERENCES registrations(id),
  replacement_registration_id BIGINT REFERENCES registrations(id),
  resale_number INT NOT NULL CHECK (resale_number BETWEEN 1 AND 2),
  original_entry_fee_paise BIGINT NOT NULL,
  resale_price_paise BIGINT NOT NULL CHECK (resale_price_paise >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','assigned','cancelled')),
  confirmed_absent_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  CHECK (resale_price_paise < original_entry_fee_paise),
  UNIQUE (tournament_id, slot_number, resale_number)
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('deposit','entry')),
  reference_id BIGINT,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','success','failed','expired')),
  payment_url TEXT,
  qr_url TEXT,
  provider_order_id TEXT UNIQUE,
  note TEXT,
  check_count INT NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_check_idx ON orders (next_check_at) WHERE status IN ('pending','processing');
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);

CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  provider TEXT NOT NULL,
  provider_transaction_id TEXT,
  amount_paise BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verification_source TEXT NOT NULL,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_one_success_per_order ON payments (order_id) WHERE status = 'success';

CREATE TABLE payment_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  provider_order_id TEXT,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL CHECK (account_type IN ('deposit','winnings')),
  currency TEXT NOT NULL DEFAULT 'INR',
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_type)
);

CREATE TABLE wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  wallet_account_id BIGINT NOT NULL REFERENCES wallet_accounts(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  balance_after_paise BIGINT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_tx_user_idx ON wallet_transactions (user_id, id DESC);

CREATE TABLE withdrawal_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  requested_amount_paise BIGINT NOT NULL CHECK (requested_amount_paise > 0),
  fee_paise BIGINT NOT NULL CHECK (fee_paise >= 0),
  net_payout_paise BIGINT NOT NULL CHECK (net_payout_paise >= 0),
  fee_bps INT NOT NULL,
  payout_upi TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','approved','processing','success','rejected','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  approved_by BIGINT REFERENCES users(id),
  payout_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (requested_amount_paise = fee_paise + net_payout_paise)
);
CREATE INDEX withdrawals_status_idx ON withdrawal_requests (status, created_at);

CREATE TABLE tournament_results (
  id BIGSERIAL PRIMARY KEY,
  tournament_id BIGINT NOT NULL UNIQUE REFERENCES tournaments(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','finalized')),
  submitted_by BIGINT NOT NULL REFERENCES users(id),
  confirmed_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE TABLE result_entries (
  id BIGSERIAL PRIMARY KEY,
  result_id BIGINT NOT NULL REFERENCES tournament_results(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES users(id),
  registration_id BIGINT NOT NULL REFERENCES registrations(id),
  placement INT NOT NULL CHECK (placement >= 1),
  prize_paise BIGINT NOT NULL DEFAULT 0 CHECK (prize_paise >= 0),
  UNIQUE (result_id, player_id)
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
