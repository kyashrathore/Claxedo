import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { workspaceCaptureUrl } from "./workspace-capture-url.mjs"

const runId = process.argv[2] || String(Date.now())
const root = process.argv[3] || "/Users/yashvardhansingh/test/opencode"
const workspaceId = process.env.WORKSPACE_ID?.trim()
const directory = "/Users/yashvardhansingh/test/opencode"
const encodedDirectory = encodeURIComponent(directory)
const appBase = workspaceCaptureUrl({ workspaceId, origin: "http://localhost:4444" })
const apiBase = "http://127.0.0.1:3001"
const outDir = join(root, ".context/compound-engineering/feature-video", runId)
const videoDir = join(outDir, "raw-video")
mkdirSync(videoDir, { recursive: true })

const allHarnesses = [
  { label: "Claude ACP", option: /^Claude$/, index: 0 },
  { label: "Claude Native SDK", option: /^Claude$/, index: 1 },
  { label: "Codex ACP", option: /^Codex$/, index: 0 },
  { label: "Codex Native SDK", option: /^Codex$/, index: 1 },
  { label: "Cursor ACP", option: /^Cursor$/, index: 0 },
]
const harnessFilter = process.env.HARNESS_FILTER?.trim().toLowerCase()
const harnesses = harnessFilter
  ? allHarnesses.filter((item) => item.label.toLowerCase().includes(harnessFilter))
  : allHarnesses

const evidence = {
  runId,
  appBase,
  apiBase,
  harnesses: [],
  requests: [],
  responses: [],
}

const browser = await chromium.launch({
  headless: false,
  slowMo: 225,
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
    ts: Date.now(),
  })
})

page.on("response", (response) => {
  const url = response.url()
  if (!url.includes("127.0.0.1:3001")) return
  if (!/session|prompt_async|agent-config|provider|global\/health/.test(url)) return
  evidence.responses.push({
    status: response.status(),
    url,
    ts: Date.now(),
  })
})

async function setAnnotation(title, lines = []) {
  await page.evaluate(({ title, lines }) => {
    document.getElementById("codex-proof-overlay")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-overlay"
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "172px",
      zIndex: "2147483647",
      maxWidth: "520px",
      padding: "12px 14px",
      border: "2px solid #7dd3fc",
      borderRadius: "8px",
      background: "rgba(8, 13, 18, 0.95)",
      color: "#f8fafc",
      boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "13px",
      lineHeight: "1.35",
      pointerEvents: "none",
    })
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

async function setPanel(lines = []) {
  await page.evaluate((text) => {
    document.getElementById("codex-proof-panel")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-panel"
    el.textContent = text
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "600px",
      padding: "14px 16px",
      border: "1px solid #34d399",
      borderRadius: "8px",
      background: "rgba(4, 20, 15, 0.95)",
      color: "#dcfce7",
      boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "15px",
      lineHeight: "1.35",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    })
    document.body.appendChild(el)
  }, lines.join("\n"))
}

async function sleep(ms) {
  await page.waitForTimeout(ms)
}

async function composer() {
  return page.getByRole("textbox", { name: /Ask anything/i }).last()
}

async function readState() {
  return await page.evaluate(() => {
    const body = document.body.innerText
    const submit = [...document.querySelectorAll("[data-action='prompt-submit']")].at(-1)
    const harness = [...document.querySelectorAll("button")]
      .map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim())
      .filter((text) => /Claude|Codex|Cursor|OpenCode|Pi/.test(text))
      .slice(-6)
    return {
      url: location.href,
      submitDisabled: submit ? submit.disabled : null,
      hasOpenCodeModelControl: !!document.querySelector("[data-action='prompt-model']"),
      hasOpenCodeVariantControl: !!document.querySelector("[data-action='prompt-model-variant']"),
      hasHarnessModelControl: !!document.querySelector("[data-action='prompt-harness-model']"),
      hasThinking: /Thinking/i.test(body),
      harness,
      textTail: body.slice(-900),
    }
  })
}

async function openDraft() {
  await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.locator("[data-claxedo]").waitFor({ timeout: 30_000 })
  await (await composer()).waitFor({ timeout: 30_000 })
  await sleep(1500)
}

async function clickHarnessButton() {
  const button = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button")]
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          text: (el.innerText || el.getAttribute("aria-label") || "").trim(),
          disabled: el.disabled,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
      })
      .filter((item) => item.x > 350 && item.width > 30 && !item.disabled && /^(Claude|Codex|Cursor|OpenCode|Pi)$/.test(item.text))
      .sort((a, b) => b.y - a.y)
    return candidates[0]
  })
  if (!button) throw new Error("Could not find prompt harness button")
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)
  await sleep(800)
}

async function chooseHarness(harness) {
  await clickHarnessButton()
  await page.getByRole("option", { name: harness.option }).nth(harness.index).click({ timeout: 30_000 })
  await sleep(5000)
}

