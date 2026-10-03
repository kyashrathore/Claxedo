import { acpScriptToken, apiRequests, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"
import { readerPage, readerRow, writeReader } from "../harness/session-reader"

export function registerTranscriptOutcomeTests() {
  test("30 an opened session shows its last turn's work folded under Worked", async ({ stack, api, app }) => {
    const workspace = await stack.daemon.makeWorkspace("reopen")
    await stack.acp.write("work", {
      steps: [
        { kind: "reasoning", text: "Looking around the project" },
        { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "reopen\n" },
        { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "nothing to commit" },
        { kind: "text", text: "All checked here." },
      ],
    })
    const session = await api.createSession(workspace.directory, { title: "Reopened work", harness: SCRIPTED_ACP_HARNESS })
    await api.prompt(workspace.directory, session.id, `Check the project. ${acpScriptToken("work")}`)

    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByText("All checked here.")).toBeVisible()
    const worked = app.getByRole("button", { name: /^Worked/ })
    await expect(worked).toBeVisible()
    await worked.click()
    await expect(app.getByText("git status").first()).toBeVisible()

    const messages = await api.messages(workspace.directory, session.id)
    expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(2)
  })

  test("30 a result completed in an inactive transcript stays unseen until that result is displayed", async ({ stack, api, app }) => {
    const workspace = await stack.daemon.makeWorkspace("inactive-result")
    const hidden = await api.createSession(workspace.directory, { title: "Inactive result", harness: SCRIPTED_ACP_HARNESS })
    const shown = await api.createSession(workspace.directory, { title: "Visible bystander", harness: SCRIPTED_ACP_HARNESS })
    await stack.acp.write("inactive-result", { steps: [{ kind: "text", text: "The inactive turn started." }, { kind: "hold", name: "inactive-result" }, { kind: "text", text: " The inactive result finished." }] })
    await stack.acp.write("visible-bystander", { steps: [{ kind: "text", text: "The bystander stays visible." }] })
    await api.prompt(workspace.directory, shown.id, `Bystander ${acpScriptToken("visible-bystander")}`)
    await api.promptAsync(workspace.directory, hidden.id, `Inactive ${acpScriptToken("inactive-result")}`)
    await app.goto(`${stack.url}${sessionRoute(workspace.id, hidden.id)}`)
    await expect(app.getByRole("main").getByText("The inactive turn started.")).toBeVisible()
    const openRail = app.getByRole("button", { name: UI.openRail })
    if (await openRail.isVisible()) await openRail.click()
    await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: shown.title, exact: true }).click()
    await expect(app.getByRole("main").getByText("The bystander stays visible.")).toBeVisible()
    const quietRequests = apiRequests(app, stack.url)
    await stack.acp.release("inactive-result")
    await expect.poll(async () => (await readerRow(stack, hidden.id)).attention.outcome?.status).toBe("completed")
    await quietRequests()
    const before = await readerRow(stack, hidden.id)
    expect(before.reader?.seenThrough ?? 0).toBeLessThan(before.attention.outcome!.sequence)
    await expect(app.getByRole("main").getByText("The inactive result finished.", { exact: false })).toHaveCount(0)
    if (await openRail.isVisible()) await openRail.click()
    await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: hidden.title, exact: true }).click()
    await expect(app.getByRole("main").getByText(/The inactive result finished\./)).toBeInViewport()
    await expect.poll(async () => (await readerRow(stack, hidden.id)).reader?.seenThrough).toBe(before.attention.outcome!.sequence)
  })

  test("30 cold opening an older local session and reloading it after settling preserves the sidebar's first page", async ({ stack, api, app, isMobile }) => {
    await app.goto("about:blank")
    const workspace = await stack.daemon.makeWorkspace("cold-older", "Cold older project")
    await stack.acp.write("cold-older", { steps: [{ kind: "text", text: "The older session's exact result." }] })
    const target = await api.createSession(workspace.directory, { title: "Cold older session", harness: SCRIPTED_ACP_HARNESS })
    await api.prompt(workspace.directory, target.id, `Older ${acpScriptToken("cold-older")}`)
    await stack.acp.write("cold-newer", { steps: [{ kind: "text", text: "A newer sidebar result." }] })
    for (let index = 0; index < 7; index++) {
      const newer = await api.createSession(workspace.directory, { title: `Cold newer ${index}`, harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, newer.id, `Newer ${acpScriptToken("cold-newer")}`)
      await expect.poll(async () => (await readerRow(stack, newer.id)).attention.outcome?.status).toBe("completed")
    }
    const prefix = await readerPage(stack, { scope: "project", projectId: workspace.projectId, settled: "active", limit: "5" })
    const expected = prefix.items.map(row => row.sessionId)
    expect(expected).toHaveLength(5)
    expect(expected).not.toContain(target.id)
    const outcome = (await readerRow(stack, target.id)).attention.outcome!
    const reads: URL[] = []
    const locations: string[] = []
    app.on("request", request => {
      const url = new URL(request.url())
      if (url.pathname === "/api/claxedo/session-list") reads.push(url)
      if (url.pathname.endsWith("/location")) locations.push(url.pathname)
    })
    const quiet = apiRequests(app, stack.url)
    for (const navigation of ["cold", "reload", "settled reload"]) {
      if (navigation === "settled reload") {
        const current = await readerRow(stack, target.id)
        const settled = await writeReader(stack, current, { kind: "settle", revision: current.reader!.revision, activitySequence: current.attention.activitySequence, outcomeSequence: current.attention.outcome!.sequence })
        expect(settled.status).toBe(200)
        expect(settled.body).toMatchObject({ ok: true })
        expect((await readerRow(stack, target.id)).reader).toMatchObject({ generation: current.attention.generation, seenThrough: outcome.sequence, settledThrough: current.attention.activitySequence })
        const active = await readerPage(stack, { scope: "project", projectId: workspace.projectId, settled: "active", limit: "100" })
        expect(active.items.map(row => row.sessionId)).not.toContain(target.id)
        expect(active.items).toHaveLength(7)
      }
      const priorLocations = locations.length
      if (navigation === "cold") await app.goto(`${stack.url}/s/${target.id}`)
      else await app.reload()
      await expect(app.getByRole("main").getByText("The older session's exact result.", { exact: true })).toBeInViewport()
      await expect.poll(async () => (await readerRow(stack, target.id)).reader?.seenThrough).toBe(outcome.sequence)
      if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
      const rows = app.locator(`[data-testid="project-group"][data-project-id="${workspace.projectId}"]`).getByTestId("rail-sidebar-session-row")
      await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-session-id")))).toEqual(expected)
      await quiet()
      expect(reads.every(url => url.searchParams.get("scope") === "project" && url.searchParams.get("limit") === "5" && !url.searchParams.has("after")), "target identity lookup never walks inventory or eagerly loads another sidebar page").toBe(true)
      expect(locations.length, "each cold or reloaded route resolves its session identity directly").toBeGreaterThan(priorLocations)
      expect(locations.every(path => path === `/api/claxedo/session/${target.id}/location`), "identity lookup resolves only the requested session").toBe(true)
      if (isMobile) await app.getByRole("button", { name: "Close navigation sidebar", exact: true }).click()
    }
    const active = await readerPage(stack, { scope: "project", projectId: workspace.projectId, settled: "active", limit: "100" })
    expect(active.items.map(row => row.sessionId), "opening the settled transcript preserves its exclusion from active inventory").not.toContain(target.id)
  })
}
