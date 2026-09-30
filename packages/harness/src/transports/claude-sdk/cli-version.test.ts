import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { harnessVersionStanding } from "../../contract"
import { CLAUDE_CODE_RANGE } from "./cli-version"

const repo = path.resolve(import.meta.dirname, "../../../../..")
const pinnedIn = (file: string) => [...readFileSync(path.join(repo, file), "utf8").matchAll(/@anthropic-ai\/claude-code@(\S+?)["\s\\]/g)].map((match) => match[1])

test("every sandbox image installs a Claude Code inside the tested range", () => {
  const pins = ["packages/claxedo-server/scripts/sandbox/Dockerfile", "packages/claxedo-server/scripts/sandbox/cloudflare-worker/Dockerfile",
    "packages/sandbox-manager/src/drivers/vercel.ts"].flatMap(pinnedIn)
  expect(pins).toHaveLength(3)
  for (const pin of pins) expect(harnessVersionStanding(CLAUDE_CODE_RANGE, pin)).toBe("tested")
})
