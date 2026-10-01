import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"

test("e2e executable boot graphs contain no retired server entry", async () => {
  const forbidden: string[] = []
  for (const directory of ["packages/harness/e2e", "packages/claxedo-app/e2e"]) {
    for await (const file of new Bun.Glob("**/*.{ts,mjs}").scan(path.join(REPO_ROOT, directory))) {
      if (file.endsWith(".test.ts")) continue
      const source = await fs.readFile(path.join(REPO_ROOT, directory, file), "utf8")
      if (/deployments\/self-hosted-node|cloud-server-entry|startSelfHostedServer/.test(source)) forbidden.push(`${directory}/${file}`)
    }
  }
  expect(forbidden).toEqual([])
})
