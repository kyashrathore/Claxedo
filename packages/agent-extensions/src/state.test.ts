import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  agentExtensionStateRoot,
  installedStatePath,
  readDesiredExtensionState,
  removeDesiredExtensionInstall,
  upsertDesiredExtensionInstall,
} from "./state"

const root = path.join(os.tmpdir(), `agent-extensions-state-${randomUUID().slice(0, 8)}`)
const project = path.join(root, "project")
const data = path.join(root, "data")

function install(id: string, packageName = id) {
  return {
    id,
    package_name: packageName,
    source: { type: "github" as const, owner: "acme", repo: "tools" },
    scope: "project" as const,
    enabled: true,
    targets: ["cursor" as const, "claude" as const],
    installed_at: 20,
    updated_at: 30,
  }
}

describe("Agent Extension desired state", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(project, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("uses project and machine state roots without crossing scopes", () => {
    expect(agentExtensionStateRoot({ scope: "project", projectDir: project })).toBe(path.join(project, ".agent-extensions"))
    expect(agentExtensionStateRoot({ scope: "machine", dataRoot: data })).toBe(path.join(data, "agent-extensions"))
    expect(installedStatePath({ scope: "machine", dataRoot: data })).toBe(path.join(data, "agent-extensions", "installed.json"))
  })

  test("requires projectDir for project state", () => {
    expect(() => agentExtensionStateRoot({ scope: "project" })).toThrow("projectDir is required")
  })

  test("refuses to treat a corrupted state file as empty", async () => {
    const file = installedStatePath({ scope: "project", projectDir: project })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{ truncated")
    await expect(readDesiredExtensionState(file)).rejects.toThrow("not valid JSON")
  })

  test("reads a missing state file as empty", async () => {
    const file = installedStatePath({ scope: "project", projectDir: project })
    await expect(readDesiredExtensionState(file)).resolves.toEqual({ version: 1, installs: [] })
  })

  test("writes deterministic sorted project install records", async () => {
    const file = installedStatePath({ scope: "project", projectDir: project })
    await upsertDesiredExtensionInstall(file, install("zeta"))
    await upsertDesiredExtensionInstall(file, install("alpha"))

    expect(await readDesiredExtensionState(file)).toEqual({
      version: 1,
      installs: [
        { ...install("alpha"), targets: ["claude", "cursor"] },
        { ...install("zeta"), targets: ["claude", "cursor"] },
      ],
    })
    expect(await fs.readFile(file, "utf8")).toMatchInlineSnapshot(`
      "{
        "version": 1,
        "installs": [
          {
            "id": "alpha",
            "package_name": "alpha",
            "source": {
              "type": "github",
              "owner": "acme",
              "repo": "tools"
            },
            "scope": "project",
            "enabled": true,
            "targets": [
              "claude",
              "cursor"
            ],
            "installed_at": 20,
            "updated_at": 30
          },
          {
            "id": "zeta",
            "package_name": "zeta",
            "source": {
              "type": "github",
              "owner": "acme",
              "repo": "tools"
            },
            "scope": "project",
            "enabled": true,
            "targets": [
              "claude",
              "cursor"
            ],
            "installed_at": 20,
            "updated_at": 30
          }
        ]
      }
      "
    `)
  })

  test("removes only the requested desired install", async () => {
    const file = installedStatePath({ scope: "project", projectDir: project })
    await upsertDesiredExtensionInstall(file, install("alpha"))
    await upsertDesiredExtensionInstall(file, install("zeta"))
    await removeDesiredExtensionInstall(file, "alpha")

    expect((await readDesiredExtensionState(file)).installs.map((item) => item.id)).toEqual(["zeta"])
  })
})
