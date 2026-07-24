import path from "node:path"

import { codexAcpTarget } from "./codex-acp-target"

process.env.CODEX_PATH ??= path.join(
  path.dirname(process.execPath),
  "codex-vendor",
  codexAcpTarget(process.platform, process.arch).triple,
  "bin",
  process.platform === "win32" ? "codex.exe" : "codex",
)

await import("@agentclientprotocol/codex-acp")
