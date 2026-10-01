import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { generateNotifyScript } from "./core/hooks"

test("template command and aliases pass the notification harness gate when provider differs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-notify-gate-"))
  const template: StatusHookTemplate = {
    command: "plugin-cli",
    provider: "plugin-provider",
    aliases: ["plugin-alias"],
    install: { type: "wrapper-flags", args: [] },
    events: { Begin: "running" },
    subagent: [],
  }
  try {
    const notify = path.join(root, "notify.sh"),
      capture = path.join(root, "delivery.json")
    await fs.writeFile(notify, generateNotifyScript(4312, [template]))
    await fs.writeFile(path.join(root, "curl"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 })
    for (const command of [template.command, ...template.aliases!]) {
      await fs.rm(capture, { force: true })
      const child = Bun.spawn(
        ["/bin/bash", notify, "--harness=plugin-provider", JSON.stringify({ hook_event_name: "Begin" })],
        {
          env: {
            ...process.env,
            PATH: root + ":" + process.env.PATH,
            CLAXEDO_TAB_ID: "tab",
            CLAXEDO_AGENT: command,
            CAPTURE: capture,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(await child.exited).toBe(0)
      expect(await fs.readFile(capture, "utf8")).toContain('providerEvent={"hook_event_name":"Begin"}')
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
