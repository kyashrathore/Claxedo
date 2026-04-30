import * as fs from "fs"
import * as path from "path"
import type { ResolvedMcpServer } from "../../../mcp-resolver"
import { DOC_AGENT_MD, OPENCODE_JSONC, OPENCODE_PLUGIN } from "../../constants"
import type { StatusHooksManifest } from "../../core/setup"
import { writeIfChanged } from "../../core/utils"
import { generateOpencodeJsonc, opencodePaths } from "./config"
import { generateOpenCodePlugin, generateDocAgentMd } from "./plugins"
import { generateOpenCodeWrapper } from "./wrapper"

export async function setupOpencodeIntegration(input: {
  manifest: StatusHooksManifest
  force: boolean
  mcp: Record<string, ResolvedMcpServer>
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
  await writeIfChanged(path.join(dir.agent, DOC_AGENT_MD), generateDocAgentMd(), 0o644, input.force)
  await writeIfChanged(
    path.join(dir.config, OPENCODE_JSONC),
    generateOpencodeJsonc(input.mcp),
    0o644,
    input.force,
  )

  return dir
}
