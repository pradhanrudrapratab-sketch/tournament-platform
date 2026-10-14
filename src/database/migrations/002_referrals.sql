ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by BIGINT REFERENCES users(id);
UPDATE users SET referral_code = upper(substr(md5(id::text || 'crown-arena'), 1, 8)) WHERE referral_code IS NULL;
CREATE UNIQUE INDEX users_referral_code_uq ON users (referral_code);

CREATE TABLE referrals (
  id BIGSERIAL PRIMARY KEY,
  referrer_id BIGINT NOT NULL REFERENCES users(id),
  referred_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','void')),
  referrer_reward_paise BIGINT,
  referee_reward_paise BIGINT,
  qualifying_registration_id BIGINT REFERENCES registrations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rewarded_at TIMESTAMPTZ,
  CHECK (referrer_id <> referred_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_id);
