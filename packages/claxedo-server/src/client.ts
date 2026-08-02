export type ClaxedoClientOptions = {
  serverUrl: string
  token?: string
}

export type ClaxedoRequestOptions = {
  headers?: HeadersInit
}

function query(params: Record<string, string | undefined>) {
  return new URLSearchParams(
    Object.entries(params).filter((item): item is [string, string] => typeof item[1] === "string"),
  ).toString()
}

export function createClaxedoClient(options: ClaxedoClientOptions) {
  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`)
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
    const res = await fetch(new URL(path, options.serverUrl), {
      ...init,
      headers,
    })
    const text = await res.text().catch(() => "")
    const body = text
      ? (() => {
          try {
            return JSON.parse(text) as unknown
          } catch {
            return text
          }
        })()
      : undefined
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${res.statusText} ${text}`)
    return body
  }

  async function post(path: string, body?: unknown, init: RequestInit = {}) {
    return await request(path, {
      ...init,
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function del(path: string) {
    return await request(path, { method: "DELETE" })
  }

  return {
    health: async () => await request("/api/claxedo/health"),
    listWorkspaces: async (access?: "cloud" | "user-hosted") => await request(
      access ? `/api/workspace?${query({ access })}` : "/api/workspace",
    ),
    resolveWorkspace: async (input: { directory: string; create?: boolean }) => await request(
      `/api/workspace/resolve?${query({
        directory: input.directory,
        create: input.create === false ? "false" : "true",
      })}`,
    ),
    readFile: async (input: { directory: string; path: string }) => await request(
      `/file/content?${query({ directory: input.directory, path: input.path })}`,
    ),
    createSession: async (input: { directory: string; title: string }, requestOptions: ClaxedoRequestOptions = {}) =>
      await post(`/session?${query({ directory: input.directory })}`, { title: input.title }, {
        headers: requestOptions.headers,
      }),
    readSessionMessages: async (input: { directory: string; sessionId: string }) => await request(
      `/session/${encodeURIComponent(input.sessionId)}/message?${query({ directory: input.directory })}`,
    ),
    agentExtensions: {
      catalog: async () => await request("/api/claxedo/agent-config/extensions/catalog"),
      list: async (input: { directory: string }) => await request(
        `/api/claxedo/agent-config/extensions?${query({ directory: input.directory })}`,
      ),
      install: async (input: { directory: string; source: string; id: string; targets: string[] }) =>
        await post(`/api/claxedo/agent-config/extensions?${query({ directory: input.directory })}`, {
          source: input.source,
          id: input.id,
          targets: input.targets,
        }),
      disable: async (input: { directory: string; id: string }) => await post(
        `/api/claxedo/agent-config/extensions/${encodeURIComponent(input.id)}/disable?${query({ directory: input.directory })}`,
      ),
      enable: async (input: { directory: string; id: string }) => await post(
        `/api/claxedo/agent-config/extensions/${encodeURIComponent(input.id)}/enable?${query({ directory: input.directory })}`,
      ),
      remove: async (input: { directory: string; id: string }) => await del(
        `/api/claxedo/agent-config/extensions/${encodeURIComponent(input.id)}?${query({ directory: input.directory })}`,
      ),
    },
  }
}
