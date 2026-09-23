import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Imported first by `signed-browser-relay-fixture.mjs`, because its other
 * static imports evaluate before its body and workspace-runtime fixes its data
 * root (`~/.workspace-runtime` without an override) at module load. Once a
 * server starts, `setupAgentHooks()` also appends to the harness configs under
 * this home (`~/.codex/hooks.json`, `~/.gemini/settings.json`, ...), so it
 * must never be the developer's.
 */
export const root = mkdtempSync(path.join(os.tmpdir(), "claxedo-signed-browser-relay-"))

const home = path.join(root, "home")
mkdirSync(home)
process.env.HOME = home
process.env.USERPROFILE = home
