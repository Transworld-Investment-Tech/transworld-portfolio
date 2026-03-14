-- ============================================================
-- TRANSWORLD PORTFOLIO INTELLIGENCE — SUPABASE SCHEMA
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS & ROLES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','manager','viewer')),
  firm_name     TEXT DEFAULT 'Transworld Asset Management',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code          TEXT NOT NULL UNIQUE,             -- e.g. 'TWI', 'CLIENT_A'
  name          TEXT NOT NULL,                    -- e.g. 'Transworld Internal', 'Acme Corp'
  type          TEXT DEFAULT 'discretionary'      -- 'discretionary' | 'advisory' | 'internal'
                CHECK (type IN ('discretionary','advisory','internal')),
  contact_name  TEXT,
  contact_email TEXT,
  status        TEXT DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes         TEXT,
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PORTFOLIOS (each client can have multiple, e.g. A/B/C/D)
-- ============================================================
CREATE TABLE portfolios (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,                -- 'A', 'B', 'C', 'D' or custom
  name              TEXT NOT NULL,                -- 'Transworld Portfolio A'
  currency          TEXT DEFAULT 'NGN',
  starting_nav      NUMERIC(20,2) NOT NULL,
  start_date        DATE NOT NULL,
  valuation_date    DATE,
  income_target     NUMERIC(6,4) DEFAULT 0.15,    -- 15%
  cap_target        NUMERIC(6,4) DEFAULT 0.30,    -- 30%
  -- Risk thresholds
  liq_min           NUMERIC(6,4) DEFAULT 0.05,
  dd_alert          NUMERIC(6,4) DEFAULT -0.07,
  dd_action         NUMERIC(6,4) DEFAULT -0.10,
  max_eq_single     NUMERIC(6,4) DEFAULT 0.07,
  max_eq_sleeve     NUMERIC(6,4) DEFAULT 0.35,
  -- Metadata
  status            TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  notes             TEXT,
  created_by        UUID REFERENCES profiles(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, label)
);

-- ============================================================
-- SLEEVE TARGETS (per portfolio)
-- ============================================================
CREATE TABLE sleeve_targets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id  UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  sleeve_id     TEXT NOT NULL,       -- 'liq', 'ntb', 'fgn', 'eq'
  name          TEXT NOT NULL,
  target_pct    NUMERIC(6,4) NOT NULL,
  min_pct       NUMERIC(6,4) NOT NULL,
  max_pct       NUMERIC(6,4) NOT NULL,
  sort_order    INT DEFAULT 0,
  notes         TEXT,
  UNIQUE(portfolio_id, sleeve_id)
);

-- ============================================================
-- INSTRUMENT MASTER (shared across all portfolios)
-- ============================================================
CREATE TABLE instruments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id TEXT NOT NULL UNIQUE,  -- 'UBA', 'NTB_91', 'CASH_NGN'
  name          TEXT NOT NULL,
  sleeve_id     TEXT NOT NULL,
  asset_class   TEXT NOT NULL,         -- 'Cash','Fixed Income','Equity'
  type          TEXT NOT NULL,         -- 'Cash','NTB','Bond','Stock'
  currency      TEXT DEFAULT 'NGN',
  coupon_pct    NUMERIC(8,4) DEFAULT 0,
  coupon_freq   INT DEFAULT 0,
  maturity_date DATE,
  ngx_symbol    TEXT,                  -- e.g. 'NGX:UBA' for Apify
  tv_symbol     TEXT,                  -- TradingView symbol
  approved      BOOLEAN DEFAULT TRUE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PORTFOLIO HOLDINGS (position per instrument per portfolio)
-- ============================================================
CREATE TABLE holdings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id    UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  instrument_id   TEXT NOT NULL REFERENCES instruments(instrument_id),
  quantity        NUMERIC(20,4) DEFAULT 0,
  avg_cost        NUMERIC(20,6) DEFAULT 0,
  sleeve_id       TEXT,
  as_of_date      DATE,
  notes           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(portfolio_id, instrument_id)
);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
CREATE TABLE transactions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id         UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  trade_date           DATE NOT NULL,
  instrument_id        TEXT REFERENCES instruments(instrument_id),
  action               TEXT NOT NULL CHECK (action IN ('BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT')),
  quantity             NUMERIC(20,4),
  price                NUMERIC(20,6),
  amount               NUMERIC(20,2),         -- for INCOME / FEE
  fees                 NUMERIC(20,2) DEFAULT 0,
  gross_value          NUMERIC(20,2),
  income_category      TEXT,                  -- 'Interest','Coupon','Dividend','Other'
  maturity_date        DATE,
  broker               TEXT,
  counterparty         TEXT,
  notes                TEXT,
  created_by           UUID REFERENCES profiles(id),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MARKET PRICES (time-series)
-- ============================================================
CREATE TABLE market_prices (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
  price_date    DATE NOT NULL,
  price         NUMERIC(20,6) NOT NULL,
  day_change    NUMERIC(8,4),            -- % change
  source        TEXT,                    -- 'apify','manual','fmdq','cbn'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(instrument_id, price_date)
);

-- ============================================================
-- NAV LOG (for drawdown, trend tracking)
-- ============================================================
CREATE TABLE nav_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id  UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  nav_date      DATE NOT NULL,
  nav_value     NUMERIC(20,2) NOT NULL,
  notes         TEXT,
  UNIQUE(portfolio_id, nav_date)
);

