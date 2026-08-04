import { describe, expect, test } from "bun:test"
import { loadConnectedRepositories, loadRepositoryPickerState } from "./repository-picker"

const GITHUB_INTEGRATION = {
  id: "github",
  name: "GitHub",
  methods: ["oauth", "key"],
  capabilities: ["code-host", "work-source"],
}

describe("connected repository picker", () => {
  test("loads GitHub repositories with permission badges without retaining tokens", async () => {
    const requests: string[] = []
    const result = await loadConnectedRepositories(async (path) => {
      requests.push(path)
      if (!path) return Response.json({
        connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
      })
      return Response.json({ repositories: [{
        id: "1",
        name: "app",
        fullName: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
        private: true,
        permissions: { read: true, write: false },
        token: "must-not-survive",
      }] })
    })
    expect(requests).toEqual(["", "/connections/connection-1/repositories"])
    expect(result).toEqual([{
      connectionId: "connection-1",
      id: "1",
      name: "app",
      fullName: "acme/app",
      private: true,
      permissions: { read: true, write: false },
    }])
    expect(JSON.stringify(result)).not.toContain("must-not-survive")
  })

  test("keeps the example-public-repository escape hatch independent of GitHub auth", async () => {
    const result = await loadConnectedRepositories(async () => Response.json({ connections: [] }))
    expect(result).toEqual([])
  })
})

describe("repository picker state", () => {
  test("offers the GitHub connect path when nothing is connected yet", async () => {
    // The dead end this closes: with zero connected repositories the dialog
    // rendered no repository section and NO way to connect one, so a hosted
    // user on their first visit could not proceed at all.
    const state = await loadRepositoryPickerState(async () => Response.json({
      connections: [],
      integrations: [GITHUB_INTEGRATION],
    }))

    expect(state.repositories).toEqual([])
    expect(state.connectGitHub).toMatchObject({ id: "github", name: "GitHub", methods: ["oauth", "key"] })
  })

  test("does not offer to connect once repositories are listable", async () => {
    const state = await loadRepositoryPickerState(async (path) => {
      if (!path) return Response.json({
        connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
        integrations: [GITHUB_INTEGRATION],
      })
      return Response.json({ repositories: [{
        id: "1",
        name: "app",
        fullName: "acme/app",
        private: true,
        permissions: { read: true, write: true },
      }] })
    })

    expect(state.repositories).toHaveLength(1)
    expect(state.connectGitHub).toBeUndefined()
  })

  test("offers to reconnect when a connection exists but lists nothing", async () => {
    // Reconnecting is the only in-app move left; without the offer the user is
    // stuck looking at an empty picker.
    const state = await loadRepositoryPickerState(async (path) => {
      if (!path) return Response.json({
        connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
        integrations: [GITHUB_INTEGRATION],
      })
      return Response.json({ repositories: [] })
    })

    expect(state.repositories).toEqual([])
    expect(state.connectGitHub).toMatchObject({ id: "github" })
  })

  test("offers nothing when the deployment ships no usable GitHub integration", async () => {
    // A self-host with no GitHub app and no key method cannot connect, so an
    // offer would be a button that always fails.
    const state = await loadRepositoryPickerState(async () => Response.json({
      connections: [],
      integrations: [{ ...GITHUB_INTEGRATION, methods: [] }, { id: "linear", name: "Linear", methods: ["oauth"] }],
    }))

    expect(state.connectGitHub).toBeUndefined()
  })

  test("propagates a repository listing failure instead of masking it as 'connect GitHub'", async () => {
    // A broken token must not read as "you have no connection" — that would
    // send the user to connect a connection they already have.
    await expect(loadRepositoryPickerState(async (path) => {
      if (!path) return Response.json({
        connections: [{ id: "connection-1", integrationId: "github", status: "connected" }],
        integrations: [GITHUB_INTEGRATION],
      })
      return Response.json({ code: "repository_provider_unauthorized" }, { status: 502 })
    })).rejects.toThrow("Reconnect GitHub")
  })
})
