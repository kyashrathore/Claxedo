import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

for (const renderer of ["file", "http"] as const) {
  test.describe(`${renderer} renderer`, () => {
    test.use({ desktopRenderer: renderer })

    test("42 transcript file links: an artifact outside the workspace opens through the OS and its path can be copied", { tag: "@desktop" }, async ({ desktop }) => {
      const artifact = path.join(desktop.dataDir, "verification details.md")
      await fs.writeFile(artifact, "Verified artifact.\n")
      const workspace = await desktop.makeWorkspace("artifact-links")
      await desktop.acp.write("artifact-links", { steps: [{ kind: "text", text: `[Verification details](<${artifact}>) · [File URL](<${pathToFileURL(artifact).href}>)` }] })
      const session = await desktop.api.createSession(workspace.directory, { title: "Artifact links", harness: SCRIPTED_ACP_HARNESS })
      await desktop.api.prompt(workspace.directory, session.id, `Show the artifact. ${acpScriptToken("artifact-links")}`)
      await desktop.electron.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.defineProperty(globalThis, "__transcriptOpenedPaths", { configurable: true, value: opened })
        Object.defineProperty(shell, "openPath", { configurable: true, value: async (file: string) => { opened.push(file); return "" } })
      })
      const opened = () => desktop.electron.evaluate(() => (globalThis as { __transcriptOpenedPaths?: string[] }).__transcriptOpenedPaths ?? [])
      const window = desktop.window
      await window.reload()
      await window.bringToFront()
      await window.getByRole("button", { name: "Artifact links", exact: true }).click()
      const link = window.getByRole("link", { name: "Verification details", exact: true })
      await expect(link).toBeVisible()
      await link.click()
      await expect.poll(opened).toEqual([artifact])
      await link.click({ button: "right" })
      await window.getByRole("button", { name: "Copy path", exact: true }).click()
      await expect.poll(() => desktop.electron.evaluate(({ clipboard }) => clipboard.readText())).toBe(artifact)
      await link.click({ button: "right" })
      await window.getByRole("button", { name: "Open externally", exact: true }).click()
      await expect.poll(opened).toEqual([artifact, artifact])
      await window.getByRole("link", { name: "File URL", exact: true }).click()
      await expect.poll(opened).toEqual([artifact, artifact, artifact])
      await desktop.electron.evaluate(({ shell }) => {
        Object.defineProperty(shell, "openPath", { configurable: true, value: async () => "The file has no application to open it." })
      })
      await link.click()
      await expect(window.getByText("The file has no application to open it.", { exact: false })).toBeVisible()
      expect(assistantText(await desktop.api.messages(workspace.directory, session.id))).toContain(artifact)
    })
  })
}

test("42 transcript file links: a workspace Markdown link opens its file and copies the canonical path", async ({ stack, api, app }) => {
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"])
  const workspace = await stack.daemon.makeWorkspace("markdown-file-links")
  await stack.acp.write("markdown-file-links", { steps: [{ kind: "text", text: `[Project notes](<${workspace.directory}/README.md:1>) · [Local artifact](/tmp/verification-details.md)` }] })
  const session = await api.createSession(workspace.directory, { title: "Markdown file links", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Show the notes. ${acpScriptToken("markdown-file-links")}`)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  const link = app.getByRole("link", { name: "Project notes", exact: true })
  await expect(link).toBeVisible()
  await link.click({ button: "right" })
  await app.getByRole("button", { name: "Copy path", exact: true }).click()
  expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(`${workspace.directory}/README.md`)
  const artifact = app.getByRole("link", { name: "Local artifact", exact: true })
  await artifact.click({ button: "right" })
  await expect(app.getByRole("button", { name: "Open externally", exact: true })).toHaveCount(0)
  await app.getByRole("button", { name: "Open", exact: true }).click()
  await expect(app.getByText("This file cannot be opened on this computer.", { exact: true })).toBeVisible()
  await link.click()
  await expect(app.getByRole("complementary", { name: "Workspace panel" }).getByText("markdown-file-links", { exact: true }).first()).toBeVisible()
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("README.md:1")
})
