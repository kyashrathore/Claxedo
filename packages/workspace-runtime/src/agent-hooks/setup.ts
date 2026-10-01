import * as fs from "fs"
import { materializeAgentHooks } from "./materialize-status-hooks"
import { Log } from "../log"
import { userHomeDir } from "@claxedo/helpers/path"
import { defaultStatusHooks, defaultGenericWrappers } from "../status-hooks"
import { BIN_DIR, CLAXEDO_DIR } from "./core/constants"
import {
  createStatusHooksManifest,
  writeStatusHooksArtifacts,
  isStatusHooksSetupComplete,
  type StatusHooksSetupOptions,
} from "./core/setup"
import { readWrapperInventory } from "./core/wrappers"
import type { StatusHookTemplate } from "@claxedo/plugin-api"

const log = Log.create({ service: "agent-hooks" })
export type SetupOptions = StatusHooksSetupOptions & { templates?: readonly StatusHookTemplate[] }

export async function setupAgentHooks(options: SetupOptions = {}): Promise<void> {
  const templates = options.templates ?? defaultStatusHooks
  const manifest = await writeStatusHooksArtifacts(createStatusHooksManifest(), {
    ...options,
    templates,
    genericWrappers: defaultGenericWrappers,
  })
  const results = await materializeAgentHooks({ homeDir: userHomeDir(), notifyPath: manifest.files.notify, templates })
  for (const result of results) {
    if (result.status !== "failed") continue
    log.warn("Failed to materialize agent hooks", { runner: result.runner, path: result.path, reason: result.reason })
  }
  log.info("Agent hooks setup complete", { binDir: BIN_DIR })
}

export function listWrapperAgents(root = CLAXEDO_DIR, templates = defaultStatusHooks) {
  return readWrapperInventory(root, templates, defaultGenericWrappers)
}

export function isSetupComplete(templates = defaultStatusHooks): boolean {
  return isStatusHooksSetupComplete(templates)
}

export async function cleanupAgentHooks(): Promise<void> {
  await fs.promises.rm(CLAXEDO_DIR, { recursive: true, force: true })
}
