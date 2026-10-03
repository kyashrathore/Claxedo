CREATE TABLE claxedo_session_attention (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  session_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL
);
CREATE UNIQUE INDEX claxedo_session_attention_position_idx
  ON claxedo_session_attention (session_ref, generation, sequence);
CREATE TABLE claxedo_session_attention_scan (
  session_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  through INTEGER NOT NULL,
  PRIMARY KEY (session_ref, generation)
);
