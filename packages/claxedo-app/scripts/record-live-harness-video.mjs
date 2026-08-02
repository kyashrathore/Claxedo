import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const runId = process.argv[2] || String(Date.now())
const root = process.argv[3] || "/Users/yashvardhansingh/test/opencode"
const outDir = join(root, ".context/compound-engineering/feature-video", runId)
const videoDir = join(outDir, "raw-video")
mkdirSync(videoDir, { recursive: true })

const base = "http://localhost:4444/w/%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode/session"
const evidence = {
  runId,
  base,
  cases: [],
  requests: [],
  responses: [],
}

const browser = await chromium.launch({
  headless: false,
  slowMo: 250,
  args: ["--window-size=1440,1000"],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } },
})
const page = await context.newPage()

page.on("request", (request) => {
  const url = request.url()
  if (!url.includes("127.0.0.1:3001")) return
  if (!/session|prompt_async|agent-config|provider|global\/health/.test(url)) return
  evidence.requests.push({
    method: request.method(),
    url,
    postData: request.postData(),
  })
})

page.on("response", (response) => {
  const url = response.url()
  if (!url.includes("127.0.0.1:3001")) return
  if (!/session|prompt_async|agent-config|provider|global\/health/.test(url)) return
  evidence.responses.push({
    status: response.status(),
    url,
  })
})

async function setAnnotation(title, lines = []) {
  await page.evaluate(({ title, lines }) => {
    document.getElementById("codex-proof-overlay")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-overlay"
    el.style.position = "fixed"
    el.style.right = "16px"
    el.style.bottom = "158px"
    el.style.zIndex = "2147483647"
    el.style.maxWidth = "520px"
    el.style.padding = "12px 14px"
    el.style.border = "2px solid #7dd3fc"
    el.style.borderRadius = "8px"
    el.style.background = "rgba(8, 13, 18, 0.94)"
    el.style.color = "#f8fafc"
    el.style.boxShadow = "0 18px 50px rgba(0,0,0,0.55)"
    el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    el.style.fontSize = "13px"
    el.style.lineHeight = "1.35"
    el.style.pointerEvents = "none"
    const h = document.createElement("div")
    h.textContent = title
    h.style.fontWeight = "800"
    h.style.color = "#bae6fd"
    h.style.marginBottom = "6px"
    el.appendChild(h)
    for (const line of lines) {
      const p = document.createElement("div")
      p.textContent = line
      p.style.whiteSpace = "pre-wrap"
      el.appendChild(p)
    }
    document.body.appendChild(el)
  }, { title, lines })
}

async function setPanel(text) {
  await page.evaluate((text) => {
    document.getElementById("codex-proof-panel")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-panel"
    el.textContent = text
    el.style.position = "fixed"
    el.style.right = "16px"
    el.style.bottom = "16px"
    el.style.zIndex = "2147483647"
    el.style.maxWidth = "520px"
    el.style.padding = "14px 16px"
    el.style.border = "1px solid #34d399"
    el.style.borderRadius = "8px"
    el.style.background = "rgba(4, 20, 15, 0.94)"
    el.style.color = "#dcfce7"
    el.style.boxShadow = "0 12px 36px rgba(0,0,0,0.5)"
    el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    el.style.fontSize = "15px"
    el.style.lineHeight = "1.35"
    el.style.whiteSpace = "pre-wrap"
    el.style.pointerEvents = "none"
    document.body.appendChild(el)
  }, text)
}

async function highlightControls() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-codex-proof-outline]")) {
      el.style.outline = ""
      el.style.outlineOffset = ""
      el.removeAttribute("data-codex-proof-outline")
    }
    for (const selector of [
      "[data-action='prompt-harness-model']",
      "[data-action='prompt-submit']",
      "button",
    ]) {
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.innerText || el.getAttribute("aria-label") || "").trim()
        if (!text || !/Claude|Codex|Cursor|OpenCode|GPT|Unavailable|Send|Select/i.test(text)) continue
        el.style.outline = "3px solid #facc15"
        el.style.outlineOffset = "3px"
        el.setAttribute("data-codex-proof-outline", "true")
      }
    }
  })
}

async function sleep(ms) {
  await page.waitForTimeout(ms)
}

