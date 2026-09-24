import {
  assistantText,
  expect,
  installedCli,
  SCRIPTED_PROVIDER_IDS,
  test,
  unexpectedEgress,
  type CliName,
  type ModelChoice,
  type SessionHarness,
} from "../harness"

const PI: SessionHarness = { id: "pi", access: "native" }

const CHOSEN = [
  { marker: "ISOLATEDOPENAI", vendorModel: "gpt-4.1", model: { providerId: "pi", modelId: "openai/gpt-4.1" } },
  { marker: "ISOLATEDANTHROPIC", vendorModel: "claude-sonnet-4-5", model: { providerId: "pi", modelId: "anthropic/claude-sonnet-4-5" } },
] satisfies { marker: string; vendorModel: string; model: ModelChoice }[]

const CLIS: { name: CliName; marker: string }[] = [
  { name: "claude", marker: "ISOLATEDCLAUDE" },
  { name: "codex", marker: "ISOLATEDCODEX" },
]

test.skip(({ isMobile }) => isMobile, "isolation belongs to the stack, so it runs once at desktop width")

test("00 isolation: Pi's default model and every chosen provider answer only from the scripted model server", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("isolation")
  for (const { marker, model } of CHOSEN) {
    const session = await api.createSession(workspace.directory, { title: marker, harness: PI, model })
    await api.prompt(workspace.directory, session.id, `Reply with exactly this one token: ${marker}`, { model })
    expect(unexpectedEgress(stack.egress.attempts)).toEqual([])
    expect(assistantText(await api.messages(workspace.directory, session.id))).toContain(marker)
  }

  const session = await api.createSession(workspace.directory, { title: "Default model", harness: PI })
  await app.goto(`${stack.url}/w/${workspace.id}/s/${session.id}`)
  const prompt = app.getByRole("textbox", { name: "Prompt" })
  await prompt.fill("Reply with exactly this one token: ISOLATEDDEFAULT")
  await prompt.press("Enter")
  await expect(app.getByText("ISOLATEDDEFAULT", { exact: true })).toBeVisible()

  const catalog = await api.providerCatalog("pi")
  expect([...catalog.connected].sort()).toEqual([...SCRIPTED_PROVIDER_IDS].sort())
  expect(stack.scripted.requests.map((request) => request.model)).toEqual(expect.arrayContaining(CHOSEN.map(({ vendorModel }) => vendorModel)))
  expect(unexpectedEgress(stack.egress.attempts)).toEqual([])
})

for (const { name, marker } of CLIS) {
  test(`00 isolation: a ${name} turn answers only from the scripted model server`, async ({ stack, api }) => {
    const cli = await installedCli(name)
    test.skip(!cli.available, cli.available ? "" : cli.reason)
    const workspace = await stack.daemon.makeWorkspace(`isolation-${name}`)
    const session = await api.createSession(workspace.directory, { title: marker, harness: { id: name, access: "native" } })
    await api.prompt(workspace.directory, session.id, `Reply with exactly this one token: ${marker}`)
    expect(unexpectedEgress(stack.egress.attempts)).toEqual([])
    expect(assistantText(await api.messages(workspace.directory, session.id))).toContain(marker)
    expect(stack.scripted.requests.some((request) => request.prompt.includes(marker))).toBe(true)
  })
}
