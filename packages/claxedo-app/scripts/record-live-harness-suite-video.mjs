import { chromium } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { workspaceCaptureUrl } from "./workspace-capture-url.mjs"

const runId = process.argv[2] || String(Date.now())
const root = process.argv[3] || "/Users/yashvardhansingh/test/opencode"
const workspaceId = process.env.WORKSPACE_ID?.trim()
const directory = process.env.DIRECTORY?.trim() || "/Users/yashvardhansingh/test/opencode"
const encodedDirectory = encodeURIComponent(directory)
const appBase = workspaceCaptureUrl({ override: process.env.APP_BASE, workspaceId, origin: "http://localhost:4444" })
const apiBase = "http://127.0.0.1:3001"
const outDir = join(root, ".context/compound-engineering/feature-video", runId)
const rawDir = join(outDir, "raw-video")
mkdirSync(rawDir, { recursive: true })

const allHarnesses = [
  { key: "opencode", type: "opencode", label: "OpenCode", option: /^OpenCode$/, index: 0, proofPrefix: "O" },
  { key: "claude-acp", type: "claude-acp", label: "Claude ACP", option: /^Claude$/, index: 0, proofPrefix: "A" },
  { key: "claude-sdk", type: "claude-sdk", label: "Claude Native SDK", option: /^Claude$/, index: 1, proofPrefix: "B" },
  { key: "codex-acp", type: "codex-acp", label: "Codex ACP", option: /^Codex$/, index: 0, proofPrefix: "C" },
  { key: "codex-sdk", type: "codex-app-server", label: "Codex Native SDK", option: /^Codex$/, index: 1, proofPrefix: "D" },
  { key: "cursor-acp", type: "cursor-acp", label: "Cursor ACP", option: /^Cursor$/, index: 0, proofPrefix: "E" },
  { key: "cursor-sdk", type: "cursor-sdk", label: "Cursor Native SDK", option: /^Cursor$/, index: 1, proofPrefix: "F" },
]
const harnessFilter = process.env.HARNESS_FILTER?.trim().toLowerCase()
const harnesses = harnessFilter
  ? allHarnesses.filter((item) => item.key.includes(harnessFilter) || item.label.toLowerCase().includes(harnessFilter))
  : allHarnesses

const evidence = { runId, appBase, apiBase, directory, workspaceId, harnesses: [] }

