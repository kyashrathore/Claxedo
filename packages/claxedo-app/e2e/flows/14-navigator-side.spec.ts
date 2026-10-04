import fs from "node:fs/promises"
import path from "node:path"
import type { Locator } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, test, UI } from "../harness"

test.skip(({ isMobile }) => isMobile, "flow 14 runs at desktop width")

async function span(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("the control is not laid out")
  return { left: box.x, right: box.x + box.width }
}

for (const side of ["left", "right"] as const) {
  test(`14 with the files navigator on the ${side}, the Review row puts Files, Changes and the diff view above it and the scope above the diff, in Tab order`, async ({ stack, api, app }) => {
    await app.addInitScript((value) => localStorage.setItem("claxedo:appearance:fonts", JSON.stringify({ navigatorSide: value })), side)
    const workspace = await stack.daemon.makeWorkspace(`side-${side}`)
    await fs.appendFile(path.join(workspace.directory, "README.md"), "a changed line\n")
    const session = await api.createSession(workspace.directory, { title: "Side", harness: SCRIPTED_ACP_HARNESS })

    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
    await app.getByRole("button", { name: UI.openPanel }).click()
    const panel = app.getByRole("complementary", { name: "Workspace panel" })
    await panel.getByRole("button", { name: "Review", exact: true }).click()
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click()
    const column = app.getByTestId("workspace-navigator-overlay")
    await expect(column).toHaveAttribute("data-navigator-side", side)
    await expect(panel.getByTestId("source-control-groups")).toBeVisible()

    const header = app.getByTestId("workbench-l2-header")
    const scope = header.getByTestId("review-compare-trigger")
    const navigatorControls = [header.getByRole("button", { name: "Open Files" }), header.getByRole("button", { name: "Close Changes" })]
    const diffView = [header.getByRole("button", { name: "Expand all" }), header.getByRole("button", { name: "Split" })]
    const expected = side === "left" ? [...navigatorControls, ...diffView, scope] : [scope, ...diffView, ...navigatorControls]
    for (const control of expected) await expect(control).toBeVisible()

    const lefts = await Promise.all(expected.map(async (control) => (await span(control)).left))
    expect(lefts, "the row's controls from left to right").toEqual(lefts.toSorted((a, b) => a - b))
    const navigator = await span(column)
    for (const control of [...navigatorControls, ...diffView]) {
      const box = await span(control)
      expect(box.left >= navigator.left && box.right <= navigator.right, "a navigator control sits above the navigator").toBe(true)
    }
    const scopeBox = await span(scope)
    expect(side === "left" ? scopeBox.left >= navigator.right : scopeBox.right <= navigator.left, "the scope sits above the diff").toBe(true)

    await expected[0].focus()
    for (const control of expected.slice(1)) {
      await app.keyboard.press("Tab")
      await expect(control).toBeFocused()
    }
  })
}

for (const side of ["left", "right"] as const) {
  test(`14 with the files navigator on the ${side}, a subagent tab's name and task start at the row's left, beside any leading tools`, async ({ stack, api, app }) => {
    await app.addInitScript((value) => localStorage.setItem("claxedo:appearance:fonts", JSON.stringify({ navigatorSide: value })), side)
    const workspace = await stack.daemon.makeWorkspace(`subagent-side-${side}`)
    await stack.acp.write("delegate", {
      steps: [
        { kind: "subagent", name: "researcher", task: "Find the project name", steps: [{ kind: "text", text: "The researcher found the project name" }] },
        { kind: "text", text: "The parent read the researcher's answer" },
      ],
    })
    const session = await api.createSession(workspace.directory, { title: "Side", harness: SCRIPTED_ACP_HARNESS })
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await sendPrompt(app, `Delegate the search. ${acpScriptToken("delegate")}`)
    await expect(app.getByText("The parent read the researcher's answer")).toBeVisible()
    await app.getByRole("region", { name: "Background subagents" }).getByRole("link").filter({ hasText: "Find the project name" }).click()

    const header = app.getByTestId("workbench-l2-header")
    const task = header.getByText("Find the project name", { exact: true })
    const files = header.getByRole("button", { name: "Open Files" })
    await expect(task).toBeVisible()
    await expect(files).toBeVisible()

    const row = await span(header)
    const taskBox = await span(task)
    const filesBox = await span(files)
    if (side === "left") {
      expect(taskBox.left > filesBox.right, "the task follows the leading tools").toBe(true)
      expect(taskBox.left - filesBox.right < row.right - taskBox.right, "the task sits beside the tools, not at the far edge").toBe(true)
    } else {
      expect(taskBox.right < filesBox.left, "the task comes before the trailing tools").toBe(true)
      expect(taskBox.left - row.left < filesBox.left - taskBox.right, "the task sits at the row's left, not beside the tools").toBe(true)
    }
  })
}