async function waitForSubmitEnabled() {
  await page.waitForFunction(() => {
    const submit = [...document.querySelectorAll("[data-action='prompt-submit']")].at(-1)
    return !!submit && !submit.disabled
  }, undefined, { timeout: 60_000 })
}

function sessionIdFromUrl() {
  const hit = page.url().match(/\/session\/([a-f0-9-]+)/)
  return hit?.[1]
}

async function getMessages(sessionId) {
  const response = await fetch(`${apiBase}/session/${sessionId}/message?directory=${encodedDirectory}&limit=120`)
  if (!response.ok) throw new Error(`message fetch failed ${response.status}`)
  return await response.json()
}

async function getSession(sessionId) {
  const response = await fetch(`${apiBase}/session/${sessionId}?directory=${encodedDirectory}`)
  if (!response.ok) throw new Error(`session fetch failed ${response.status}`)
  return await response.json()
}

async function getSessionConfig(sessionId) {
  const response = await fetch(`${apiBase}/session/${sessionId}/config?directory=${encodedDirectory}`)
  if (!response.ok) throw new Error(`config fetch failed ${response.status}`)
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

async function waitForAssistantResponse(sessionId, count) {
  const started = Date.now()
  while (Date.now() - started < 180_000) {
    const messages = await getMessages(sessionId)
    const assistants = messages.filter((message) => message.info?.role === "assistant")
    const assistant = assistants[count - 1]
    if (assistant && assistantHasVisibleOutput(assistant)) {
      return {
        messages,
        assistantCount: assistants.length,
        visibleAssistantCount: assistants.filter(assistantHasVisibleOutput).length,
        error: assistantError(assistant),
        partCount: Array.isArray(assistant.parts) ? assistant.parts.length : 0,
      }
    }
    const session = await getSession(sessionId)
    if (session.lastTurn?.status === "failed") {
      throw new Error(`Turn ${count} failed before assistant output: ${session.lastTurn.error ?? "session error"}`)
    }
    await sleep(2500)
  }
  throw new Error(`Timed out waiting for visible assistant output ${count} in ${sessionId}`)
}

async function sendTurn(harnessLabel, turn, expectedSessionId) {
  const text = `${harnessLabel} live full loop turn ${turn}: reply exactly OK ${turn}`
  await setAnnotation(`${harnessLabel}: SEND TURN ${turn}`, [
    "Filling the composer and clicking the real Send button.",
    "The browser is observing the actual /prompt_async payload.",
  ])
  await (await composer()).fill(text)
  await waitForSubmitEnabled()
  await sleep(1000)
  const before = evidence.requests.length
  await page.locator("[data-action='prompt-submit']").last().click()
  if (!expectedSessionId) await page.waitForURL(/\/session\/[a-f0-9-]+/, { timeout: 60_000 })
  const sessionId = expectedSessionId ?? sessionIdFromUrl()
  if (!sessionId) throw new Error(`No session id after ${harnessLabel} turn ${turn}`)

  const started = Date.now()
  let promptRequest
  while (Date.now() - started < 30_000) {
    promptRequest = evidence.requests.slice(before).find((request) => request.url.includes(`/session/${sessionId}/prompt_async`))
    if (promptRequest) break
    await sleep(500)
  }
  if (!promptRequest) throw new Error(`No prompt_async request captured for ${harnessLabel} turn ${turn}`)
  const promptBody = JSON.parse(promptRequest.postData)
  const responseResult = await waitForAssistantResponse(sessionId, turn)
  const state = await readState()
  await setAnnotation(`${harnessLabel}: RESPONSE ${turn} OBSERVED`, [
    `Session: ${sessionId}`,
    `assistant messages: ${responseResult.assistantCount}`,
    `visible assistant outputs: ${responseResult.visibleAssistantCount}`,
    `assistant parts this turn: ${responseResult.partCount}`,
    `assistant error: ${responseResult.error ?? "none"}`,
    `payload providerID=${promptBody.model?.providerID}`,
    `payload modelID=${promptBody.model?.modelID}`,
    `payload variant=${promptBody.variant ?? "absent"}`,
  ])
  await setPanel([
    `${harnessLabel} turn ${turn}`,
    `POST /prompt_async captured`,
    `providerID: ${promptBody.model?.providerID}`,
    `modelID: ${promptBody.model?.modelID}`,
    `variant: ${promptBody.variant ?? "absent"}`,
    `assistant messages: ${responseResult.assistantCount}`,
    `visible assistant outputs: ${responseResult.visibleAssistantCount}`,
    `assistant error: ${responseResult.error ?? "none"}`,
    `OpenCode model control: ${state.hasOpenCodeModelControl}`,
    `OpenCode variant control: ${state.hasOpenCodeVariantControl}`,
  ])
  await sleep(3500)
  return { sessionId, promptBody, text, state, ...responseResult }
}

async function runHarness(harness) {
  const result = { label: harness.label, turns: [] }
  evidence.harnesses.push(result)
  await openDraft()
  await setAnnotation(`${harness.label}: SELECT HARNESS`, [
    "Starting from /session draft route.",
    "Selecting this harness, then completing send -> response -> second send -> response -> reload -> third send.",
  ])
  await chooseHarness(harness)
  const selectedState = await readState()
  await setPanel([
    `${harness.label} selected`,
    `submit disabled before prompt: ${selectedState.submitDisabled}`,
    `OpenCode model control: ${selectedState.hasOpenCodeModelControl}`,
    `OpenCode variant control: ${selectedState.hasOpenCodeVariantControl}`,
  ])
  await sleep(2000)

  const first = await sendTurn(harness.label, 1)
  result.sessionId = first.sessionId
  result.turns.push(first)

  const config = await getSessionConfig(first.sessionId)
  result.configAfterCreate = config
  await setAnnotation(`${harness.label}: CREATED SESSION VERIFIED`, [
    `URL: ${page.url()}`,
    `config harness: ${JSON.stringify(config.harness)}`,
    `config model: ${JSON.stringify(config.model)}`,
    `config variant: ${config.variant ?? "null"}`,
  ])
  await sleep(3500)

  result.turns.push(await sendTurn(harness.label, 2, first.sessionId))

  await setAnnotation(`${harness.label}: RELOAD`, [
    "Reloading this created session before sending turn 3.",
    "After reload, harness ownership and model must remain intact.",
  ])
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.locator("[data-claxedo]").waitFor({ timeout: 45_000 })
  await (await composer()).waitFor({ timeout: 45_000 })
  await sleep(3500)
  const reloadState = await readState()
  const reloadConfig = await getSessionConfig(first.sessionId)
  result.reloadState = reloadState
  result.reloadConfig = reloadConfig
  await setPanel([
    `${harness.label} after reload`,
    `config harness: ${JSON.stringify(reloadConfig.harness)}`,
    `config model: ${JSON.stringify(reloadConfig.model)}`,
    `OpenCode model control: ${reloadState.hasOpenCodeModelControl}`,
    `OpenCode variant control: ${reloadState.hasOpenCodeVariantControl}`,
  ])
  await sleep(3500)

  result.turns.push(await sendTurn(harness.label, 3, first.sessionId))
  await setAnnotation(`${harness.label}: FULL LOOP COMPLETE`, [
    `Session: ${first.sessionId}`,
    "Completed: turn 1 response, turn 2 response, reload, turn 3 response.",
  ])
  await sleep(3000)
}

try {
  await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.locator("[data-claxedo]").waitFor({ timeout: 30_000 })
  await setAnnotation("FULL LIVE HARNESS LOOP PROOF", [
    "Real browser, real localhost:4444 UI, real 127.0.0.1:3001 backend.",
    "No route mocks. For each harness: send, verify session, wait response, send again, reload, send again.",
  ])
  await setPanel([
    "Harnesses in this recording:",
    ...harnesses.map((item) => `- ${item.label}`),
  ])
  await sleep(4000)

  const failures = []
  for (const harness of harnesses) {
    try {
      await runHarness(harness)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ label: harness.label, message })
      const current = evidence.harnesses.find((item) => item.label === harness.label)
      if (current) current.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
      await setAnnotation(`${harness.label}: REAL FULL LOOP BLOCKED`, [
        message,
        "Continuing to the next harness so the recording covers every selected harness.",
      ]).catch(() => undefined)
      await setPanel([
        `${harness.label} did not complete the full loop`,
        message,
        "This is live behavior, not a mocked failure.",
      ]).catch(() => undefined)
      await sleep(5000).catch(() => undefined)
    }
  }

  evidence.failures = failures
  await setAnnotation(failures.length ? "ALL HARNESSES ATTEMPTED WITH REAL BLOCKERS" : "ALL REQUESTED HARNESS LOOPS COMPLETE", [
    failures.length
      ? `${failures.length} harness loop(s) could not complete on the live path.`
      : "Every harness in this recording completed turn 1, turn 2, reload, and turn 3.",
    "Evidence JSON is saved beside the video.",
  ])
  await sleep(4000)
} catch (error) {
  evidence.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  await setAnnotation("RECORDING HIT A REAL FAILURE", [
    evidence.error.split("\n")[0],
    "The partial video/evidence is still saved for inspection.",
  ]).catch(() => undefined)
  await sleep(4000).catch(() => undefined)
} finally {
  const rawVideo = await page.video()?.path()
  await context.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  evidence.rawVideo = rawVideo
  writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ runId, outDir, rawVideo, evidencePath: join(outDir, "evidence.json"), error: evidence.error }, null, 2))
}
