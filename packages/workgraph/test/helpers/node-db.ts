import Database from "better-sqlite3";

export function nodeDb(file = ":memory:") {
  return new Database(file);
}
