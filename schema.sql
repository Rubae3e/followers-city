CREATE TABLE IF NOT EXISTS residents (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL UNIQUE,
  ig_id     TEXT,
  name      TEXT,
  token     TEXT NOT NULL UNIQUE,
  created   TEXT NOT NULL,
  comments  INTEGER NOT NULL DEFAULT 1,
  house     TEXT NOT NULL DEFAULT '{}'
);
