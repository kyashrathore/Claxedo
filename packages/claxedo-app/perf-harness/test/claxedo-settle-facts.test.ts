import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { settleExpression, type PageSettle } from "agent-app-benchmark/driver-sdk"
import { chromium, type Browser, type Page } from "playwright-core"
import { claxedoSettleFacts } from "../src/claxedo-settle-facts"

const target = {
  sessionId: "ses_a",
  expectedMessageIds: ["msg_user", "msg_assistant"],
  expectedPartIds: ["prt_text", "prt_tool"],
}

const fixture = `
<nav>
  <div data-testid="rail-sidebar-session-row" data-session-id="ses_a" data-active="true">A</div>
  <div data-testid="rail-sidebar-session-row" data-session-id="ses_b">B</div>
</nav>
<main data-workbench-content>
  <div data-testid="session-page-root" data-session-id="ses_a">
    <div data-session-timeline-root>
      <div data-slot="session-timeline-scroll">
        <div data-scrollable style="height:300px;overflow:auto">
          <div data-timeline-key="k-user" data-timeline-row="UserMessage" data-content-message-id="msg_user">
            <button>Copy</button><div data-slot="user-message-text">hello</div>
          </div>
          <div data-timeline-key="k-foreign" data-timeline-row="AssistantPart" data-content-message-id="msg_assistant" data-content-part-id="prt_foreign">foreign part</div>
          <div data-timeline-key="k-text" data-timeline-row="AssistantPart" data-content-message-id="msg_assistant" data-content-part-id="prt_text">
            <div data-component="text-part" data-timeline-part-id="prt_text"><div data-slot="text-part-body">answer</div></div>
          </div>
          <div data-timeline-key="k-tool" data-timeline-row="AssistantPart" data-content-message-id="msg_assistant" data-content-part-id="prt_tool">tool header</div>
          <div data-timeline-key="k-older" data-timeline-row="UserMessage" data-content-message-id="msg_older">older</div>
        </div>
      </div>
    </div>
    <div data-component="prompt-input" contenteditable="true">draft</div>
  </div>
</main>
<main data-workbench-content aria-hidden="true">
  <div data-testid="session-page-root" data-session-id="ses_b">hidden session</div>
</main>`

describe("Claxedo settle facts", () => {
  test("serialize with no identifier beyond browser globals and the target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-settle-facts-"))
    try {
      await writeFile(path.join(root, "facts.js"), `export const facts = ${claxedoSettleFacts.toString()}\n`)
      await writeFile(path.join(root, "control.js"), `export const control = (target) => process.cwd() + target\n`)
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "esnext", module: "esnext", lib: ["esnext", "dom", "dom.iterable"], types: [] },
          files: ["facts.js", "control.js"],
        }),
      )
      const tsc = Bun.spawn([path.join(import.meta.dir, "../node_modules/.bin/tsc"), "-p", root, "--pretty", "false"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text())
      await tsc.exited
      const unresolved = (file: string) =>
        output
          .split("\n")
          .filter((line) => line.includes("Cannot find name") && path.basename(line.split("(")[0] ?? "") === file)
      expect(unresolved("facts.js")).toEqual([])
      expect(unresolved("control.js").join("\n")).toContain("'process'")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  describe("in a page", () => {
    let browser: Browser
    let page: Page

    beforeAll(async () => {
      browser = await chromium.launch({ headless: true })
    }, 30_000)

    afterAll(async () => {
      await browser.close()
    })

    beforeAll(async () => {
      page = await browser.newPage()
    })

    const read = async (change = "") => {
      await page.setContent(fixture)
      await page.evaluate(`${change}; window.facts = (${claxedoSettleFacts.toString()})(${JSON.stringify(target)})`)
      return page.evaluate(() => {
        const facts = Reflect.get(window, "facts")
        const describe = (element: HTMLElement) =>
          element.dataset.timelineKey ?? element.dataset.slot ?? element.dataset.component ?? element.tagName
        const composer = facts.composer()
        return {
          displayed: facts.displayed(),
          latestTurnRows: facts.latestTurnRows().map(describe),
          composer: composer ? describe(composer) : null,
          placeholder: facts.placeholder(),
          transcript: facts.transcript()?.hasAttribute("data-scrollable") ?? null,
          rows: facts.rows().map((row: HTMLElement) => facts.rowKey(row)),
        }
      })
    }

    test("answer for the displayed destination", async () => {
      expect(await read()).toEqual({
        displayed: true,
        latestTurnRows: ["user-message-text", "text-part-body", "k-tool"],
        composer: "prompt-input",
        placeholder: false,
        transcript: true,
        rows: ["k-user", "k-foreign", "k-text", "k-tool", "k-older"],
      })
    })

    test("a hidden or inert surface, a second active row or a second visible root is not the displayed destination", async () => {
      const displayedAfter = async (change: string) => (await read(change)).displayed
      expect(await displayedAfter(`document.querySelector("main").setAttribute("aria-hidden", "true")`)).toBe(false)
      expect(await displayedAfter(`document.querySelector("main").setAttribute("inert", "")`)).toBe(false)
      expect(await displayedAfter(`document.querySelector('[data-session-id="ses_b"]').dataset.active = "true"`)).toBe(false)
      expect(await displayedAfter(`document.querySelectorAll("main")[1].removeAttribute("aria-hidden")`)).toBe(false)
      expect(await displayedAfter(`document.querySelector('[data-testid="session-page-root"]').style.opacity = "0"`)).toBe(
        false,
      )
    })

    test("a loading marker or a skeleton is a placeholder, and a composer that is not contenteditable is none", async () => {
      const loading = `document.querySelector("[data-session-timeline-root]").setAttribute("data-session-timeline-loading", "")`
      expect((await read(loading)).placeholder).toBe(true)
      const skeleton = `document.querySelector("[data-scrollable]").insertAdjacentHTML("beforeend", '<div data-slot="skeleton"></div>')`
      expect((await read(skeleton)).placeholder).toBe(true)
      const readOnly = `document.querySelector('[data-component="prompt-input"]').setAttribute("contenteditable", "false")`
      expect((await read(readOnly)).composer).toBeNull()
    })

    test("run inside the page clock until it settles on the fixture", async () => {
      await page.setContent(fixture)
      const settle = await page.evaluate<PageSettle>(
        settleExpression({ facts: claxedoSettleFacts, target, timeoutMs: 10_000, start: "now" }),
      )
      expect(settle.frames.length).toBeGreaterThanOrEqual(31)
      expect(settle.frames.at(-1)?.gates).toEqual({
        displayedDestination: true,
        latestTurnPainted: true,
        noPlaceholder: true,
        firstFoldComplete: true,
        composerEditable: true,
        windowVisibleFocused: true,
      })
      expect(settle.settledAt).toBeGreaterThanOrEqual(settle.startAt)
    })
  })
})