function safeName(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function expectedTurnText(harness, turn) {
  return `CLAXEDO-${harness.proofPrefix ?? harness.key.replace(/[^a-z0-9]/gi, "").toUpperCase()}-${turn}`
}

async function sleep(page, ms) {
  if (page.isClosed()) throw new Error("Page closed while waiting")
  await page.waitForTimeout(ms)
}

async function withTimeout(promise, ms, label) {
  let timer
  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function setAnnotation(page, title, lines = []) {
  if (page.isClosed()) return
  await page.evaluate(({ title, lines }) => {
    document.getElementById("codex-proof-overlay")?.remove()
    document.getElementById("codex-proof-panel")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-overlay"
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "380px",
      maxHeight: "200px",
      overflow: "hidden",
      padding: "10px 12px",
      border: "2px solid #7dd3fc",
      borderRadius: "8px",
      background: "rgba(8, 13, 18, 0.95)",
      color: "#f8fafc",
      boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "11px",
      lineHeight: "1.28",
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

async function setPanel(page, lines = []) {
  if (page.isClosed()) return
  await page.evaluate((text) => {
    document.getElementById("codex-proof-overlay")?.remove()
    document.getElementById("codex-proof-panel")?.remove()
    const el = document.createElement("div")
    el.id = "codex-proof-panel"
    el.textContent = text
    Object.assign(el.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "380px",
      maxHeight: "200px",
      overflow: "hidden",
      padding: "10px 12px",
      border: "1px solid #34d399",
      borderRadius: "8px",
      background: "rgba(4, 20, 15, 0.95)",
      color: "#dcfce7",
      boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: "11px",
      lineHeight: "1.28",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    })
    document.body.appendChild(el)
  }, lines.join("\n"))
}

async function composer(page) {
  return page.getByRole("textbox", { name: /Ask anything/i }).last()
}

async function readState(page) {
  return await page.evaluate(() => {
    const body = document.body.innerText
    const submit = [...document.querySelectorAll("[data-action='prompt-submit']")].at(-1)
    return {
      url: location.href,
      submitDisabled: submit ? submit.disabled : null,
      hasThinking: /Thinking/i.test(body),
      hasOpenCodeModelControl: !!document.querySelector("[data-action='prompt-model']"),
      hasOpenCodeVariantControl: !!document.querySelector("[data-action='prompt-model-variant']"),
      hasHarnessModelControl: !!document.querySelector("[data-action='prompt-harness-model']"),
      issueLabels: [...document.querySelectorAll("[aria-label][title]")]
        .map((el) => ({ ariaLabel: el.getAttribute("aria-label"), title: el.getAttribute("title") }))
        .filter((item) => item.ariaLabel || item.title),
      tail: body.slice(-1000),
    }
  })
}

async function openDraft(page) {
  await page.goto(appBase, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await page.locator("[data-claxedo]").waitFor({ timeout: 45_000 })
  await (await composer(page)).waitFor({ timeout: 45_000 })
  await sleep(page, 1500)
}

async function clickHarnessButton(page) {
  const rect = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button")]
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          text: (el.innerText || el.getAttribute("aria-label") || "").trim(),
          disabled: el.disabled,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        }
      })
      .filter((item) => item.x > 350 && item.width > 30 && !item.disabled && /^(OpenCode|Claude|Codex|Cursor|Pi)$/.test(item.text))
      .sort((a, b) => b.y - a.y)
    return candidates[0]
  })
  if (!rect) throw new Error("Could not find prompt harness button")
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await sleep(page, 800)
}

async function chooseHarness(page, harness) {
  await clickHarnessButton(page)
  await page.getByRole("option", { name: harness.option }).nth(harness.index).click({ timeout: 30_000 })
  await sleep(page, 5000)
}