async function readState(label) {
  const state = await page.evaluate(() => {
    const body = document.body.innerText
    const submit = document.querySelector("[data-action='prompt-submit']")
    const harnessButtons = [...document.querySelectorAll("button")]
      .map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim())
      .filter((text) => /Claude|Codex|Cursor|OpenCode/.test(text))
    return {
      url: location.href,
      submitDisabled: submit ? submit.disabled : null,
      hasOpenCodeModelControl: !!document.querySelector("[data-action='prompt-model']"),
      hasOpenCodeVariantControl: !!document.querySelector("[data-action='prompt-model-variant']"),
      hasUnavailable: /Unavailable/i.test(body),
      hasGpt55: /GPT-5\.5|gpt-5\.5/i.test(body),
      harnessButtons: harnessButtons.slice(-8),
      bodyExcerpt: body.slice(-1200),
    }
  })
  evidence.cases.push({ label, state })
  return state
}

function sessionIdFromUrl() {
  return page.url().match(/\/session\/([a-f0-9-]+)/)?.[1]
}

async function getMessages(sessionId) {
  const response = await fetch(`http://127.0.0.1:3001/session/${sessionId}/message?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode&limit=120`)
  if (!response.ok) throw new Error(`message fetch failed ${response.status}`)
  return await response.json()
}

async function getSession(sessionId) {
  const response = await fetch(`http://127.0.0.1:3001/session/${sessionId}?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode`)
  if (!response.ok) throw new Error(`session fetch failed ${response.status}`)
  return await response.json()
}

function assistantError(message) {
  const error = message.info?.error
  const data = error && typeof error === "object" ? error.data : undefined
  if (data && typeof data === "object" && typeof data.message === "string") return data.message
  return undefined
}

function assistantHasVisibleOutput(message) {
  if (assistantError(message)) return true
  return Array.isArray(message.parts) && message.parts.length > 0
}

async function waitForAssistantOutput(sessionId) {
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    const messages = await getMessages(sessionId)
    const assistants = messages.filter((message) => message.info?.role === "assistant")
    const visible = assistants.filter(assistantHasVisibleOutput)
    if (visible.length > 0) {
      const assistant = visible.at(-1)
      return {
        assistantCount: assistants.length,
        visibleAssistantCount: visible.length,
        partCount: Array.isArray(assistant.parts) ? assistant.parts.length : 0,
        error: assistantError(assistant),
      }
    }
    const session = await getSession(sessionId)
    if (session.lastTurn?.status === "failed") {
      throw new Error(`Turn failed before assistant output: ${session.lastTurn.error ?? "session error"}`)
    }
    await sleep(2500)
  }
  throw new Error(`Timed out waiting for visible assistant output in ${sessionId}`)
}

async function openHarnessMenu() {
  const buttons = page.locator("button").filter({ hasText: /OpenCode|Claude|Codex|Cursor/ })
  await buttons.last().click()
  await sleep(800)
}

async function chooseHarness(name, index) {
  await openHarnessMenu()
  await page.getByRole("option", { name }).nth(index).click()
  await sleep(4500)
}

async function ensureDraft() {
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.locator("[data-claxedo]").waitFor({ timeout: 30_000 })
  await page.getByRole("textbox", { name: /Ask anything/i }).last().waitFor({ timeout: 30_000 })
}

async function unavailableCase(label, name, index) {
  await setAnnotation(`SWITCHING: ${label}`, [
    "Switching in the real app on localhost:4444.",
    "The next panel shows the actual rendered state.",
  ])
  await chooseHarness(name, index)
  await highlightControls()
  const state = await readState(label)
  await setAnnotation(`RESULT: ${label}`, [
    `Submit disabled: ${state.submitDisabled}`,
    `Unavailable visible: ${state.hasUnavailable}`,
    `GPT-5.5 visible: ${state.hasGpt55}`,
    "OpenCode controls must stay absent for harness-owned cases.",
  ])
  await setPanel([
    `${label}`,
    `submit disabled: ${state.submitDisabled}`,
    `Unavailable visible: ${state.hasUnavailable}`,
    `GPT-5.5 visible: ${state.hasGpt55}`,
    `OpenCode model control present: ${state.hasOpenCodeModelControl}`,
    `OpenCode variant control present: ${state.hasOpenCodeVariantControl}`,
  ].join("\n"))
  await page.getByRole("textbox", { name: /Ask anything/i }).last().fill(`video proof ${label}`)
  await sleep(3500)
  await page.getByRole("textbox", { name: /Ask anything/i }).last().fill("")
  await sleep(1000)
}

