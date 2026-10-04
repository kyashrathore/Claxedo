/** The column of `session_messages` holding a message's JSON: `data` in the SQLite adapter, `data_json` in D1. */
export type StoredMessageColumn = "data" | "data_json"

/** `Row` is the column list the SQL selects, declared by the caller as D1's `all<Row>` declares it. */
export type StoredMessageQuery = <Row>(sql: string, params: readonly (string | number)[]) => Promise<readonly Row[]> | readonly Row[]
