import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { RuntimePlacement } from "@claxedo/harness/contract"
import { removeTempRoot } from "@claxedo/harness/testing"
import { harnessCompositionOptions } from "./composition"

let root = ""
let env: NodeJS.ProcessEnv = {}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-composition-"))
  const claude = path.join(root, "claude")
  await fs.writeFile(claude, "#!/bin/sh\n", { mode: 0o755 })
  env = { HOME: root, PATH: "/usr/bin:/bin", CLAUDE_CODE_EXECUTABLE: claude }
})

afterAll(async () => { await removeTempRoot(root) })

function claudeEnv(placement: RuntimePlacement) {
  return harnessCompositionOptions({ env, placement: { placement, machineOwnerUserId: "owner", canUseOwnLogin: false },
    harnessStateRoot: path.join(root, "harness"), opencodeRoot: path.join(root, "opencode") }).claude().env
}

test("Claude Code in a cloud sandbox runtime is told it runs in a sandbox, so its root user may skip permissions", () => {
  expect(claudeEnv("cloud").IS_SANDBOX).toBe("1")
})

test("Claude Code on a person's own machine keeps its root refusal", () => {
  for (const placement of ["desktop", "loopback", "self-hosted"] as const) expect(claudeEnv(placement).IS_SANDBOX).toBeUndefined()
})
