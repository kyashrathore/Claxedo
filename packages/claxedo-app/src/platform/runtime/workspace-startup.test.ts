import { describe, expect, test } from "bun:test"
import path from "node:path"
import { configureWorkspaceStartup, workspaceStartup } from "./workspace-startup"
import type { WorkspaceStartupPort } from "./workspace-startup-port"

const appRoot = path.resolve(import.meta.dir, "../../..")

function stubPort(label: string): WorkspaceStartupPort {
  return {
    prepareWorkspaceRuntime: async () => ({ ok: true, startup: false, workspace: { workspaceId: label } }),
    prepareUserHostedRuntime: async () => ({ ok: true, status: label }),
    prepareWorkspaceSessionWorktree: async () => ({ path: label, branch: label, baseCommit: label }),
  }
}

describe("the workspace startup binding", () => {
  test("returns whatever composition installed, and the LAST installation wins", async () => {
    configureWorkspaceStartup(stubPort("first"))
    expect((await workspaceStartup().prepareUserHostedRuntime({ workspaceId: "ws" })).status).toBe("first")

    // Rebinding is how a test harness substitutes the hosted implementation.
    // Asserted rather than assumed, because "the second call is ignored" would
    // make every harness silently exercise whichever module loaded first.
    configureWorkspaceStartup(stubPort("second"))
    expect((await workspaceStartup().prepareUserHostedRuntime({ workspaceId: "ws" })).status).toBe("second")
  })

  test("throws, naming itself, when this build bound nothing", async () => {
    // Run in a FRESH process on purpose. `boundPort` is module state, and Bun
    // shares the module registry across the files in a test run — the submit
    // harness binds the hosted implementation, so an in-process assertion about
    // the unbound state would pass or fail on file ordering. A subprocess is
    // the only place "no one has configured this yet" is a real condition.
    const probe = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `const { workspaceStartup } = await import("./src/platform/runtime/workspace-startup.ts")
         try { workspaceStartup(); console.log("NO_THROW") } catch (error) { console.log(String(error.message)) }`,
      ],
      cwd: appRoot,
    })

    const output = probe.stdout.toString().trim()
    expect(output).not.toBe("NO_THROW")
    expect(output).toContain("configureWorkspaceStartup")
    // The message must say which build is at fault, not just that something is
    // missing: reaching this in a local build means a hosted surface rendered
    // where it cannot work.
    expect(output).toContain("hosted workspace startup")
  })
})
