/**
 * OpenCode advertises agent names through the real catalog and receives the selected
 * name on browser submission. Only its model HTTP endpoint is scripted. An isolated
 * session is created before navigation so the send exercises the persisted config.
 * Public API prompts may omit the agent and use the engine default; restored-tool
 * checks use that entrypoint without claiming browser first-send coverage.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { startRealLocalServer, type RealLocalServer } from "../helpers/real-local-server"
import { composeText } from "../helpers/web-signed-relay-harness"
import { expectAssistantReplyVisible, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

async function configureScriptedOpenCode(server: RealLocalServer, directory: string, request: APIRequestContext) {
  await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({
    providers: {
      claxedo_test: {
        name: "Scripted model",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: server.scripted.v1Url, apiKey: "test-key" },
        models: { test: { name: "Scripted model" } },
      },
    },
  }))
  execFileSync("git", ["init"], {
    cwd: directory,
    env: { ...process.env, GIT_INDEX_FILE: undefined, GIT_AUTHOR_DATE: undefined },
    stdio: "ignore",
  })
  const register = await request.post(`${server.url}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`)
  expect(register.ok(), await register.text()).toBe(true)
  const configure = await request.post(`${server.url}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(directory)}`, {
    data: { harness: { kind: "native", harnessId: "opencode" } },
  })
  expect(configure.ok(), await configure.text()).toBe(true)
  const provider = await request.put(`${server.url}/api/claxedo/agent-config/providers/custom?nativeHarness=opencode`, {
    data: { providerID: "claxedo_test", name: "Scripted model", baseURL: server.scripted.v1Url, models: { test: { name: "Scripted model" } } },
  })
  expect(provider.ok(), await provider.text()).toBe(true)
  const credential = await request.put(`${server.url}/api/claxedo/credentials`, {
    data: { provider_id: "claxedo_test", kind: "api_key", source: "local_only", secret: "test-key" },
  })
  expect(credential.ok(), await credential.text()).toBe(true)
}

async function seedProject(page: Page, directory: string) {
  await page.addInitScript((dir) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl: string; activeDirectory: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    if (localStorage.getItem("claxedo.global.dat:server")) return
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({
      list: [], projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
    }))
  }, directory)
}

test("API-started OpenCode steering keeps the completed reply visible through reload @core @tier-real @surface-web", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  if (process.env.CLAXEDO_TIER_REAL_E2E !== "1") throw new Error("GATING: CLAXEDO_TIER_REAL_E2E=1 is required")
  const server = await startRealLocalServer("opencode-api-steering", {
    port: Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317),
  })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-api-steering-")))
  const first = "OPENCODE_STEERING_INITIAL"
  const final = "OPENCODE_STEERING_FINAL"
  const release = server.scripted.holdTextReplies(first)
  let sessionID: string | undefined
  try {
    await configureScriptedOpenCode(server, directory, page.request)
    const created = await page.request.post(`${server.url}/session?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`, {
      data: { title: "API-started OpenCode steering", model: { providerID: "claxedo_test", modelID: "test" } },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const session = await created.json() as { id: string }
    sessionID = session.id
    await seedProject(page, directory)
    await page.goto(`/s/${session.id}`)
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible()
    server.scripted.scriptTool({ name: "shell", input: { command: "printf STEERING_SHELL_DONE" } })
    const endpoint = `${server.url}/session/${session.id}/prompt_async?directory=${encodeURIComponent(directory)}`
    const started = await page.request.post(endpoint, {
      data: {
        messageID: "msg_api_steering_initial",
        model: { providerID: "claxedo_test", modelID: "test" },
        parts: [{ type: "text", text: `Run the requested shell tool, then reply with exactly this one token: ${first}` }],
      },
    })
    expect(started.ok(), await started.text()).toBe(true)
    await expect.poll(() => server.scripted.requests.some(({ reply }) => reply.kind === "text" && reply.text === first), {
      message: "the real tool finishes and the active turn waits for its model response", timeout: 30_000,
    }).toBe(true)
    const steered = await page.request.post(endpoint, {
      data: {
        messageID: "msg_api_steering_followup",
        delivery: "steer",
        model: { providerID: "claxedo_test", modelID: "test" },
        parts: [{ type: "text", text: `Incorporate this follow-up into the running turn. Reply with exactly this one token: ${final}` }],
      },
    })
    expect(steered.ok(), await steered.text()).toBe(true)
    expect(await steered.json()).toEqual({ delivery: "steer" })
    release()
    await expect.poll(() => server.scripted.requests.some(({ prompt }) => prompt.includes(final)), {
      message: "the real engine delivers the steering addition to the model", timeout: 30_000,
    }).toBe(true)
    const readMessages = async () => {
      const response = await page.request.get(`${server.url}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
      expect(response.ok()).toBe(true)
      return await response.json() as Array<{ info: { role: string; time?: { completed?: number } }; parts: Array<{ type: string; text?: string }> }>
    }
    await expect.poll(async () => (await readMessages()).some(({ info, parts }) =>
      info.role === "assistant" && info.time?.completed && parts.some(part => part.type === "text" && part.text?.includes(final))),
    { message: "the steered reply completes in canonical stored messages", timeout: 30_000 }).toBe(true)
    await fs.writeFile(testInfo.outputPath("stored-completed-messages.json"), JSON.stringify(await readMessages(), null, 2))
    await expectAssistantReplyVisible(page, final, { spec: "real-session-rendering-harnesses", scenario: "opencode-steered-completed" })
    await expectNoDuplicateRows(page)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expectAssistantReplyVisible(page, final, { spec: "real-session-rendering-harnesses", scenario: "opencode-steered-reloaded" })
    await expectNoDuplicateRows(page)
  } finally {
    release()
    try {
      await fs.writeFile(testInfo.outputPath("model-requests.json"), JSON.stringify(server.scripted.requests, null, 2))
      await fs.writeFile(testInfo.outputPath("server.log"), server.log())
      if (sessionID) {
        const messages = await page.request.get(`${server.url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`)
        await fs.writeFile(testInfo.outputPath("stored-messages.json"), await messages.text())
      }
    } finally {
      await server.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
})

test("OpenCode default agent completes a browser-submitted prompt @core @tier-real @surface-web", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  if (process.env.CLAXEDO_TIER_REAL_E2E !== "1") throw new Error("GATING: CLAXEDO_TIER_REAL_E2E=1 is required")
  const server = await startRealLocalServer("opencode-tool-rendering", {
    port: Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317),
  })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-tool-rendering-")))
  const reply = "OPENCODE_DEFAULT_AGENT_DONE"
  let sessionID: string | undefined
  const submissions: unknown[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/prompt_async")) submissions.push(request.postDataJSON())
  })
  try {
    await configureScriptedOpenCode(server, directory, page.request)
    const created = await page.request.post(`${server.url}/session?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`, {
      data: { title: "OpenCode default agent", model: { providerID: "claxedo_test", modelID: "test" } },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const session = await created.json() as { id: string }
    sessionID = session.id
    const catalog = await page.request.get(`${server.url}/api/claxedo/agent-config/agents?directory=${encodeURIComponent(directory)}&type=opencode`)
    expect(catalog.ok()).toBe(true)
    await fs.writeFile(testInfo.outputPath("agent-catalog.json"), await catalog.text())
    await seedProject(page, directory)
    const history = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes(`/session/${session.id}/message`))
    await page.goto(`/s/${session.id}`)
    expect((await history).ok()).toBe(true)
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-action="prompt-harness-model"]').last()).toHaveAttribute("data-model", "test", { timeout: 30_000 })
    await composeText(page, composer, `Reply with exactly this one token and nothing else: ${reply}`)
    await expect(page.locator(SELECTORS.submitControl).last()).toBeEnabled({ timeout: 30_000 })
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, reply)
    expect(server.scripted.requests.some((request) => request.prompt.includes(reply)), "the selected agent reaches the scripted model").toBe(true)
  } finally {
    await fs.writeFile(testInfo.outputPath("browser-submissions.json"), JSON.stringify(submissions, null, 2))
    await fs.writeFile(testInfo.outputPath("model-requests.json"), JSON.stringify(server.scripted.requests, null, 2))
    if (sessionID) {
      const messages = await page.request.get(`${server.url}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`)
      await fs.writeFile(testInfo.outputPath("stored-messages.json"), await messages.text())
    }
    await fs.writeFile(testInfo.outputPath("server.log"), server.log())
    await server.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("API-started OpenCode local-file image restores as a compact tile with a full preview @core @tier-real @surface-web", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  if (process.env.CLAXEDO_TIER_REAL_E2E !== "1") throw new Error("GATING: CLAXEDO_TIER_REAL_E2E=1 is required")
  const server = await startRealLocalServer("opencode-api-image", {
    port: Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317),
  })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-api-image-")))
  const marker = "OPENCODE_API_IMAGE_DONE"
  const filename = path.join(directory, "qa-local-image.png")
  try {
    await configureScriptedOpenCode(server, directory, page.request)
    await fs.copyFile(new URL("../../public/web-app-manifest-512x512.png", import.meta.url), filename)
    await fs.copyFile(filename, testInfo.outputPath("source-image.png"))
    const created = await page.request.post(`${server.url}/session?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`, {
      data: { title: "API-started OpenCode image", model: { providerID: "claxedo_test", modelID: "test" } },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const session = await created.json() as { id: string }
    server.scripted.scriptText({ marker, text: `${marker}\n\n![QA local image](${pathToFileURL(filename).href})` })
    const sent = await page.request.post(`${server.url}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`, {
      data: {
        messageID: "msg_api_image_rendering",
        model: { providerID: "claxedo_test", modelID: "test" },
        parts: [{ type: "text", text: `Show the requested image and include ${marker} in your response.` }],
      },
      timeout: 45_000,
    })
    expect(sent.ok(), await sent.text()).toBe(true)
    expect(server.scripted.requests.some((request) => request.prompt.includes(marker))).toBe(true)
    const messages = await page.request.get(`${server.url}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
    expect(messages.ok()).toBe(true)
    await fs.writeFile(testInfo.outputPath("stored-messages.json"), await messages.text())
    await seedProject(page, directory)
    await page.goto(`/s/${session.id}`)
    await expectAssistantReplyVisible(page, marker, { spec: "real-session-rendering-harnesses", scenario: "opencode-api-image-opened" })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expectAssistantReplyVisible(page, marker, { spec: "real-session-rendering-harnesses", scenario: "opencode-api-image-reloaded" })
    await page.screenshot({ path: testInfo.outputPath("api-local-image-restored.png") })
    const image = page.locator(`${SELECTORS.assistantContentVisible} img[alt="QA local image"]`).last()
    await expect(image, "the existing local PNG renders an image instead of only alt text").toBeVisible()
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(512)
    const tile = await image.boundingBox()
    expect(tile).not.toBeNull()
    expect.soft(Math.abs(tile!.width - 80), "the image tile is 80px wide").toBeLessThanOrEqual(1)
    expect.soft(Math.abs(tile!.height - 80), "the image tile is 80px high").toBeLessThanOrEqual(1)
    await image.click()
    const preview = page.locator('[data-slot="image-preview-image"]')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(512)
    await page.screenshot({ path: testInfo.outputPath("api-local-image-preview.png") })
    await page.locator('[data-slot="image-preview-close"]').click()
    await expect(preview).toHaveCount(0)
  } finally {
    try {
      await fs.writeFile(testInfo.outputPath("model-requests.json"), JSON.stringify(server.scripted.requests, null, 2))
      await fs.writeFile(testInfo.outputPath("server.log"), server.log())
    } finally {
      await server.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
})

test("API-started OpenCode shell retains its executed command and result in the restored transcript @core @tier-real @surface-web", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  if (process.env.CLAXEDO_TIER_REAL_E2E !== "1") throw new Error("GATING: CLAXEDO_TIER_REAL_E2E=1 is required")
  const server = await startRealLocalServer("opencode-api-tool", {
    port: Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317),
  })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-api-tool-")))
  const marker = "OPENCODE_API_TOOL_DONE"
  const result = "OPENCODE_API_TOOL_RESULT"
  const command = `printf ${result}`
  try {
    await configureScriptedOpenCode(server, directory, page.request)
    const created = await page.request.post(`${server.url}/session?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`, {
      data: { title: "API-started OpenCode shell", model: { providerID: "claxedo_test", modelID: "test" } },
    })
    expect(created.ok(), await created.text()).toBe(true)
    const session = await created.json() as { id: string }
    server.scripted.scriptTool({ name: "shell", input: { command, description: "Print the tool result" } })
    const sent = await page.request.post(`${server.url}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`, {
      data: {
        messageID: "msg_api_tool_rendering",
        model: { providerID: "claxedo_test", modelID: "test" },
        parts: [{ type: "text", text: `Run the requested tool, then reply with exactly this one token and nothing else: ${marker}` }],
      },
      timeout: 45_000,
    })
    expect(sent.ok(), await sent.text()).toBe(true)
    const toolResults = server.scripted.requests.flatMap(({ body }) => "messages" in body
      ? body.messages.filter((message) => message.role === "tool") : [])
    await fs.writeFile(testInfo.outputPath("model-tool-results.json"), JSON.stringify(toolResults, null, 2))
    expect(JSON.stringify(toolResults), "the real shell returns stdout to its model").toContain(result)
    const messages = await page.request.get(`${server.url}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
    expect(messages.ok()).toBe(true)
    const rows = await messages.json() as Array<{ parts: Array<{ type: string; id: string }> }>
    await fs.writeFile(testInfo.outputPath("stored-messages.json"), JSON.stringify(rows, null, 2))
    const tools = rows.flatMap((row) => row.parts).filter((part) => part.type === "tool")
    expect(tools).toHaveLength(1)
    await seedProject(page, directory)
    await page.goto(`/s/${session.id}`)
    await expectAssistantReplyVisible(page, marker, { spec: "real-session-rendering-harnesses", scenario: "opencode-api-tool-opened" })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expectAssistantReplyVisible(page, marker, { spec: "real-session-rendering-harnesses", scenario: "opencode-api-tool-reloaded" })
    const part = page.locator(SELECTORS.toolPart(tools[0].id))
    await part.scrollIntoViewIfNeeded()
    await part.locator('[data-component="tool-trigger"]').click()
    await page.screenshot({ path: testInfo.outputPath("api-tool-expanded.png") })
    await expect.soft(part, "the restored shell displays its executed command").toContainText(command)
    await expect.soft(part, "the restored shell displays its returned stdout").toContainText(result)
  } finally {
    try {
      await fs.writeFile(testInfo.outputPath("model-requests.json"), JSON.stringify(server.scripted.requests, null, 2))
      await fs.writeFile(testInfo.outputPath("server.log"), server.log())
    } finally {
      await server.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
})