-- ============================================================
-- AI REPORTS (stored for history)
-- ============================================================
CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id  UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  report_type   TEXT NOT NULL CHECK (report_type IN ('daily','weekly','monthly','quarterly')),
  report_date   DATE NOT NULL,
  content       TEXT NOT NULL,           -- full markdown report text
  model_used    TEXT DEFAULT 'claude-sonnet-4-20250514',
  search_used   BOOLEAN DEFAULT TRUE,
  created_by    UUID REFERENCES profiles(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- API KEYS (encrypted, per firm — DO NOT store plaintext in prod)
-- ============================================================
CREATE TABLE api_config (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_name      TEXT NOT NULL,           -- 'apify', 'anthropic'
  key_value     TEXT NOT NULL,           -- Encrypt in production
  is_active     BOOLEAN DEFAULT TRUE,
  updated_by    UUID REFERENCES profiles(id),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(key_name)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients         ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports         ENABLE ROW LEVEL SECURITY;

-- Profiles: users see own profile
CREATE POLICY "profiles_self" ON profiles FOR ALL USING (auth.uid() = id);

-- Authenticated users can read all business data (tighten per role in production)
CREATE POLICY "clients_auth"        ON clients       FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "portfolios_auth"     ON portfolios    FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "holdings_auth"       ON holdings      FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "transactions_auth"   ON transactions  FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "reports_auth"        ON reports       FOR ALL USING (auth.role() = 'authenticated');

-- Public read on instruments and prices
CREATE POLICY "instruments_read"    ON instruments   FOR SELECT USING (TRUE);
CREATE POLICY "prices_read"         ON market_prices FOR SELECT USING (TRUE);

-- ============================================================
-- SEED — DEFAULT INSTRUMENTS (from Portfolio A Excel)
-- ============================================================
INSERT INTO instruments (instrument_id, name, sleeve_id, asset_class, type, currency, coupon_pct, coupon_freq, ngx_symbol, notes) VALUES
('CASH_NGN',  'Ops Liquidity (NGN)',           'liq', 'Cash',         'Cash',  'NGN', 0,    0, NULL,               'Operational buffer'),
('NTB_91',    'Nigerian Treasury Bill (91D)',   'ntb', 'Fixed Income', 'NTB',   'NGN', 15.80,1, NULL,               'Roll quarterly'),
('NTB_182',   'Nigerian Treasury Bill (182D)',  'ntb', 'Fixed Income', 'NTB',   'NGN', 16.50,1, NULL,               'Roll semi-annually'),
('NTB_364',   'Nigerian Treasury Bill (364D)',  'ntb', 'Fixed Income', 'NTB',   'NGN', 18.47,1, NULL,               'Anchor yield'),
('FGN_5_7',   'FGN Bond Bucket (5–7yr)',        'fgn', 'Fixed Income', 'Bond',  'NGN', 21.50,2, NULL,               '5-7yr benchmark'),
('FGN_10',    'FGN Bond Bucket (~10yr)',         'fgn', 'Fixed Income', 'Bond',  'NGN', 22.50,2, NULL,               '~10yr benchmark'),
('UBA',       'United Bank for Africa',         'eq',  'Equity',       'Stock', 'NGN', 8.20, 1, 'NGX:UBA',          'Dividend bank bucket'),
('GTCO',      'Guaranty Trust Holding Co',      'eq',  'Equity',       'Stock', 'NGN', 6.80, 1, 'NGX:GTCO',         'Dividend bank bucket'),
('ZENITH',    'Zenith Bank',                    'eq',  'Equity',       'Stock', 'NGN', 9.10, 1, 'NGX:ZENITHBANK',   'Dividend bank bucket'),
('DANGCEM',   'Dangote Cement',                 'eq',  'Equity',       'Stock', 'NGN', 4.20, 1, 'NGX:DANGCEM',      'Quality large cap'),
('STANBIC',   'Stanbic IBTC Holdings',          'eq',  'Equity',       'Stock', 'NGN', 5.60, 1, 'NGX:STANBIC',      'Quality large cap'),
('SEPLAT',    'Seplat Energy',                  'eq',  'Equity',       'Stock', 'NGN', 2.10, 1, 'NGX:SEPLAT',       'Quality large cap');

-- Seed initial prices
INSERT INTO market_prices (instrument_id, price_date, price, day_change, source) VALUES
('CASH_NGN',  '2026-03-13', 1,       0,      'manual'),
('NTB_91',    '2026-03-13', 1,       0,      'manual'),
('NTB_182',   '2026-03-13', 1,       0,      'manual'),
('NTB_364',   '2026-03-13', 1,       0,      'manual'),
('FGN_5_7',   '2026-03-13', 1.018,   0.18,   'fmdq'),
('FGN_10',    '2026-03-13', 0.983,  -0.17,   'fmdq'),
('UBA',       '2026-03-13', 27.50,   1.28,   'ngx'),
('GTCO',      '2026-03-13', 58.30,  -0.34,   'ngx'),
('ZENITH',    '2026-03-13', 47.80,   0.84,   'ngx'),
('DANGCEM',   '2026-03-13', 335.00, -1.05,   'ngx'),
('STANBIC',   '2026-03-13', 82.50,   2.31,   'ngx'),
('SEPLAT',    '2026-03-13', 4850,    0.52,   'ngx');

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Auto-update updated_at on portfolios
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER portfolios_updated_at   BEFORE UPDATE ON portfolios   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER clients_updated_at      BEFORE UPDATE ON clients      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER profiles_updated_at     BEFORE UPDATE ON profiles     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
