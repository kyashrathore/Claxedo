import { describe, expect, test } from "bun:test"
import { loadConnectedRepositories } from "./repository-picker"

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
