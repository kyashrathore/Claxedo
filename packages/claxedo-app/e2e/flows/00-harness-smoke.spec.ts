import fs from "node:fs/promises"
import path from "node:path"
import { acpScriptToken, assistantText, expect, frameType, git, SCRIPTED_ACP_HARNESS, test } from "../harness"

test("00 harness smoke: the stack boots, the app renders, a scripted ACP turn round-trips", async ({ stack, api, app }) => {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()

  const workspace = await stack.daemon.makeWorkspace("smoke")
  await stack.acp.write("smoke", { steps: [{ kind: "text", text: "Scripted hello from ACP" }] })
  const stream = await stack.events(workspace.directory)
  const session = await api.createSession(workspace.directory, { title: "Harness smoke", harness: SCRIPTED_ACP_HARNESS })

  await api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("smoke")}`)

  const messages = await api.messages(workspace.directory, session.id)
  expect(assistantText(messages)).toContain("Scripted hello from ACP")
  await stream.waitFor((frame) => frameType(frame) === "session.idle", { label: "session.idle" })
  const health = await api.health()
  expect(health).toBeTruthy()
})

test("00 harness smoke: a stack's git remote serves a clone over HTTP", async ({ stack }) => {
  const remote = await stack.gitRemote("smoke")
  const clone = path.join(stack.dataDir, "clone")
  await git(stack.dataDir, "clone", "-q", remote.url, clone)
  expect(await fs.readFile(path.join(clone, "README.md"), "utf8")).toBe("smoke-source\n")
})
