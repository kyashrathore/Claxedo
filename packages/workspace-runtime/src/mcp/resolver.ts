
export type UserMcpServer = {
  type: "stdio" | "remote"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export type ResolvedMcpServer =
  | {
      name: string
      source: "user"
      transport: "stdio"
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      name: string
      source: "user"
      transport: "remote"
      url: string
      headers: Record<string, string>
    }

export const resolveUserMcp = (input: Record<string, UserMcpServer>) => {
  const out: Record<string, ResolvedMcpServer> = {}
  for (const [name, cfg] of Object.entries(input)) {
    if (cfg.disabled) continue
    if (cfg.type === "stdio" && cfg.command) {
      out[name] = {
        name,
        source: "user",
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env ?? {},
      }
      continue
    }
    if (cfg.type === "remote" && cfg.url) {
      out[name] = {
        name,
        source: "user",
        transport: "remote",
        url: cfg.url,
        headers: cfg.headers ?? {},
      }
    }
  }
  return out
}
