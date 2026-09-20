import { describe, expect, test } from "bun:test"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../../..")

describe("the workspace startup binding", () => {
  test("returns whatever composition installed, and the LAST installation wins", async () => {
    const probe = Bun.spawnSync({
      cmd: ["bun", "-e", `
        const { configureWorkspaceStartup, workspaceStartup } = await import("./src/platform/runtime/workspace-startup.ts")
        const port = (status) => ({
          prepareMachineRuntime: async () => ({ ok: true, status }),
          prepareWorkspaceRuntime: async () => ({ ok: true, startup: false, workspace: { workspaceId: status } }),
          prepareWorkspaceSessionWorktree: async () => ({ path: status, branch: status, baseCommit: status }),
        })
        configureWorkspaceStartup(port("first"))
        const first = await workspaceStartup().prepareMachineRuntime({ workspaceId: "ws" })
        configureWorkspaceStartup(port("second"))
        const second = await workspaceStartup().prepareMachineRuntime({ workspaceId: "ws" })
        console.log(JSON.stringify([first.status, second.status]))
      `],
      cwd: appRoot,
    })
    expect(probe.exitCode).toBe(0)
    expect(JSON.parse(probe.stdout.toString())).toEqual(["first", "second"])
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

    expect(probe.exitCode).toBe(0)
    const output = probe.stdout.toString().trim()
    expect(output).not.toBe("NO_THROW")
    expect(output).toContain("configureWorkspaceStartup")
    // The message must say which build is at fault, not just that something is
    // missing: reaching this in a local build means a hosted surface rendered
    // where it cannot work.
    expect(output).toContain("hosted workspace startup")
  })
})
