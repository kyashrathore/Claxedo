import { afterEach, describe, expect, test } from "bun:test"
import { initialRouteWorkspace } from "./route-event-scope"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

const BASE_URL = "https://control.example"

// happy-dom's history does not move `location`; its own setter does. The
// window is shared by every file in this bun process, so the URL this suite
// navigates away from has to come back — `rail-sidebar.logic.test.ts` reads
// the page origin.
type HappyDomWindow = typeof window & { happyDOM: { setURL: (url: string) => void } }
const happyDOM = (window as HappyDomWindow).happyDOM
const pageUrl = window.location.href

function atRoute(pathname: string) {
  happyDOM.setURL(`https://app.example${pathname}`)
}

afterEach(() => {
  queryClient.clear()
  happyDOM.setURL(pageUrl)
})

describe("initialRouteWorkspace", () => {
  test("states the route workspace's host in the vocabulary the event scope is keyed by", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(BASE_URL), [{
      worktree: "/repo/main",
      workspaces: {
        "/tmp/hosted": { workspaceId: "ws_m", kind: "user-hosted", directory: "/tmp/hosted" },
      },
    }])
    atRoute("/w/%2Ftmp%2Fhosted")
    expect(initialRouteWorkspace(BASE_URL)).toEqual({
      directory: "/tmp/hosted",
      workspaceId: "ws_m",
      hostKind: "machine",
    })
  })

  test("a provisioner row reads as the provisioner, not as its wire word", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(BASE_URL), [{
      worktree: "/repo/main",
      workspaces: {
        "/repo/cloud": { workspaceId: "ws_p", kind: "cloud", directory: "/repo/cloud" },
      },
    }])
    atRoute("/w/%2Frepo%2Fcloud")
    expect(initialRouteWorkspace(BASE_URL)?.hostKind).toBe("provisioner")
  })

  // The signed bootstrap and the hosted shell state `backing` and no `kind`
  // (`signedBootstrapProjects` / `signedShellProjects`), and they address a row
  // by `workspace:<id>` — which is the form a `/w/<id>` deep link carries.
  test("a bootstrap row, which states backing and no kind, names the route workspace", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(BASE_URL), [{
      worktree: "ws_boot",
      workspaces: {
        ws_boot: {
          id: "ws_boot",
          backing: "local-worktree",
          workspace_name: "Main",
          directory: "workspace:ws_boot",
          remote_directory: "/Users/host/repo",
        },
      },
    }])
    atRoute("/w/workspace%3Aws_boot")
    expect(initialRouteWorkspace(BASE_URL)).toEqual({
      directory: "workspace:ws_boot",
      workspaceId: "ws_boot",
      hostKind: "machine",
    })
  })

  test("a row this server serves itself is not a route workspace", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(BASE_URL), [{
      worktree: "/repo/main",
      workspaces: {
        "/repo/main": { workspaceId: "ws_l", kind: "local", directory: "/repo/main" },
      },
    }])
    atRoute("/w/%2Frepo%2Fmain")
    expect(initialRouteWorkspace(BASE_URL)).toBeUndefined()
  })
})
