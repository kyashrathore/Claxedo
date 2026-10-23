import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { connectMachine, expect, git, gitFolder, sendPrompt, sessionRoute, showHarnesses, test, UI, type SignedStack } from "../harness"

type MachineRow = { workspace_id: string; project_id: string; backing?: string; remote_directory?: string; repo_url?: string; git_branch?: string; placement?: { host_enrollment_id?: string } }

async function machineRows(signed: SignedStack): Promise<readonly MachineRow[]> {
  const listed = await signed.owner.transport({ method: "GET", url: `${signed.hosted.workerUrl}/api/workspace?host=provisioner`, headers: {} })
  expect(listed.status, listed.body).toBe(200)
  return (JSON.parse(listed.body) as { workspaces: MachineRow[] }).workspaces.filter((row) => row.backing === "local-worktree")
}

function projectChip(page: Page) {
  return page.getByRole("button", { name: "Project", exact: true })
}

async function openCreateDialog(page: Page) {
  await projectChip(page).click()
  await expect(page.getByRole("textbox", { name: "Search projects" })).toBeFocused()
  await page.getByRole("button", { name: "Create project…" }).click()
  return page.getByRole("dialog", { name: "Create project" })
}

test("02 projects on a connected machine: the machine's own folder dialog picks a folder there, and it becomes a project served by that machine", async ({ signed, page }, testInfo) => {
  test.setTimeout(180_000)
  const machine = await connectMachine(signed, "build-box", testInfo)
  try {
    const alpha = await gitFolder(path.join(machine.home, "folders"), "alpha")
    await signed.signIn(page, signed.owner)
    await page.goto(`${signed.url}${sessionRoute(machine.firstWorkspaceId)}`)
    await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()

    const create = await openCreateDialog(page)
    await expect(create.getByRole("button", { name: "Create project", exact: true })).toBeDisabled()
    await expect(create.getByText("Folder on build-box", { exact: true })).toBeVisible()
    await create.getByRole("button", { name: "Choose folder" }).click()
    const folders = page.getByRole("dialog", { name: "New Project" })
    await folders.getByRole("textbox", { name: "Search folders" }).fill("~/folders/al")
    await folders.getByRole("button", { name: / alpha \/$/ }).click()
    await expect(folders).toHaveCount(0)
    await expect(create.getByRole("button", { name: "Choose folder" })).toContainText(alpha)
    await create.getByRole("button", { name: "Create project", exact: true }).click()
    await expect(create).toHaveCount(0)
    await expect(projectChip(page)).toContainText("alpha")

    const row = (await machineRows(signed)).find((candidate) => candidate.remote_directory === alpha)
    expect(row?.placement?.host_enrollment_id, "the folder is a workspace on that machine").toBeTruthy()
    expect(row?.workspace_id).not.toBe(machine.firstWorkspaceId)
    await expect.poll(() => machine.servedWorkspaceIds(), { timeout: 30_000 }).toContain(row?.workspace_id)
  } finally {
    await machine.close()
  }
})

