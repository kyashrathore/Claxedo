import Database from "better-sqlite3"

import { compileBetterAuthD1Migration } from "../../src/platform/auth/better-auth-d1-migration"

const database = new Database(":memory:")
try {
  process.stdout.write(await compileBetterAuthD1Migration(database))
} finally {
  database.close()
}
