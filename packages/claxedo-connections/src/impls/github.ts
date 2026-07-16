import type { CodeHostRepository, ConnectionFields, IntegrationDeclaration, IntegrationImpl, VerifyResult } from "../types.js"

export function githubIntegration(options: { fetchImpl?: typeof fetch } = {}): {
  decl: IntegrationDeclaration
  impl: IntegrationImpl
} {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    decl: {
      id: "github",
      name: "GitHub",
      methods: ["key"],
      capabilities: ["code-host", "work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
    },
    impl: {
      async verify(_fields: ConnectionFields, secret: string): Promise<VerifyResult> {
        try {
          const res = await fetchImpl("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${secret}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "claxedo",
            },
          })
          if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" }
          if (!res.ok) return { ok: false, reason: "network" }
          const body = (await res.json().catch(() => ({}))) as { login?: unknown }
          return { ok: true, ...(typeof body.login === "string" ? { accountLabel: body.login } : {}) }
        } catch {
          return { ok: false, reason: "network" }
        }
      },
      async listRepositories(_fields: ConnectionFields, secret: string): Promise<CodeHostRepository[]> {
        const repositories: CodeHostRepository[] = []
        for (let page = 1; page <= 10; page++) {
          const res = await fetchImpl(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
            headers: {
              Authorization: `Bearer ${secret}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "claxedo",
            },
          }).catch(() => undefined)
          if (!res) throw new Error("github_repositories_unavailable")
          if (res.status === 401 || res.status === 403) throw new Error("github_repositories_unauthorized")
          if (!res.ok) throw new Error("github_repositories_unavailable")
          const body = await res.json().catch(() => undefined)
          if (!Array.isArray(body)) throw new Error("github_repositories_invalid_response")
          repositories.push(...body.flatMap(repositoryFromGitHub))
          if (body.length < 100) return repositories
        }
        return repositories
      },
    },
  }
}

function repositoryFromGitHub(value: unknown): CodeHostRepository[] {
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  if (
    (typeof row.id !== "number" && typeof row.id !== "string") ||
    typeof row.name !== "string" ||
    typeof row.full_name !== "string" ||
    typeof row.clone_url !== "string" ||
    typeof row.private !== "boolean"
  ) return []
  const permissions = row.permissions && typeof row.permissions === "object"
    ? row.permissions as Record<string, unknown>
    : {}
  return [{
    id: String(row.id),
    name: row.name,
    fullName: row.full_name,
    cloneUrl: row.clone_url,
    private: row.private,
    permissions: {
      read: permissions.pull === true || permissions.push === true || permissions.admin === true,
      write: permissions.push === true || permissions.admin === true,
    },
  }]
}
