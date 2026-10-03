ALTER TABLE claxedo_session_meta ADD COLUMN attention_json TEXT;
CREATE TABLE claxedo_session_reader (
  session_ref TEXT NOT NULL,
  reader_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (session_ref, reader_id)
);
