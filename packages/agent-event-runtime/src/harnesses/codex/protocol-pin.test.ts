import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "../../../../..")
const read = (file: string) => readFileSync(path.join(repo, file), "utf8")
const pinnedIn = (text: string) => [...text.matchAll(/@openai\/codex@(\d+\.\d+\.\d+)/g)].map((match) => match[1])

test("the protocol generator pins the Codex the sandbox runs", () => {
  const generator = JSON.parse(read("packages/agent-event-runtime/package.json")).devDependencies["@openai/codex"]
  const runtimes = [
    ...pinnedIn(read("packages/claxedo-server/scripts/sandbox/Dockerfile")),
    ...pinnedIn(read("packages/sandbox-manager/src/drivers/vercel.ts")),
  ]
  expect(runtimes.length).toBe(2)
  expect(runtimes).toEqual([generator, generator])
})