await ensureDraft()
await setAnnotation("LIVE HARNESS PROOF", [
  "Real browser, real localhost:4444 UI, real 127.0.0.1:3001 backend.",
  "No route mocks. Network is only observed for evidence.",
])
await setPanel("Starting from live session route\n" + base)
await sleep(3500)

await unavailableCase("OpenCode baseline", /^OpenCode$/, 0)
await unavailableCase("Claude ACP unavailable path", /^Claude$/, 0)
await unavailableCase("Claude Native SDK status path", /^Claude$/, 1)
await unavailableCase("Codex ACP unavailable path", /^Codex$/, 0)
await unavailableCase("Cursor ACP unavailable path", /^Cursor$/, 0)

await setAnnotation("CASE: Codex Native SDK send", [
  "Selecting the native Codex SDK option, then sending a real prompt.",
  "The proof panel will show the actual prompt_async payload.",
])
await chooseHarness(/^Codex$/, 1)
await highlightControls()
await sleep(2000)

const prompt = `annotated live proof ${new Date().toISOString()}`
await page.getByRole("textbox", { name: /Ask anything/i }).last().fill(prompt)
await sleep(1500)
const beforePromptRequests = evidence.requests.length
await page.locator("[data-action='prompt-submit']").last().click()
await page.waitForURL(/\/session\/[a-f0-9-]+/, { timeout: 30_000 })
const sessionId = sessionIdFromUrl()
if (!sessionId) throw new Error("No session id after Codex Native SDK send")
const assistantOutput = await waitForAssistantOutput(sessionId)
const promptRequest = evidence.requests.slice(beforePromptRequests)
  .find((request) => request.url.includes("/prompt_async"))
const promptBody = promptRequest?.postData ? JSON.parse(promptRequest.postData) : undefined
const sendState = await readState("Codex Native SDK send")
await setAnnotation("LIVE SEND EVIDENCE", [
  `Session URL: ${page.url()}`,
  "Actual network request captured from the browser:",
  `providerID=${promptBody?.model?.providerID}`,
  `modelID=${promptBody?.model?.modelID}`,
  `variant=${promptBody?.variant ?? "absent"}`,
  `visible assistant outputs=${assistantOutput.visibleAssistantCount}`,
  `assistant parts=${assistantOutput.partCount}`,
  `assistant error=${assistantOutput.error ?? "none"}`,
])
await setPanel([
  "POST /prompt_async",
  `providerID: ${promptBody?.model?.providerID}`,
  `modelID: ${promptBody?.model?.modelID}`,
  `variant: ${promptBody?.variant ?? "absent"}`,
  `assistant messages: ${assistantOutput.assistantCount}`,
  `visible assistant outputs: ${assistantOutput.visibleAssistantCount}`,
  `assistant error: ${assistantOutput.error ?? "none"}`,
  `submit disabled after send: ${sendState.submitDisabled}`,
].join("\n"))
await sleep(6500)

await setAnnotation("RELOAD HYDRATION CHECK", [
  "Reloading the created live session.",
  "Expected proof: Codex/gpt-5.5 remains, no OpenCode controls return.",
])
await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
await page.locator("[data-claxedo]").waitFor({ timeout: 30_000 })
await sleep(5500)
await highlightControls()
const reloadState = await readState("Reloaded Codex Native SDK session")
await setPanel([
  "After reload",
  `Codex/gpt-5.5 visible: ${reloadState.hasGpt55}`,
  `Unavailable visible: ${reloadState.hasUnavailable}`,
  `OpenCode model control present: ${reloadState.hasOpenCodeModelControl}`,
  `OpenCode variant control present: ${reloadState.hasOpenCodeVariantControl}`,
].join("\n"))
await sleep(6500)

await setAnnotation("END OF LIVE PROOF", [
  "Recorded against the real app/backend.",
  "Evidence JSON saved beside this video.",
])
await sleep(3000)

const rawVideo = await page.video()?.path()
await context.close()
await browser.close()

evidence.rawVideo = rawVideo
writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ runId, outDir, rawVideo, evidencePath: join(outDir, "evidence.json") }, null, 2))
