#!/usr/bin/env bun

import path from "node:path"

process.env.CLAXEDO_ACTUAL_SESSION_DB ??= path.join(
  process.env.HOME ?? "",
  ".local/share/opencode/opencode.db",
)

await import("./real-web-public-session-switch")
