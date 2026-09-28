/** The column of `session_messages` holding a message's JSON: `data` in the SQLite adapter, `data_json` in D1. */
export type StoredMessageColumn = "data" | "data_json"

/** Runs one statement against the adapter's driver, synchronously or not, and answers its rows. */
export type StoredMessageQuery = (sql: string, params: readonly (string | number)[]) => Promise<readonly unknown[]> | readonly unknown[]
