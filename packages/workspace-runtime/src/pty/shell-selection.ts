import os from "node:os"

export function selectPtyCommand(input: {
  command?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  userShell?: () => string | null | undefined
}) {
  if (input.command) return input.command
  const env = input.env ?? process.env
  if (env.SHELL) return env.SHELL
  if ((input.platform ?? process.platform) === "win32") return env.COMSPEC || "cmd.exe"
  try {
    return (input.userShell ?? (() => os.userInfo().shell))() || "/bin/sh"
  } catch {
    return "/bin/sh"
  }
}

