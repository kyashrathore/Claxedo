import fs from "node:fs/promises"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { acpScriptToken, apiRequests, assistantText, expect, git, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

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
  await test.step("DECISIONS 22:05: no edge strip", async () => {
    await app.getByRole("button", { name: UI.openPanel }).click()
    await panel.getByRole("button", { name: "Review", exact: true }).click()
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
  })
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

test("14 clearing a search that opened many folders keeps them open and draws only the rows in view", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("wide")
  for (let folder = 0; folder < 30; folder += 1) {
    for (let item = 0; item < 8; item += 1) {
      const file = path.join(workspace.directory, `folder-${String(folder).padStart(2, "0")}`, `${item === 0 ? "needle" : "file"}-${item}.ts`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `export const value = ${item}\n`)
    }
  }
  await git(workspace.directory, "add", "-A")
  await git(workspace.directory, "commit", "-qm", "a wide tree")
  const session = await api.createSession(workspace.directory, { title: "Wide", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  const tree = panel.getByRole("tree")
  await expect(tree.getByRole("treeitem", { name: "folder-00", exact: true })).toBeVisible()
  await panel.getByPlaceholder("Search files...").pressSequentially("needle")
  await expect(tree.getByRole("treeitem", { name: /^needle-0\.ts/ }).first()).toBeVisible()

  const settled = apiRequests(app, stack.url)
  await panel.getByRole("button", { name: "Clear search" }).click()
  await expect(tree.getByRole("treeitem", { name: /^file-1\.ts/ }).first()).toBeVisible()
  await settled()
  await expect(tree.getByRole("treeitem", { name: "folder-00", exact: true })).toHaveAttribute("aria-expanded", "true")
  expect(await tree.getByRole("treeitem").count(), "rows drawn after clearing").toBeLessThan(80)
  await tree.getByRole("treeitem", { name: "folder-00", exact: true }).focus()
  await app.keyboard.press("End")
  await expect(tree.getByRole("treeitem", { name: "folder-23", exact: true })).toBeVisible()
  await expect(tree.getByRole("button", { name: /^Show \d+ more$/ })).toBeVisible()
  expect((await api.session(workspace.directory, session.id)).title).toBe("Wide")
})

test("14 a folder row scrolled away behind eight open folders comes back at its level when the tree returns to the top", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("sections")
  for (let index = 0; index < 160; index += 1) {
    const file = path.join(workspace.directory, `src/section-${String(index % 16).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.ts`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `export const value = ${index}\n`)
  }
  await git(workspace.directory, "add", "-A")
  await git(workspace.directory, "commit", "-qm", "sixteen sections")
  const session = await api.createSession(workspace.directory, { title: "Sections", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const tree = app.getByRole("complementary", { name: "Workspace panel" }).getByRole("tree")
  const src = tree.getByRole("treeitem", { name: "src", exact: true })
  await expect(src).toHaveAttribute("aria-level", "1")
  await src.click()
  for (let section = 0; section < 8; section += 1) {
    await tree.getByRole("treeitem", { name: `section-${String(section).padStart(3, "0")}`, exact: true }).click()
    await expect(tree.getByRole("treeitem", { name: new RegExp(`^file-${String(section).padStart(5, "0")}\\.ts`) })).toBeVisible()
  }
  await expect(src).toHaveCount(0)

  await tree.getByRole("treeitem", { name: "section-007", exact: true }).focus()
  await app.keyboard.press("Home")
  await expect(src).toBeFocused()
  await expect(src).toHaveAttribute("aria-level", "1")
  await expect(src).toHaveAttribute("aria-expanded", "true")
  for (const section of ["section-000", "section-001"]) {
    await expect(tree.getByRole("treeitem", { name: section, exact: true })).toHaveAttribute("aria-level", "2")
  }
})

test("14 the files and git state are read again once after a turn that could write, and not after a turn that only read", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("turn-reads")
  const notes = path.join(workspace.directory, "README.md")
  await stack.acp.write("read-only", { steps: [{ kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: notes }], text: "turn-reads\n" }, { kind: "text", text: "Only read the README." }] })
  await stack.acp.write("edit", { steps: [{ kind: "diff", path: notes, oldText: "turn-reads\n", newText: "turn-reads, edited\n" }, { kind: "text", text: "Edited the README." }] })
  const session = await api.createSession(workspace.directory, { title: "Turn reads", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await app.getByRole("button", { name: UI.openPanel }).click()
  const panel = app.getByRole("complementary", { name: "Workspace panel" })
  await expect(panel.getByRole("treeitem", { name: /^README\.md/ })).toBeVisible()
  const settled = apiRequests(app, stack.url)
  await settled()
  const filesAndGit = (paths: readonly string[]) => paths.filter((path) => /^\/api\/wr\/(file|git|diff)(\/|$)/.test(path)).sort()

  await api.prompt(workspace.directory, session.id, `Read the README. ${acpScriptToken("read-only")}`)
  await expect(app.getByText("Only read the README.")).toBeVisible()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  expect(filesAndGit(await settled()), "reads after a turn that only read").toEqual([])

  await api.prompt(workspace.directory, session.id, `Edit the README. ${acpScriptToken("edit")}`)
  await expect(app.getByText("Edited the README.")).toBeVisible()
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  const reads = filesAndGit(await settled())
  expect(reads, "reads after a turn that could write").toContain("/api/wr/git/status")
  expect(reads.filter((path, index) => reads.indexOf(path) !== index), "read twice").toEqual([])
  expect(assistantText(await api.messages(workspace.directory, session.id))).toContain("Edited the README.")
})