test("02 projects on a connected machine: a repository is cloned onto the machine into a folder beside the one it shares, or one picked there", async ({ signed, page }, testInfo) => {
  test.setTimeout(180_000)
  const machine = await connectMachine(signed, "build-box", testInfo)
  try {
    await fs.mkdir(path.join(machine.home, "clones"))
    await signed.signIn(page, signed.owner)
    await page.goto(`${signed.url}${sessionRoute(machine.firstWorkspaceId)}`)
    await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()

    const create = await openCreateDialog(page)
    await create.getByRole("button", { name: "Repository", exact: true }).click()
    await create.getByRole("button", { name: "Paste URL", exact: true }).click()
    await create.getByRole("textbox", { name: "Repository URL" }).fill(signed.hosted.gitUrl)
    const onto = create.getByRole("button", { name: /^Clone onto/ })
    await expect(onto).toContainText("Cloud")
    await onto.click()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await expect(onto).toContainText("build-box")
    await expect(create.getByText("Clone into a folder on build-box", { exact: true })).toBeVisible()
    const into = create.getByRole("button", { name: "Choose folder" })
    await expect(into).toContainText(machine.home)

    await into.click()
    const folders = page.getByRole("dialog", { name: "New Project" })
    await folders.getByRole("textbox", { name: "Search folders" }).fill("~/clo")
    await folders.getByRole("button", { name: / clones \/$/ }).click()
    await expect(folders).toHaveCount(0)
    const clones = path.join(machine.home, "clones")
    await expect(into).toContainText(clones)
    await create.getByRole("button", { name: "Create project", exact: true }).click()
    await expect(create).toHaveCount(0)
    await expect(projectChip(page)).toContainText("repo")

    const checkout = path.join(clones, "repo")
    expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe("Hosted test repository\n")
    const row = (await machineRows(signed)).find((candidate) => candidate.remote_directory === checkout)
    expect(row?.placement?.host_enrollment_id, "the clone is a workspace on that machine").toBeTruthy()
    expect(row?.repo_url).toBe(signed.hosted.gitUrl)
    await expect.poll(() => machine.servedWorkspaceIds(), { timeout: 30_000 }).toContain(row?.workspace_id)
  } finally {
    await machine.close()
  }
})

async function chooseScriptedHarness(page: Page) {
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await picker.getByText(/Scripted ACP/).first().click()
  await page.keyboard.press("Escape")
}

test("02 projects on a connected machine: a new worktree picked in the Where chip is made on that machine from the chosen base on the first send", async ({ signed, page }, testInfo) => {
  test.setTimeout(180_000)
  const machine = await connectMachine(signed, "build-box", testInfo)
  try {
    await gitFolder(machine.home, "app")
    await git(machine.folder, "branch", "release")
    await signed.signIn(page, signed.owner)
    await page.goto(`${signed.url}${sessionRoute(machine.firstWorkspaceId)}`)
    await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
    const where = page.getByRole("button", { name: "Where it runs", exact: true })
    await where.click()
    await page.getByRole("button", { name: "New worktree on build-box", exact: true }).click()
    await expect(where).toHaveText("New worktree")
    await page.getByRole("button", { name: "Base branch", exact: true }).click()
    await page.getByRole("textbox", { name: "Search branches" }).fill("release")
    await page.keyboard.press("Enter")
    await chooseScriptedHarness(page)

    const made = page.waitForResponse((response) => response.url().endsWith("/worktree") && response.url().includes("/api/claxedo/host/machines/") && response.request().method() === "POST")
    await sendPrompt(page, "Start in a worktree on build-box")
    const answer = await made
    expect(answer.status()).toBe(200)
    const created = await answer.json() as { directory: string; branch: string; name: string }
    await expect(page.getByRole("button", { name: "Where it runs", exact: true, includeHidden: true })).toHaveText(created.name)

    expect(created.directory.startsWith(path.join(machine.home, ".claxedo", "worktree"))).toBe(true)
    expect((await git(created.directory, "rev-parse", "HEAD")).trim()).toBe((await git(machine.folder, "rev-parse", "release")).trim())
    const rows = await machineRows(signed)
    const first = rows.find((candidate) => candidate.workspace_id === machine.firstWorkspaceId)
    const row = rows.find((candidate) => candidate.remote_directory === created.directory)
    expect(row?.project_id, "the worktree is a placement of the folder's project").toBe(first?.project_id)
    expect(row?.git_branch).toBe(created.branch)
    await expect.poll(() => machine.servedWorkspaceIds(), { timeout: 30_000 }).toContain(row?.workspace_id)
    await expect(page, "the draft's route names the worktree it now runs in").toHaveURL(new RegExp(`/w/${row?.workspace_id}/session`))
  } finally {
    await machine.close()
  }
})
