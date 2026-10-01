import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultStatusHooks, defaultGenericWrappers } from "../status-hooks"
import { createStatusHooksManifest, writeStatusHooksArtifacts } from "./core/setup"
import { BIN_DIR } from "./core/constants"
import { projectHookContent } from "./core/render"
import { materializeAgentHooks } from "./materialize-status-hooks"
import { providerLifecycle } from "./provider-lifecycle"
import files from "./fixtures/base-files.json"
import cases from "./fixtures/base-lifecycle.json"

test("nine first-party templates reproduce the base wrappers, configs, hook artifacts and project file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "status-hooks-golden-"))
  try {
    const manifest = createStatusHooksManifest(path.join(root, "data"))
    await writeStatusHooksArtifacts(manifest, {
      templates: defaultStatusHooks,
      genericWrappers: defaultGenericWrappers,
      port: 4312,
    })
    expect(
      (
        await materializeAgentHooks({
          homeDir: path.join(root, "home"),
          notifyPath: manifest.files.notify,
          templates: defaultStatusHooks,
        })
      ).filter((result) => result.status !== "applied"),
    ).toEqual([])
    const actual: Record<string, string> = {}
    for (const dir of ["data/hooks", "data/bin", "home"]) {
      for (const name of await fs.readdir(path.join(root, dir), { recursive: true })) {
        const file = path.join(root, dir, name)
        if (!(await fs.stat(file)).isFile() || name === "notify.sh") continue
        actual[`${dir}/${name}`] = (await fs.readFile(file, "utf8"))
          .replaceAll(BIN_DIR, "{{bin}}")
          .replaceAll(root, "{{root}}")
      }
    }
    const project = defaultStatusHooks.find((template) => template.install.type === "project-file")!
    actual[`project/${project.install.type === "project-file" ? project.install.path : ""}`] = projectHookContent(
      project,
      manifest.files.notify,
    ).replaceAll(root, "{{root}}")
    const { "data/hooks/notify.sh": _notify, ...expected } = files
    expect(defaultStatusHooks).toHaveLength(9)
    for (const command of defaultGenericWrappers) {
      const file = `data/bin/${command}` as keyof typeof expected
      expected[file] = expected[file].replaceAll('"hook_event_name":', '"eventType":')
    }
    expect(actual).toEqual(expected)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("every captured event and conditional payload retains the base lifecycle result", () => {
  for (const { input, output } of cases) {
    const actual = providerLifecycle(input, defaultStatusHooks)
    expect({ input, output: actual ? JSON.parse(JSON.stringify(actual)) : null }).toEqual({ input, output })
  }
})
