import Database from "better-sqlite3";

export function nodeDb(file = ":memory:") {
  const db = new Database(file);

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        run: (...params: any[]) => stmt.run(...params),
        get: (...params: any[]) => stmt.get(...params),
        all: (...params: any[]) => stmt.all(...params),
        raw() {
          const rawStmt = db.prepare(sql).raw(true);
          return {
            get: (...params: any[]) => rawStmt.get(...params),
            all: (...params: any[]) => rawStmt.all(...params),
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
