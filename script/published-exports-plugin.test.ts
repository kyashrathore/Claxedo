import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { BunPlugin } from "bun"
import { publishedExportsPlugin } from "./published-exports-plugin"

type Resolve = (args: { path: string; resolveDir: string }) => unknown

function resolver(config: Record<string, unknown>): Resolve {
  let resolve: Resolve | undefined
  publishedExportsPlugin().setup({ config, onResolve(_filter: unknown, callback: Resolve) { resolve = callback } } as unknown as Parameters<BunPlugin["setup"]>[0])
  return resolve!
}

test("a private workspace resolves to its real file and an external one is left to Bun", () => {
  const resolveDir = path.resolve(import.meta.dirname, "../packages/claxedo-app/src")
  const specifier = "@claxedo/plugin-api/id"
  expect(resolver({ external: [] })({ path: specifier, resolveDir })).toEqual({ path: fs.realpathSync(Bun.resolveSync(specifier, resolveDir)) })
  for (const config of [{ external: ["@claxedo/*"] }, { packages: "external" }]) {
    expect(resolver(config)({ path: specifier, resolveDir })).toBeUndefined()
  }
})
