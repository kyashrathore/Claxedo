import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { composeCursorHome, cursorHomeKey } from "."

test("selected execution excludes personal plugins while default execution retains them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-selected-"))
  try {
    const personal = path.join(root, "personal")
    await fs.mkdir(path.join(personal, "plugins/local/unselected"), { recursive: true })
    await fs.writeFile(path.join(personal, "plugins/local/unselected/plugin.json"), '{"name":"unselected"}')
    const selected = path.join(root, "selected")
    await fs.mkdir(selected)
    await fs.writeFile(path.join(selected, "plugin.json"), '{"name":"selected"}')
    const projection = { pluginRoots: [{ pluginInstanceId: "selected", root: selected, dataRoot: root, skillNames: [] }],
      pluginSelection: { mode: "selected" as const, selectionHash: "selection-a" } }
    const { home } = await composeCursorHome({ root, key: "shared", personalCursorDir: personal, projection })
    const names = await fs.readdir(path.join(home, ".cursor/plugins/local"))
    expect(names).not.toContain("unselected")
    expect(names.some((name) => name.startsWith("claxedo--"))).toBe(true)
    const all = { ...projection, pluginSelection: { mode: "default" as const } }
    await composeCursorHome({ root, key: "shared", personalCursorDir: personal, projection: all })
    expect(await fs.readdir(path.join(home, ".cursor/plugins/local"))).toContain("unselected")
    await composeCursorHome({ root, key: "shared", personalCursorDir: personal, projection })
    expect(await fs.readdir(path.join(home, ".cursor/plugins/local"))).not.toContain("unselected")
    const owner = { kind: "machine-owner" as const }
    expect(cursorHomeKey(owner, { machineOwnerUserId: "owner" }, "own", projection))
      .not.toBe(cursorHomeKey(owner, { machineOwnerUserId: "owner" }, "own", all))
    expect(cursorHomeKey(owner, { machineOwnerUserId: "owner" }, "own", { ...projection, pluginSelection: { mode: "selected", selectionHash: "selection-b" } }))
      .toBe(cursorHomeKey(owner, { machineOwnerUserId: "owner" }, "own", projection))
    expect(await fs.readFile(path.join(personal, "plugins/local/unselected/plugin.json"), "utf8")).toBe('{"name":"unselected"}')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
