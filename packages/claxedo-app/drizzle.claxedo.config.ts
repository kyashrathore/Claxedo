import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/opencode-extensions/storage/claxedo/*.sql.ts",
  out: "./src/opencode-extensions/storage/claxedo-migration",
})
