function normalized(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return "default"
  return trimmed.replace(/\/+$/, "")
}

export const queryKeys = {
  shell: {
    projects: (baseUrl?: string) => ["shell", normalized(baseUrl), "projects"] as const,
    providers: (baseUrl?: string) => ["shell", normalized(baseUrl), "providers"] as const,
    commands: (baseUrl: string | undefined, directory: string) => ["shell", normalized(baseUrl), "commands", directory] as const,
  },
  runtime: {
    workspace: (input: { baseUrl?: string; directory?: string; workspaceId?: string; create?: boolean }) =>
      [
        "runtime",
        normalized(input.baseUrl),
        "workspace",
        input.workspaceId ?? "",
        input.directory ?? "",
        input.create === true ? "create" : "read",
      ] as const,
    vcs: (baseUrl: string | undefined, directory: string) =>
      ["runtime", normalized(baseUrl), "vcs", directory] as const,
    mcp: (baseUrl: string | undefined, directory: string) =>
      ["runtime", normalized(baseUrl), "mcp", directory] as const,
    lsp: (baseUrl: string | undefined, directory: string) =>
      ["runtime", normalized(baseUrl), "lsp", directory] as const,
  },
}
