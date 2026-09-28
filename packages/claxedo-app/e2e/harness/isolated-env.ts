import fs from "node:fs/promises"
import path from "node:path"
import { isolatedHomeEnv } from "../../perf-harness/src/isolated-home"
import { egressProxyEnv } from "./egress-guard"
import { PINNED_PI } from "../../../harness/e2e/harness/pinned-pi"
import { writePricingSnapshot } from "./usage-pricing"

const STAND_INS = path.join(import.meta.dirname, "stand-ins")

const INHERITED = ["TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TZ", "CI"] as const

const GIT_IDENTITY = "[user]\n\tname = Claxedo e2e\n\temail = e2e@claxedo.test\n"

const AGENTS_STAY_OFFLINE = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", PI_OFFLINE: "1" }

function inherited(): NodeJS.ProcessEnv {
  return Object.fromEntries(INHERITED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])))
}

export async function isolatedEnv(home: string, guardUrl: string): Promise<NodeJS.ProcessEnv> {
  const { HOME, ...xdg } = isolatedHomeEnv(home)
  await Promise.all(Object.values(xdg).map((dir) => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(path.join(home, ".gitconfig"), GIT_IDENTITY)
  await writePricingSnapshot(home)
  return {
    ...inherited(),
    PATH: [STAND_INS, process.env.PATH].filter(Boolean).join(path.delimiter),
    HOME,
    ...xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...AGENTS_STAY_OFFLINE,
    PI_EXECUTABLE: PINNED_PI,
    ...egressProxyEnv(guardUrl),
  }
}
