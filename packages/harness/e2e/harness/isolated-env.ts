import fs from "node:fs/promises"
import path from "node:path"
import { egressProxyEnv } from "./egress-guard"
import { writePricingSnapshot } from "./usage-pricing"

const STAND_INS = path.join(import.meta.dirname, "stand-ins")

const INHERITED = ["TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TZ", "CI"] as const

const GIT_IDENTITY = "[user]\n\tname = Claxedo e2e\n\temail = e2e@claxedo.test\n"

const AGENTS_STAY_OFFLINE = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }

/** Where the stack finds the agent CLIs it runs: directories that lead PATH, and the variables that name or steer them. */
export type AgentCliEnv = { readonly path: readonly string[]; readonly env: Readonly<Record<string, string>> }

function inherited(): NodeJS.ProcessEnv {
  return Object.fromEntries(INHERITED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])))
}

export async function isolatedEnv(home: string, guardUrl: string, agents: AgentCliEnv = { path: [], env: {} }): Promise<NodeJS.ProcessEnv> {
  const xdg = {
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  }
  await Promise.all(Object.values(xdg).map((dir) => fs.mkdir(dir, { recursive: true })))
  const windowsHome = process.platform === "win32" ? {
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  } : {}
  await Promise.all(Object.values(windowsHome).map((dir) => fs.mkdir(dir, { recursive: true })))
  await fs.writeFile(path.join(home, ".gitconfig"), GIT_IDENTITY)
  await writePricingSnapshot(home)
  return {
    ...inherited(),
    PATH: [STAND_INS, ...agents.path, process.env.PATH].filter(Boolean).join(path.delimiter),
    HOME: home,
    ...windowsHome,
    ...xdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...AGENTS_STAY_OFFLINE,
    ...agents.env,
    ...egressProxyEnv(guardUrl),
  }
}
