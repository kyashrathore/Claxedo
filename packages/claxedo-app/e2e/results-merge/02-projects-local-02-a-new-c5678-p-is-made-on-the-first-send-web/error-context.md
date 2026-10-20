# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-projects-local.spec.ts >> 02 a new local worktree picked in the Where chip is made on the first send
- Location: e2e/flows/02-projects-local.spec.ts:173:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('button', { name: 'Current branch' })
Expected substring: "main"
Received string:    "master"
Timeout: 10000ms

Call log:
  - Expect "toContainText" with timeout 10000ms
  - waiting for getByRole('button', { name: 'Current branch' })
    24 × locator resolved to <button disabled type="button" data-closed="" data-disabled="" aria-expanded="false" aria-haspopup="dialog" aria-label="Current branch" data-chip="context-chip-branch" class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-compact font-body leading-4 text-v2-text-text-muted transition-colors duration-150 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:pointer-events-none disabled:opacity-50 data-[expanded]:bg-v2-overlay-simple-overlay-hover data-[expand…>…</button>
       - unexpected value "master"

```

```yaml
- button "Current branch" [disabled]: master
```

# Test source

```ts
  81  |     await expect(app.getByRole("heading", { level: 2, name: to })).toBeVisible()
  82  |   })
  83  |   await test.step("a server that offers no cloud workspace shows no project environment, which only a cloud workspace is handed", async () => {
  84  |     await expect(app.getByRole("group", { name: "Where it runs" })).toBeVisible()
  85  |     await expect(app.getByRole("group", { name: "Environment" })).toHaveCount(0)
  86  |   })
  87  | }
  88  | 
  89  | async function removeProject(stack: Stack, app: Page, id: string, name: string) {
  90  |   await test.step("DECISIONS 12: Remove asks first, then removes the project everywhere", async () => {
  91  |     await app.goto(`${stack.url}/settings/projects?project=${encodeURIComponent(id)}`)
  92  |     const confirm = app.getByRole("dialog", { name: "Remove project" })
  93  |     await app.getByRole("button", { name: "Remove", exact: true }).click()
  94  |     await expect(confirm).toContainText(`Remove "${name}" from Claxedo?`)
  95  |     await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  96  |     await expect(confirm).toHaveCount(0)
  97  |     expect((await serverProject(stack.url, id)).status).toBe(200)
  98  |     await app.getByRole("button", { name: "Remove", exact: true }).click()
  99  |     const remove = confirm.getByRole("button", { name: "Remove", exact: true })
  100 |     await expect(remove).toHaveAttribute("data-variant", "danger")
  101 |     await expectFooterAtDialogInset(confirm, remove)
  102 |     await remove.click()
  103 |     await expect(app).toHaveURL(/\/settings\/projects$/)
  104 |     await expect(app.getByRole("region", { name: "Projects" }).getByRole("link", { name, exact: true })).toHaveCount(0)
  105 |     expect((await serverProject(stack.url, id)).status).toBe(404)
  106 |   })
  107 | }
  108 | 
  109 | test("02 projects, local: create a folder and a clone from the Project chip, edit, remove, each read back by id", async ({ stack, page: app }) => {
  110 |   const existing = await stack.daemon.makeWorkspace("existing")
  111 |   const alphaFolder = await gitFolder(path.join(stack.dataDir, "folders"), "alpha")
  112 |   const remote = await stack.gitRemote("beta")
  113 |   await app.goto(`${stack.url}${sessionRoute(existing.id)}`)
  114 |   await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  115 |   await expect(projectChip(app)).toContainText(path.basename(existing.directory))
  116 | 
  117 |   await createFolderProject(app, "~/folders/alpha", "alpha")
  118 |   const alpha = (await serverProjects(stack.url)).find((project) => project.name === "alpha")
  119 |   expect(await fs.realpath(alpha?.directory ?? "")).toBe(alphaFolder)
  120 |   const alphaId = alpha?.id ?? ""
  121 | 
  122 |   await cloneProject(app, remote.url, "beta")
  123 |   const beta = (await serverProjects(stack.url)).find((project) => project.repoUrl === remote.url)
  124 |   expect(beta?.name).toBe("beta")
  125 |   expect(await fs.readFile(path.join(beta?.directory ?? "", "README.md"), "utf8")).toBe("beta-source\n")
  126 | 
  127 |   await projectChip(app).click()
  128 |   await app.getByRole("textbox", { name: "Search projects" }).fill("alpha")
  129 |   await app.keyboard.press("Enter")
  130 |   await expect(projectChip(app)).toContainText("alpha")
  131 | 
  132 |   await renameProject(stack, app, alphaId, "alpha", "Alpha renamed")
  133 |   expect((await serverProject(stack.url, alphaId)).project?.name).toBe("Alpha renamed")
  134 | 
  135 |   await removeProject(stack, app, alphaId, "Alpha renamed")
  136 |   expect(await fs.readFile(path.join(alphaFolder, "README.md"), "utf8")).toBe("alpha\n")
  137 | })
  138 | 
  139 | test("02 a project whose folder is gone is cloned back at that folder from Settings → Projects", async ({ stack, page: app }) => {
  140 |   const remote = await stack.gitRemote("gamma")
  141 |   const created = await fetch(new URL("/api/claxedo/projects", stack.url), {
  142 |     method: "POST",
  143 |     headers: { "content-type": "application/json" },
  144 |     body: JSON.stringify({ source: { kind: "repository", repoUrl: remote.url } }),
  145 |   })
  146 |   expect(created.status).toBe(201)
  147 |   const { project } = (await created.json()) as { project: { id: string; directory: string } }
  148 |   await fs.rm(project.directory, { recursive: true, force: true })
  149 | 
  150 |   await app.goto(`${stack.url}/settings/projects`)
  151 |   const row = app.getByRole("region", { name: "Projects" }).getByRole("link", { name: "gamma", exact: true })
  152 |   await expect(row).toContainText(`Folder missing: ${project.directory}`)
  153 |   await row.click()
  154 |   const missing = app.getByRole("group", { name: "Folder missing" })
  155 |   await expect(missing).toContainText(remote.url)
  156 |   await missing.getByRole("button", { name: "Clone at this location" }).click()
  157 |   await expect(missing).toHaveCount(0)
  158 | 
  159 |   expect(await fs.readFile(path.join(project.directory, "README.md"), "utf8")).toBe("gamma-source\n")
  160 |   expect((await serverProject(stack.url, project.id)).project).toMatchObject({ directory: project.directory, available: true })
  161 |   await app.goto(`${stack.url}/settings/projects`)
  162 |   await expect(row).not.toContainText("Folder missing")
  163 | })
  164 | 
  165 | async function chooseScriptedHarness(app: Page) {
  166 |   await app.getByRole("button", { name: /^Select harness and model/ }).click()
  167 |   const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  168 |   if (!(await picker.getByText(/Scripted ACP/).first().isVisible())) await picker.getByRole("button", { name: /^Harness/ }).click()
  169 |   await picker.getByText(/Scripted ACP/).first().click()
  170 |   await app.keyboard.press("Escape")
  171 | }
  172 | 
  173 | test("02 a new local worktree picked in the Where chip is made on the first send", async ({ stack, api, app }) => {
  174 |   const workspace = await stack.daemon.makeWorkspace("worktree")
  175 |   await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  176 |   await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  177 |   const chip = app.getByRole("button", { name: "Where it runs", exact: true })
  178 |   const machine = await servingMachineName(stack.url)
  179 |   const folder = path.basename(workspace.directory)
  180 |   await expect(chip).toHaveText(folder)
> 181 |   await expect(app.getByRole("button", { name: "Current branch" })).toContainText("main")
      |                                                                     ^ Error: expect(locator).toContainText(expected) failed
  182 |   await chip.click()
  183 |   const row = app.locator('[data-context-chip-picker="context-chip-where"] [data-slot="list-item"]').filter({ hasText: folder })
  184 |   await expect(row).toContainText(`${machine} · Online`)
  185 |   await app.getByRole("button", { name: `New worktree on ${machine}`, exact: true }).click()
  186 |   await expect(chip).toHaveText("New worktree")
  187 |   await chooseScriptedHarness(app)
  188 |   await sendPrompt(app, "Start in a new worktree")
  189 |   await expect(app).toHaveURL(/\/w\/[^/]+\/session\/[^/?]+$/)
  190 |   expect(app.url()).not.toContain(`/w/${workspace.id}/`)
  191 |   expect(await api.sessions(workspace.directory)).toHaveLength(0)
  192 | })
  193 | 
```