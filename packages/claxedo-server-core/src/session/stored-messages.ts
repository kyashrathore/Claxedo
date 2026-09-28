/** The column of `session_messages` holding a message's JSON: `data` in the SQLite adapter, `data_json` in D1. */
export type StoredMessageColumn = "data" | "data_json"

export type StoredMessageQuery = (sql: string, params: readonly (string | number)[]) => Promise<readonly unknown[]> | readonly unknown[]
