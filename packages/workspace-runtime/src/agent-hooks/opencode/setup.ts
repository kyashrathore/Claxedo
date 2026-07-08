import * as fs from "fs"
import * as path from "path"
import { materializeOpenCodeDocAgent } from "@claxedo/agent-extensions"
import type { StatusHooksManifest } from "../core/setup"
import { writeIfChanged } from "../core/utils"
import { OPENCODE_PLUGIN, opencodeAgentDir, opencodeConfigDir, opencodePluginDir } from "./constants"
import { generateOpenCodePlugin } from "./plugins"
import { generateOpenCodeWrapper } from "./wrapper"

export function opencodePaths(root: string) {
  const config = opencodeConfigDir(root)
  return {
    config,
    plugin: opencodePluginDir(root),
    agent: opencodeAgentDir(root),
  }
}

export async function setupOpencodeIntegration(input: {
  manifest: StatusHooksManifest
  force: boolean
}) {
  const dir = opencodePaths(input.manifest.dirs.root)
  await fs.promises.mkdir(input.manifest.dirs.bin, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(dir.config, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(dir.plugin, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(dir.agent, { recursive: true, mode: 0o755 })

  await writeIfChanged(
    path.join(input.manifest.dirs.bin, "opencode"),
    generateOpenCodeWrapper(dir.config),
    0o755,
    input.force,
  )
  await writeIfChanged(
    path.join(dir.plugin, OPENCODE_PLUGIN),
    generateOpenCodePlugin(input.manifest.files.notify),
    0o644,
    input.force,
  )
  await materializeOpenCodeDocAgent({ agentDir: dir.agent, force: input.force })

  return dir
}