function sessionIdFromUrl(page) {
  return page.url().match(/\/session\/([^/?#]+)/)?.[1]
}

function sessionApi(path) {
  if (workspaceId) return `${apiBase}/workspaces/${encodeURIComponent(workspaceId)}${path}`
  return `${apiBase}${path}${path.includes("?") ? "&" : "?"}directory=${encodedDirectory}`
}

async function getSession(sessionId) {
  const response = await fetch(sessionApi(`/session/${sessionId}`))
  if (!response.ok) throw new Error(`session fetch failed ${response.status}`)
  return await response.json()
}

async function getMessages(sessionId) {
  const response = await fetch(sessionApi(`/session/${sessionId}/message?limit=120`))
  if (!response.ok) throw new Error(`message fetch failed ${response.status}`)
  return await response.json()
}

async function getConfig(sessionId) {
  const response = await fetch(sessionApi(`/session/${sessionId}/config`))
  if (!response.ok) throw new Error(`config fetch failed ${response.status}`)
  return await response.json()
}

function assistantError(message) {
  const error = message.info?.error
  const data = error && typeof error === "object" ? error.data : undefined
  if (data && typeof data === "object" && typeof data.message === "string") return data.message
  return undefined
}

function partText(part) {
  if (part?.type && part.type !== "text") return ""
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function assistantText(message) {
  return Array.isArray(message.parts) ? message.parts.map(partText).join("") : ""
}

function normalizedAssistantReply(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(Build|Plan|Act|Ask)\s+·\s+/.test(line))
    .join("\n")
    .trim()
}

function authFailureText(text) {
  return /auth(entication|orization)? required|not logged in|missing_bearer_token|bearer token is required|401 unauthorized/i.test(text)
}

function assistantVisible(message) {
  return assistantError(message) || assistantText(message).trim()
}

function assistantOk(output, expectedText) {
  return !output.error &&
    output.partCount > 0 &&
    output.domVisible === true &&
    !authFailureText(output.text ?? "")
}

function authPageFailure(run) {
  const pageError = run.pageErrors?.find((item) => authFailureText(`${item.message}\n${item.stack ?? ""}`))
  if (pageError) return pageError.message
  const consoleError = run.console?.find((item) => item.type === "error" && authFailureText(item.text))
  if (consoleError) return consoleError.text
}

async function waitForAssistant(sessionId, count, expectedText) {
  const started = Date.now()
  let failedAt
  let noVisibleSettledAt
  while (Date.now() - started < 210_000) {
    const messages = await getMessages(sessionId)
    const assistants = messages.filter((message) => message.info?.role === "assistant")
    const target = assistants[count - 1]
    const session = await getSession(sessionId)
    if (target && assistantVisible(target)) {
      const partCount = Array.isArray(target.parts) ? target.parts.length : 0
      const text = assistantText(target)
      const error = assistantError(target) ?? (authFailureText(text) ? text : undefined)
      if (error || (partCount > 0 && (session.status === "idle" || session.lastTurn?.status === "completed" || session.lastTurn?.status === "failed"))) {
        return {
          assistantCount: assistants.length,
          visibleAssistantCount: assistants.filter(assistantVisible).length,
          partCount,
          text,
          normalizedText: normalizedAssistantReply(text),
          error,
          ok: !error && partCount > 0,
          sessionStatus: session.status,
          lastTurnStatus: session.lastTurn?.status,
        }
      }
    }
    if (target && (session.status === "idle" || session.lastTurn?.status === "failed")) {
      noVisibleSettledAt ??= Date.now()
      if (Date.now() - noVisibleSettledAt > 15_000) {
        const partCount = Array.isArray(target.parts) ? target.parts.length : 0
        return {
          assistantCount: assistants.length,
          visibleAssistantCount: assistants.filter(assistantVisible).length,
          partCount,
          text: assistantText(target),
          normalizedText: normalizedAssistantReply(assistantText(target)),
          error: `Assistant message had no visible text or error (part count: ${partCount})`,
          ok: false,
          sessionStatus: session.status,
          lastTurnStatus: session.lastTurn?.status,
        }
      }
    }
    if (session.lastTurn?.status === "failed" && target && !assistantVisible(target)) {
      failedAt ??= Date.now()
      if (Date.now() - failedAt > 25_000) {
        throw new Error(`Turn ${count} failed without visible assistant error: ${session.lastTurn.error ?? "session error"}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  throw new Error(`Timed out waiting for assistant turn ${count} in ${sessionId}`)
}

async function readDomAssistant(page, expectedText, minVisibleRows = 1) {
  return await page.evaluate(({ expectedText, minVisibleRows }) => {
    const normalize = (text) => String(text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^(Build|Plan|Act|Ask|Agent)\s+·\s+/.test(line))
      .join("\n")
      .trim()
    const items = [...document.querySelectorAll("[data-slot='session-turn-assistant-content']")]
      .map((el) => {
        const rect = el.getBoundingClientRect()
        const text = (el.innerText || "").trim()
        return {
          hidden: el.getAttribute("aria-hidden") === "true",
          visible: rect.width > 0 && rect.height > 0,
          text,
          normalizedText: normalize(text),
        }
      })
    const visibleRows = items.filter((item) => item.visible && !item.hidden && item.normalizedText)
    const visibleText = items
      .filter((item) => item.visible && !item.hidden && item.text)
      .map((item) => item.text)
      .join("\n")
    const exactRows = typeof expectedText === "string" && expectedText.length > 0
      ? visibleRows.filter((item) => item.normalizedText.includes(expectedText))
      : visibleRows
    return {
      assistantContentCount: items.length,
      visibleAssistantContentCount: visibleRows.length,
      domVisible: typeof expectedText === "string" && expectedText.length > 0
        ? exactRows.length > 0 || visibleRows.length >= minVisibleRows
        : visibleRows.length >= minVisibleRows,
      domExact: typeof expectedText === "string" && expectedText.length > 0
        ? exactRows.length > 0
        : visibleRows.length >= minVisibleRows,
      domText: visibleText,
      domRows: visibleRows.map((item) => item.normalizedText),
      bodyTail: document.body.innerText.slice(-1600),
    }
  }, { expectedText, minVisibleRows })
}

async function waitForDomAssistant(page, expectedText, minVisibleRows = 1) {
  const started = Date.now()
  let last
  while (Date.now() - started < 60_000) {
    last = await readDomAssistant(page, expectedText, minVisibleRows)
    if (last.domVisible) return last
    await sleep(page, 1000)
  }
  throw new Error(`Timed out waiting for ${minVisibleRows} DOM-visible assistant rows: ${JSON.stringify(last)}`)
}

async function waitForSubmitEnabled(page, timeout = 60_000) {
  await page.waitForFunction(() => {
    const submit = [...document.querySelectorAll("[data-action='prompt-submit']")].at(-1)
    return !!submit && !submit.disabled
  }, undefined, { timeout })
}

async function sendTurn(page, run, harness, turn, expectedSessionId) {
  const expectedText = expectedTurnText(harness, turn)
  const prompt = `${harness.label} video proof turn ${turn}: include marker ${expectedText} in your reply.`
  await setAnnotation(page, `${harness.label}: SEND TURN ${turn}`, [
    "Typing into the visible composer.",
    "Clicking the real Send button.",
    "Waiting for real assistant content and idle state.",
    "Visible assistant errors are recorded as failures.",
  ])
  await (await composer(page)).fill(prompt)
  await sleep(page, 1000)
  await waitForSubmitEnabled(page)
  const before = run.requests.length
  await page.locator("[data-action='prompt-submit']").last().click()
  let promptRequest
  const started = Date.now()
  while (Date.now() - started < 60_000) {
    promptRequest = expectedSessionId
      ? run.requests.slice(before).find((request) =>
        request.url.includes(`/session/${expectedSessionId}/prompt_async`) ||
        request.url.includes(`/session/${expectedSessionId}/message`)
      )
      : run.requests.slice(before).find((request) => /\/session\/[^/]+\/prompt_async/.test(request.url))
    if (promptRequest) break
    if (!expectedSessionId && sessionIdFromUrl(page)) break
    await sleep(page, 500)
  }
  const sessionId = expectedSessionId
    ?? sessionIdFromUrl(page)
    ?? promptRequest?.url.match(/\/session\/([^/]+)\/(?:prompt_async|message)/)?.[1]
  if (!sessionId) {
    run.noSessionState = await readState(page).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    throw new Error(`No session id after ${harness.label} turn ${turn}`)
  }
  promptRequest ??= run.requests.slice(before).find((request) =>
    request.url.includes(`/session/${sessionId}/prompt_async`) ||
    request.url.includes(`/session/${sessionId}/message`)
  )
  const promptBody = promptRequest?.postData ? JSON.parse(promptRequest.postData) : undefined
  const output = await waitForAssistant(sessionId, turn, expectedText)
  const domOutput = output.ok ? await waitForDomAssistant(page, expectedText, turn) : await readDomAssistant(page, expectedText, turn)
  Object.assign(output, domOutput)
  const state = await readState(page)
  await setAnnotation(page, `${harness.label}: TURN ${turn} ${assistantOk(output, expectedText) ? "OK" : "ERROR"}`, [
    `Session: ${sessionId}`,
    `usable assistant content: ${assistantOk(output, expectedText)}`,
    `expected marker: ${expectedText}`,
    `DOM-visible assistant text: ${output.domVisible}`,
    `assistant outputs: ${output.visibleAssistantCount}/${output.assistantCount}`,
    `assistant parts: ${output.partCount}`,
    `session status: ${output.sessionStatus ?? "unknown"}`,
    `assistant error: ${output.error ?? "none"}`,
    `payload providerID: ${promptBody?.model?.providerID ?? "not captured"}`,
    `payload modelID: ${promptBody?.model?.modelID ?? "not captured"}`,
  ])
  await setPanel(page, [
    `${harness.label} turn ${turn}`,
    `providerID: ${promptBody?.model?.providerID ?? "not captured"}`,
    `modelID: ${promptBody?.model?.modelID ?? "not captured"}`,
    `variant: ${promptBody?.variant ?? "absent"}`,
    `usable assistant content: ${assistantOk(output, expectedText)}`,
    `expected marker: ${expectedText}`,
    `DOM-visible assistant text: ${output.domVisible}`,
    `assistant outputs: ${output.visibleAssistantCount}/${output.assistantCount}`,
    `session status: ${output.sessionStatus ?? "unknown"}`,
    `assistant error: ${output.error ?? "none"}`,
    `OpenCode model control: ${state.hasOpenCodeModelControl}`,
    `OpenCode variant control: ${state.hasOpenCodeVariantControl}`,
  ])
  await sleep(page, 3000)
  return { sessionId, prompt, promptBody, state, ...output }
}

function harnessOptionsFailure(run, harness) {
  return run.responses.find((response) =>
    response.status >= 400 &&
    response.url.includes("/api/claxedo/agent-config/harness/options") &&
    new URL(response.url).searchParams.get("type") === harness.type
  )
}

async function recordHarness(harness) {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 250,
    args: ["--window-size=1440,1000"],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: rawDir, size: { width: 1440, height: 1000 } },
  })
  const page = await context.newPage()
  const run = { key: harness.key, proofPrefix: harness.proofPrefix, label: harness.label, turns: [], requests: [], responses: [] }
  evidence.harnesses.push(run)
  page.on("console", (message) => {
    run.console ??= []
    run.console.push({ type: message.type(), text: message.text(), ts: Date.now() })
  })
  page.on("pageerror", (error) => {
    run.pageErrors ??= []
    run.pageErrors.push({ message: error.message, stack: error.stack, ts: Date.now() })
  })
  page.on("close", () => {
    run.pageClosedAt = Date.now()
  })

  page.on("request", (request) => {
    const url = request.url()
    if (!url.includes("127.0.0.1:3001")) return
    if (!/session|prompt_async|agent-config|provider|global\/health/.test(url)) return
    run.requests.push({ method: request.method(), url, postData: request.postData(), ts: Date.now() })
  })
  page.on("response", (response) => {
    const url = response.url()
    if (!url.includes("127.0.0.1:3001")) return
    if (!/session|prompt_async|agent-config|provider|global\/health/.test(url)) return
    run.responses.push({ status: response.status(), url, ts: Date.now() })
  })

  try {
    await openDraft(page)
    await setAnnotation(page, `${harness.label}: SELECT`, [
      "Fresh browser context.",
      "Real localhost app and backend.",
      "No mocked harnesses or intercepted responses.",
    ])
    await chooseHarness(page, harness)
    run.selectedState = await readState(page)
    const optionsFailure = harnessOptionsFailure(run, harness)
    await setPanel(page, [
      `${harness.label} selected`,
      `submit disabled before typing: ${run.selectedState.submitDisabled}`,
      `OpenCode model control: ${run.selectedState.hasOpenCodeModelControl}`,
      `OpenCode variant control: ${run.selectedState.hasOpenCodeVariantControl}`,
      ...(run.selectedState.issueLabels?.length ? [`issue: ${run.selectedState.issueLabels.at(-1)?.title ?? run.selectedState.issueLabels.at(-1)?.ariaLabel}`] : []),
      ...(optionsFailure ? [`harness options status: ${optionsFailure.status}`] : []),
    ])
    await sleep(page, 2500)
    if (optionsFailure) {
      await setAnnotation(page, `${harness.label}: UNAVAILABLE BEFORE SEND`, [
        `Harness options returned HTTP ${optionsFailure.status}.`,
        "The composer remains disabled intentionally.",
        "No prompt_async request is sent.",
        "This is not counted as assistant success.",
      ])
      await setPanel(page, [
        `${harness.label} unavailable before send`,
        `harness options status: ${optionsFailure.status}`,
        "prompt_async request: not sent",
        "backend remains healthy",
      ])
      await sleep(page, 5500)
      throw new Error(`Harness unavailable before send: options returned HTTP ${optionsFailure.status}`)
    }

    const first = await sendTurn(page, run, harness, 1)
    run.sessionId = first.sessionId
    run.turns.push(first)
    if (!first.ok) throw new Error(`Turn 1 returned assistant error: ${first.error ?? "no assistant content"}`)
    run.configAfterCreate = await getConfig(first.sessionId)
    await setAnnotation(page, `${harness.label}: SESSION CONFIG`, [
      `harness: ${JSON.stringify(run.configAfterCreate.harness)}`,
      `model: ${JSON.stringify(run.configAfterCreate.model)}`,
      `variant: ${run.configAfterCreate.variant ?? "null"}`,
    ])
    await sleep(page, 3000)

    const second = await sendTurn(page, run, harness, 2, first.sessionId)
    run.turns.push(second)
    if (!second.ok) throw new Error(`Turn 2 returned assistant error: ${second.error ?? "no assistant content"}`)

    await setAnnotation(page, `${harness.label}: RELOAD`, [
      "Reloading the same session.",
      "Next send verifies reload hydration.",
    ])
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.locator("[data-claxedo]").waitFor({ timeout: 45_000 })
    await (await composer(page)).waitFor({ timeout: 45_000 })
    await sleep(page, 3000)
    run.reloadState = await readState(page)
    run.reloadConfig = await getConfig(first.sessionId)
    await setPanel(page, [
      `${harness.label} after reload`,
      `harness: ${JSON.stringify(run.reloadConfig.harness)}`,
      `model: ${JSON.stringify(run.reloadConfig.model)}`,
      `OpenCode model control: ${run.reloadState.hasOpenCodeModelControl}`,
      `OpenCode variant control: ${run.reloadState.hasOpenCodeVariantControl}`,
    ])
    await sleep(page, 2500)

    const third = await sendTurn(page, run, harness, 3, first.sessionId)
    run.turns.push(third)
    if (!third.ok) throw new Error(`Turn 3 returned assistant error: ${third.error ?? "no assistant content"}`)
    const pageFailure = authPageFailure(run)
    if (pageFailure) throw new Error(`Page auth failure observed: ${pageFailure}`)
    await setAnnotation(page, `${harness.label}: FULL LOOP COMPLETE`, [
      "Turn 1 usable assistant content observed.",
      "Turn 2 usable assistant content observed.",
      "Reload completed.",
      "Turn 3 usable assistant content observed.",
    ])
    await sleep(page, 3500)
  } catch (error) {
    run.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    if (!page.isClosed()) try {
      await setAnnotation(page, `${harness.label}: LIVE BLOCKER`, [
        run.error.split("\n")[0],
        "This is the real app/backend result.",
        "Video stops here for this harness.",
      ])
      await setPanel(page, [
        `${harness.label} stopped before full loop completion`,
        run.error.split("\n")[0],
        `completed turns: ${run.turns.length}`,
      ])
      await sleep(page, 5500)
    } catch {}
  } finally {
    const video = page.video()
    run.finalUrl = page.isClosed() ? "page closed" : page.url()
    await withTimeout(context.close().catch((error) => {
      run.contextCloseError = error instanceof Error ? error.message : String(error)
    }), 60_000, `${harness.label} context close`).catch((error) => {
      run.contextCloseError = error instanceof Error ? error.message : String(error)
    })
    run.rawVideo = await withTimeout(video?.path() ?? Promise.resolve(undefined), 10_000, `${harness.label} video path`).catch((error) => {
      run.videoError = error instanceof Error ? error.message : String(error)
      return undefined
    })
    await withTimeout(browser.close().catch((error) => {
      run.browserCloseError = error instanceof Error ? error.message : String(error)
    }), 10_000, `${harness.label} browser close`).catch((error) => {
      run.browserCloseError = error instanceof Error ? error.message : String(error)
    })
  }
}

for (const harness of harnesses) {
  await recordHarness(harness)
  writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2))
}

writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ runId, outDir, evidencePath: join(outDir, "evidence.json"), harnesses: evidence.harnesses.map((item) => ({ label: item.label, turns: item.turns.length, ok: item.turns.length === 3 && item.turns.every((turn, index) => assistantOk(turn, expectedTurnText(item, index + 1))) && !item.error, error: item.error?.split("\n")[0], rawVideo: item.rawVideo })) }, null, 2))
