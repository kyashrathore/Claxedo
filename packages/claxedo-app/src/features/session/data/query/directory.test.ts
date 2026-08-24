import { describe, expect, test } from "bun:test"
import type { Agent, Config, Path, Project } from "@opencode-ai/sdk/v2/client"
import { agentListQuery, configQuery, pathQuery, projectCurrentQuery, workspaceResolveQuery } from "./directory"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

describe("directory query factories", () => {
  function project(id: string, worktree: string): Project {
    return {
      id,
      worktree,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    }
  }

  function agent(name: string): Agent {
    return {
      name,
      mode: "primary",
      permission: [],
      options: {},
    }
  }

  test("projectCurrentQuery returns the current project id", async () => {
    const query = projectCurrentQuery({
      baseUrl: "http://example.test/",
      directory: "/tmp/ws",
      client: {
        project: {
          current: async () => ({ data: project("project_1", "/tmp/ws") }),
        },
      },
    })

    expect(query.queryKey).toEqual(["directory", "http://example.test", "project", "/tmp/ws"])
    expect(query.staleTime).toBe(60 * 1000)
    expect(await query.queryFn()).toBe("project_1")
  })

  test("configQuery is directory-scoped", async () => {
    const config = { model: "claude" } satisfies Config
    const query = configQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      client: {
        config: {
          get: async () => ({ data: config }),
        },
      },
    })

    expect(query.queryKey).toEqual(["directory", "http://example.test", "config", "/tmp/ws"])
    expect(query.staleTime).toBe(60 * 1000)
    expect(await query.queryFn()).toMatchObject({ model: "claude" })
  })

  test("pathQuery is directory-scoped", async () => {
    const path = {
      home: "/home/test",
      state: "/state",
      config: "/config",
      worktree: "/tmp/ws",
      directory: "/tmp/ws",
    } satisfies Path
    const query = pathQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      client: {
        path: {
          get: async () => ({ data: path }),
        },
      },
    })

    expect(query.queryKey).toEqual(["directory", "http://example.test", "path", "/tmp/ws"])
    expect(query.staleTime).toBe(5 * 60 * 1000)
    expect(await query.queryFn()).toEqual(path)
  })

  test("workspaceResolveQuery uses directory stale time", async () => {
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      expect(req.url).toBe("http://example.test/api/workspace/resolve?directory=%2Ftmp%2Fws")
      return new Response(JSON.stringify({ workspaceId: "ws_1", directory: "/tmp/ws", kind: "cloud" }), { status: 200 })
    }
    const query = workspaceResolveQuery({
      baseUrl: "http://example.test",
      request,
      directory: "/tmp/ws",
    })

    expect(query.queryKey).toEqual(["runtime", "http://example.test", "workspace", "", "/tmp/ws", "read"])
    expect(query.staleTime).toBe(60 * 1000)
    expect(await query.queryFn()).toMatchObject({ workspaceId: "ws_1" })
  })

  test("agentListQuery includes opencode runner type and passes directory to the SDK", async () => {
    const calls: unknown[] = []
    const query = agentListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      harnessType: "opencode",
      client: {
        app: {
          agents: async (input?: { directory?: string }) => {
            calls.push(input)
            return { data: [agent("build")] }
          },
        },
      },
    })

    expect(query.queryKey).toEqual(["directory", "http://example.test", "agents", "/tmp/ws", "opencode", ""])
    expect(query.staleTime).toBe(30 * 1000)
    expect(await query.queryFn()).toMatchObject([{ name: "build" }])
    expect(calls).toEqual([{ directory: "/tmp/ws" }])
  })

  test("agentListQuery skips agent profiles for harness transports", async () => {
    const query = agentListQuery({
      baseUrl: "http://example.test",
      directory: "/tmp/ws",
      harnessType: "codex-acp",
      request: (async () => {
        throw new Error("agent profile request should not run for harness transports")
      }) as typeof fetch,
      client: {
        app: {
          agents: async () => {
            throw new Error("sdk agent profile request should not run for harness transports")
          },
        },
      },
    })

    expect(query.queryKey).toEqual(["directory", "http://example.test", "agents", "/tmp/ws", "codex-acp", ""])
    expect(await query.queryFn()).toEqual([])
  })

  test("agentListQuery routes loopback cloud workspaces through Workspace Relay when request is supplied", async () => {
    const calls: string[] = []
    const query = agentListQuery({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/ws",
      harnessType: "opencode",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
        const url = new URL(req.url)
        if (url.pathname === "/api/workspace/ws_1/connection") {
          return new Response(
            JSON.stringify({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_1",
              relayUrl: "https://relay.test",
              runtimeAccessToken: "rat_1",
              tokenExpiresAt: Date.now() + 120_000,
            }),
            { status: 200 },
          )
        }
        if (url.toString() === "http://127.0.0.1:3001/workspaces/ws_1/agent?harness=opencode") {
          expect(req.headers.get("authorization")).toBe(null)
          return new Response(JSON.stringify([{ name: "plan", mode: "primary" }]), { status: 200 })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_1",
        directory: "/tmp/ws",
        kind: "cloud",
      },
      client: {
        app: {
          agents: async () => {
            throw new Error("expected Workspace Relay")
          },
        },
      },
    })

    expect(await query.queryFn()).toEqual([{ name: "plan", mode: "primary" }])
    expect(calls.some((call) => call.includes("/api/claxedo/agent-config/agents"))).toBe(false)
  })

  test("agentListQuery keeps an explicit workspace authoritative when cached workspaces share its directory", async () => {
    const baseUrl = "http://127.0.0.1:3001"
    const directory = "/tmp/shared-worktree"
    const queryKey = queryKeys.controlPlane.projects(baseUrl)
    queryClient.setQueryData(queryKey, [
      {
        id: "project_ambiguous",
        worktree: directory,
        sandboxes: [directory],
        workspaces: {
          ws_B: { id: "ws_B", workspaceId: "ws_B", kind: "cloud", directory },
          ws_A: { id: "ws_A", workspaceId: "ws_A", kind: "cloud", directory },
        },
      },
    ])
    const calls: string[] = []
    try {
      const query = agentListQuery({
        baseUrl,
        directory,
        harnessType: "opencode",
        workspace: { workspaceId: "ws_A", directory, kind: "cloud" },
        request: (async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          calls.push(req.url)
          const url = new URL(req.url)
          if (url.pathname === "/api/workspace/ws_A/connection") {
            return Response.json({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_A",
              relayUrl: "https://relay.test",
              runtimeAccessToken: "rat_A",
              tokenExpiresAt: Date.now() + 120_000,
            })
          }
          if (url.toString() === `${baseUrl}/workspaces/ws_A/agent?harness=opencode`) {
            return Response.json([{ name: "plan", mode: "primary" }])
          }
          throw new Error(`unexpected request: ${req.method} ${req.url}`)
        }) as typeof fetch,
        client: {
          app: {
            agents: async () => {
              throw new Error("expected Workspace Relay")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "plan", mode: "primary" }])
      expect(calls.some((call) => call.includes("ws_B"))).toBe(false)
    } finally {
      queryClient.removeQueries({ queryKey })
    }
  })

  test("agentListQuery routes cached signed filesystem workspaces through Workspace Relay", async () => {
    const queryKey = queryKeys.controlPlane.projects("https://control.test")
    queryClient.setQueryData(queryKey, [
      {
        id: "project_1",
        worktree: "ws_persisted_agent",
        sandboxes: ["/tmp/ws-persisted-agent"],
        workspaces: {
          "/tmp/ws-persisted-agent": {
            id: "ws_persisted_agent",
            workspaceId: "ws_persisted_agent",
            kind: "user-hosted",
            directory: "/tmp/ws-persisted-agent",
          },
        },
      },
    ])
    const calls: string[] = []
    try {
      const query = agentListQuery({
        baseUrl: "https://control.test",
        directory: "/tmp/ws-persisted-agent",
        harnessType: "opencode",
        request: (async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          calls.push(req.url)
          const url = new URL(req.url)
          if (url.pathname === "/api/workspace/ws_persisted_agent/connection") {
            return new Response(
              JSON.stringify({
                access: "user-hosted",
                backing: "local-worktree",
                workspaceId: "ws_persisted_agent",
                role: "owner",
                relayUrl: "https://relay.test",
                runtimeAccessToken: "rat_1",
                tokenExpiresAt: Date.now() + 120_000,
              }),
              { status: 200 },
            )
          }
          if (url.toString() === "https://relay.test/workspaces/ws_persisted_agent/agent?harness=opencode") {
            return new Response(JSON.stringify([{ name: "build", mode: "primary" }]), { status: 200 })
          }
          throw new Error(`unexpected request: ${req.method} ${req.url}`)
        }) as typeof fetch,
        client: {
          app: {
            agents: async () => {
              throw new Error("expected Workspace Relay")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "build", mode: "primary" }])
      expect(calls.some((call) => call.includes("/api/claxedo/agent-config/agents"))).toBe(false)
    } finally {
      queryClient.removeQueries({ queryKey })
    }
  })

  test("agentListQuery routes cached signed filesystem workspaces through Workspace Relay on a loopback control plane", async () => {
    const baseUrl = "http://127.0.0.1:3001"
    const directory = "/tmp/ws-signed-loopback"
    const queryKey = queryKeys.controlPlane.projects(baseUrl)
    queryClient.setQueryData(queryKey, [
      {
        id: "project_loopback",
        worktree: "ws_signed_loopback",
        sandboxes: [directory],
        workspaces: {
          ws_signed_loopback: {
            id: "ws_signed_loopback",
            workspaceId: "ws_signed_loopback",
            kind: "cloud",
            directory,
          },
        },
      },
    ])
    const calls: string[] = []
    try {
      const query = agentListQuery({
        baseUrl,
        directory,
        harnessType: "opencode",
        // The loopback local resolver cannot see a signed cloud row by
        // filesystem directory and reports an authoritative-looking miss.
        // Signed project inventory still owns the runtime identity.
        workspace: null,
        request: (async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          calls.push(req.url)
          const url = new URL(req.url)
          if (url.pathname === "/api/workspace/ws_signed_loopback/connection") {
            return Response.json({
              access: "cloud",
              backing: "cloud-vm",
              workspaceId: "ws_signed_loopback",
              relayUrl: "https://relay.test",
              runtimeAccessToken: "rat_loopback",
              tokenExpiresAt: Date.now() + 120_000,
            })
          }
          if (url.toString() === `${baseUrl}/workspaces/ws_signed_loopback/agent?harness=opencode`) {
            return Response.json([{ name: "plan", mode: "primary" }])
          }
          throw new Error(`unexpected request: ${req.method} ${req.url}`)
        }) as typeof fetch,
        client: {
          app: {
            agents: async () => {
              throw new Error("expected Workspace Relay")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "plan", mode: "primary" }])
      expect(calls).toEqual([`${baseUrl}/workspaces/ws_signed_loopback/agent?harness=opencode`])
      expect(calls.some((call) => call.includes("/api/claxedo/agent-config/agents"))).toBe(false)
      expect(calls.some((call) => call.includes("/api/claxedo/workspace/resolve"))).toBe(false)
    } finally {
      queryClient.removeQueries({ queryKey })
    }
  })

  test("agentListQuery ignores ordinary local rows in cached project inventory", async () => {
    const baseUrl = "http://127.0.0.1:3001"
    const directory = "/tmp/ws-local-inventory"
    const projectQueryKey = queryKeys.controlPlane.projects(baseUrl)
    const runtimeQueryKey = queryKeys.runtime.workspace({ baseUrl, directory })
    queryClient.setQueryData(projectQueryKey, [
      {
        id: "project_local",
        worktree: directory,
        sandboxes: [directory],
        workspaces: {
          ws_local_inventory: {
            id: "ws_local_inventory",
            workspaceId: "ws_local_inventory",
            kind: "local",
            directory,
          },
        },
      },
    ])
    const calls: string[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(req.url)
      if (
        req.url === `${baseUrl}/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws-local-inventory&type=opencode`
      ) {
        return Response.json([{ name: "build", mode: "primary" }])
      }
      throw new Error(`unexpected unsigned request: ${req.method} ${req.url}`)
    }) as typeof fetch
    try {
      const query = agentListQuery({
        baseUrl,
        directory,
        harnessType: "opencode",
        request: (async (input: string | URL | Request, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          calls.push(req.url)
          if (req.url === `${baseUrl}/api/claxedo/workspace/resolve?directory=%2Ftmp%2Fws-local-inventory`) {
            return Response.json({
              workspaceId: "ws_local_inventory",
              directory,
              kind: "local",
            })
          }
          throw new Error(`unexpected signed request: ${req.method} ${req.url}`)
        }) as typeof fetch,
        client: {
          app: {
            agents: async () => {
              throw new Error("expected local agent-config route")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "build", mode: "primary" }])
      expect(calls).toEqual([
        `${baseUrl}/api/claxedo/workspace/resolve?directory=%2Ftmp%2Fws-local-inventory`,
        `${baseUrl}/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws-local-inventory&type=opencode`,
      ])
      expect(calls.some((call) => call.includes("/api/workspace/ws_local_inventory/connection"))).toBe(false)
    } finally {
      globalThis.fetch = previous
      queryClient.removeQueries({ queryKey: projectQueryKey })
      queryClient.removeQueries({ queryKey: runtimeQueryKey })
    }
  })

  test("agentListQuery uses Claxedo agent config API for local workspaces", async () => {
    const calls: string[] = []
    const query = agentListQuery({
      baseUrl: "http://claxedo.test/",
      directory: "/tmp/ws",
      harnessType: "opencode",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        if (req.url === "http://claxedo.test/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws&type=opencode") {
          return new Response(JSON.stringify([{ name: "build", mode: "primary" }, { mode: "primary" }, null]), {
            status: 200,
          })
        }
        throw new Error(`unexpected request: ${req.method} ${req.url}`)
      }) as typeof fetch,
      workspace: {
        workspaceId: "ws_local",
        directory: "/tmp/ws",
        kind: "local",
      },
      client: {
        app: {
          agents: async () => {
            throw new Error("expected Claxedo agent config API")
          },
        },
      },
    })

    expect(await query.queryFn()).toEqual([{ name: "build", mode: "primary" }])
    expect(calls).toEqual(["http://claxedo.test/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws&type=opencode"])
  })

  test("agentListQuery keeps signed loopback local agent profile requests unsigned", async () => {
    const calls: string[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init)
      calls.push(`${req.method} ${req.url} ${req.headers.get("authorization") ?? ""}`.trim())
      return new Response(JSON.stringify([{ name: "plan", mode: "primary" }]), { status: 200 })
    }) as typeof fetch
    try {
      const query = agentListQuery({
        baseUrl: "http://127.0.0.1:3001/",
        directory: "/tmp/ws",
        harnessType: "opencode",
        request: (async () => {
          throw new Error("expected unsigned loopback fetch")
        }) as typeof fetch,
        workspace: {
          workspaceId: "ws_local",
          directory: "/tmp/ws",
          kind: "local",
        },
        client: {
          app: {
            agents: async () => {
              throw new Error("expected Claxedo agent config API")
            },
          },
        },
      })

      expect(await query.queryFn()).toEqual([{ name: "plan", mode: "primary" }])
      expect(calls).toEqual([
        "GET http://127.0.0.1:3001/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws&type=opencode",
      ])
    } finally {
      globalThis.fetch = previous
    }
  })
})
