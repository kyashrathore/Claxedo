import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/opencode-patches/storage/claxedo/*.sql.ts",
  out: "./src/opencode-patches/storage/claxedo-migration",
})
