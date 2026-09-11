PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT NOT NULL DEFAULT 'Oliver',
  source TEXT NOT NULL DEFAULT 'whatsapp',
  external_key TEXT UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  category_normalized TEXT NOT NULL DEFAULT 'other',
  brand TEXT,
  quantity INTEGER,
  unit_price REAL,
  total_price REAL,
  condition TEXT,
  location TEXT,
  sizes TEXT,
  licensing TEXT,
  availability TEXT NOT NULL DEFAULT 'active',
  state TEXT NOT NULL DEFAULT 'detected'
    CHECK (state IN ('detected','structured','media_ready','matchable','outreach_active','paused','sold','archived')),
  raw_text TEXT,
  project_gate TEXT NOT NULL DEFAULT 'AMBER'
    CHECK (project_gate IN ('RED','AMBER','GREEN','DO_NOT_MARKET','ARCHIVED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lot_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  fabricated INTEGER NOT NULL DEFAULT 0 CHECK (fabricated = 0),
  UNIQUE(lot_id, key, value)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  chat TEXT NOT NULL DEFAULT 'oliver',
  sent_at TEXT NOT NULL,
  text TEXT,
  scanned_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  lot_id INTEGER REFERENCES lots(id)
);

CREATE TABLE IF NOT EXISTS lot_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER REFERENCES lots(id) ON DELETE SET NULL,
  oliver_message_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  classification TEXT NOT NULL DEFAULT 'pending',
  outreach_safe INTEGER NOT NULL DEFAULT 0,
  association_certain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sha256)
);

CREATE TABLE IF NOT EXISTS buyers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  website TEXT,
  channel TEXT NOT NULL DEFAULT 'unknown',
  categories TEXT NOT NULL DEFAULT '',
  buyer_type TEXT,
  geography TEXT NOT NULL DEFAULT 'unknown',
  location TEXT,
  txn_capacity_usd INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  last_verified TEXT,
  source_evidence TEXT,
  confidence REAL,
  disqualified_reason TEXT,
  outreach_channel TEXT NOT NULL DEFAULT 'unknown'
    CHECK (outreach_channel IN ('email','form','linkedin','instagram','phone','manual','unknown')),
  legacy_buyer_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buyer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  name TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  instagram TEXT,
  verification TEXT NOT NULL DEFAULT 'unverified',
  UNIQUE(buyer_id, email)
);

CREATE TABLE IF NOT EXISTS buyer_mandates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  stance TEXT NOT NULL DEFAULT 'unknown' CHECK (stance IN ('accepts','rejects','unknown')),
  brands_accepted TEXT,
  brands_excluded TEXT,
  min_units INTEGER,
  max_units INTEGER,
  requires_manifest INTEGER NOT NULL DEFAULT 0,
  requires_licensing_docs INTEGER NOT NULL DEFAULT 0,
  requires_invoice_chain INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  source_quote TEXT,
  origin TEXT NOT NULL DEFAULT 'research',
  confidence REAL NOT NULL DEFAULT 0.5,
  superseded_by INTEGER REFERENCES buyer_mandates(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buyer_category_stats (
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  offers INTEGER NOT NULL DEFAULT 0,
  closes INTEGER NOT NULL DEFAULT 0,
  ignores INTEGER NOT NULL DEFAULT 0,
  rejects INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (buyer_id, category)
);

CREATE TABLE IF NOT EXISTS match_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  bucket TEXT NOT NULL,
  capacity_score REAL NOT NULL,
  product_fit_score REAL NOT NULL,
  geography_score REAL NOT NULL,
  history_score REAL NOT NULL,
  contact_score REAL NOT NULL,
  rationale TEXT NOT NULL,
  hard_disqualified TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lot_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL UNIQUE REFERENCES buyers(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle','queued','outreach_sent','replied','qualified','escalated','suppressed','closed')),
  channel TEXT NOT NULL DEFAULT 'email',
  contact_email TEXT,
  last_outbound_at TEXT,
  last_inbound_at TEXT,
  next_action TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_lots (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, lot_id)
);

CREATE TABLE IF NOT EXISTS outreach_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  channel TEXT NOT NULL,
  lot_ids TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  media_hashes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'logged'
    CHECK (status IN ('logged','dry_run','sent','blocked','failed')),
  reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id),
  buyer_id INTEGER REFERENCES buyers(id),
  channel TEXT NOT NULL DEFAULT 'email',
  from_address TEXT NOT NULL,
  provider_message_id TEXT UNIQUE,
  classification TEXT NOT NULL,
  interest_level TEXT NOT NULL,
  phone TEXT,
  quantity TEXT,
  price REAL,
  lots_mentioned TEXT,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  lot_ids TEXT NOT NULL,
  reason TEXT NOT NULL,
  phone TEXT,
  packet TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','handed_to_oliver','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address_or_domain TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outreach_ledger (
  contact_email TEXT NOT NULL,
  lot_id INTEGER NOT NULL,
  buyer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'eligible'
    CHECK (status IN ('eligible','queued','sent_once','replied_manual_only','suppressed','bounced','opted_out')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contact_email, lot_id)
);

CREATE TABLE IF NOT EXISTS research_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','done','failed')),
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grok_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  instruction TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','claimed','done','failed')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at, type);
CREATE INDEX IF NOT EXISTS idx_lots_state ON lots(state, availability);
CREATE INDEX IF NOT EXISTS idx_media_lot ON lot_media(lot_id, outreach_safe);
CREATE INDEX IF NOT EXISTS idx_match_lot ON match_scores(lot_id, score);
CREATE INDEX IF NOT EXISTS idx_research_pending ON research_jobs(state, kind);
