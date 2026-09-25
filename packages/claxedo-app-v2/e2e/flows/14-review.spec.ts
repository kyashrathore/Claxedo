import fs from "node:fs/promises"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, expect, git, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

async function commentOnLine(panel: Locator, line: string, comment: string) {
  const gutter = panel.getByRole("button", { name: "Comment", exact: true }).first()
  await expect(async () => {
    await panel.getByText(line).first().hover()
    await expect(gutter).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await gutter.click()
  await panel.getByRole("textbox", { name: "Add comment" }).fill(comment)
  await panel.getByRole("button", { name: "Comment", exact: true }).last().click()
}

function lastSubject(directory: string, ref = "HEAD") {
  return git(directory, "log", "-1", "--format=%s", ref).then(
    (subject) => subject.trim(),
    (error: Error) => error.message,
  )
}

async function watchLongTasks(app: Page) {
  await app.evaluate(() => {
    const durations: number[] = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration)
    }).observe({ type: "longtask" })
    Reflect.set(window, "__claxedoLongTasks", durations)
  })
  return () => app.evaluate(() => Math.max(0, ...(Reflect.get(window, "__claxedoLongTasks") as number[])))
}

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

test("14 review: diff, line comment, commit, push to a bare remote, the comment reaches the agent", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("review")
  const remote = path.join(stack.dataDir, "remote.git")
  await git(stack.dataDir, "init", "-q", "--bare", remote)
  await git(workspace.directory, "remote", "add", "origin", remote)
  await fs.appendFile(path.join(workspace.directory, "README.md"), "a reviewed line\n")
  await stack.acp.write("answer", { steps: [{ kind: "text", text: "Read your line comment." }] })
  const session = await api.createSession(workspace.directory, { title: "Review", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  if (stack.app === "v2") {
    await test.step("DECISIONS 22:05: no edge strip", async () => {
      await app.getByRole("button", { name: UI.openPanel }).click()
      await panel.getByRole("button", { name: "Review", exact: true }).click()
      await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
    })
  } else {
    await app.getByRole("button", { name: "Open changes" }).click()
  }
  await panel.getByRole("button", { name: "Toggle diff for README.md" }).click()
  await commentOnLine(panel, "a reviewed line", "Why was this line added?")
  await expect(panel.getByText("Why was this line added?")).toBeVisible()

  await panel.getByRole("button", { name: "Stage all" }).click()
  await expect(panel.getByRole("button", { name: "Staged changes (1)" })).toBeVisible()
  await panel.getByRole("textbox", { name: "Message (⌘⏎ to commit)" }).fill("Add a reviewed line")
  await panel.getByRole("button", { name: "Commit", exact: true }).click()
  await expect(panel.getByRole("button", { name: "Staged changes (0)" })).toBeVisible()
  await expect(panel.getByText("No changes", { exact: true })).toBeVisible()
  await expect.poll(() => lastSubject(workspace.directory)).toBe("Add a reviewed line")

  await panel.getByRole("button", { name: "Publish Branch" }).click()
  await expect.poll(() => lastSubject(remote, "main")).toBe("Add a reviewed line")

  await sendPrompt(app, `Answer my review comment. ${acpScriptToken("answer")}`)
  await expect(app.getByText("Read your line comment.")).toBeVisible()
  expect(JSON.stringify(await api.messages(workspace.directory, session.id))).toContain("Why was this line added?")
})

test("14 a file three folders deep opens from the files tree without blocking the page", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("deep")
  await fs.mkdir(path.join(workspace.directory, "one/two/three"), { recursive: true })
  await fs.writeFile(path.join(workspace.directory, "one/two/three/deep.ts"), "export const depth = \"three folders down\"\n")
  await git(workspace.directory, "add", "-A")
  await git(workspace.directory, "commit", "-qm", "a nested file")
  const session = await api.createSession(workspace.directory, { title: "Deep", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  for (const folder of ["one", "two", "three"]) await panel.getByRole("treeitem", { name: folder, exact: true }).click()
  const longest = await watchLongTasks(app)
  await panel.getByRole("treeitem", { name: /^deep\.ts/ }).click()
  await expect(panel.getByText("three folders down").first()).toBeVisible()
  expect(await longest(), "the longest task while the file opened, in ms").toBeLessThan(1_000)
})

test("14 Review keeps its scroll position through a file tab and back", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("scrollback")
  await fs.writeFile(path.join(workspace.directory, "long.txt"), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"))
  await fs.writeFile(path.join(workspace.directory, "other.txt"), "other\n")
  const session = await api.createSession(workspace.directory, { title: "Scroll", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  const review = panel.getByTestId("review-pane-root")
  await review.getByRole("button", { name: "Toggle diff for long.txt" }).click()
  await expect(review.getByText("line 5", { exact: true }).first()).toBeVisible()
  const scroller = review.locator("[data-scrollable='true']").first()
  await scroller.evaluate((element) => (element.scrollTop = 900))
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200)

  await panel.getByRole("treeitem", { name: /^other\.txt/ }).click()
  await expect(panel.getByTestId("tab-file-root")).toBeVisible()
  await panel.getByTestId("workspace-tab-scroll").getByText("Review", { exact: true }).click()
  await expect
    .poll(() => review.locator("[data-scrollable='true']").first().evaluate((element) => element.scrollTop))
    .toBeGreaterThan(200)
})

test("14 searching files narrows the tree to the matches, reads no folder while typing, and clearing keeps their folders open", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 lists every matching folder on each keystroke")
  const workspace = await stack.daemon.makeWorkspace("search")
  for (const [file, text] of [["src/needle.ts", "a"], ["src/deep/needle-notes.md", "b"], ["src/other.ts", "c"], ["docs/guide.md", "d"], ["top.md", "e"]]) {
    await fs.mkdir(path.dirname(path.join(workspace.directory, file)), { recursive: true })
    await fs.writeFile(path.join(workspace.directory, file), `${text}\n`)
  }
  await git(workspace.directory, "add", "-A")
  await git(workspace.directory, "commit", "-qm", "files to search")
  const session = await api.createSession(workspace.directory, { title: "Search", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  const row = (name: string) => panel.getByRole("treeitem", { name: new RegExp(`^${name.replaceAll(".", "\\.")}`) })
  await expect(row("top.md")).toBeVisible()
  const listings: string[] = []
  app.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/wr/file" && url.searchParams.has("path")) listings.push(url.searchParams.get("path") ?? "")
  })

  await panel.getByPlaceholder("Search files...").pressSequentially("needle")
  for (const name of ["src", "deep", "needle.ts", "needle-notes.md"]) await expect(row(name)).toBeVisible()
  for (const name of ["other.ts", "docs", "top.md"]) await expect(row(name)).toBeHidden()
  expect(listings, "folder listings read while searching").toEqual([])

  await panel.getByRole("button", { name: "Clear search" }).click()
  for (const name of ["top.md", "docs", "other.ts", "needle.ts", "needle-notes.md"]) await expect(row(name)).toBeVisible()
  expect(listings.sort()).toEqual(["src", "src/deep"])
})
