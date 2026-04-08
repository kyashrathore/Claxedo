import { Database } from "bun:sqlite";

export function nodeDb(file = ":memory:") {
  const db = new Database(file);

  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      return {
        run: (...params: any[]) => stmt.run(...params),
        get: (...params: any[]) => stmt.get(...params),
        all: (...params: any[]) => stmt.all(...params),
        raw() {
          return {
            get: (...params: any[]) => stmt.values(...params)?.[0],
            all: (...params: any[]) => stmt.values(...params),
          };
        },
      };
    },
    transaction: db.transaction.bind(db),
    exec: db.exec.bind(db),
    close: db.close.bind(db),
    name: file,
  };
}
