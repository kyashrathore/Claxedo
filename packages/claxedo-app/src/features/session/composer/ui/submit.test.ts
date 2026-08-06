import { describe, expect, test } from "bun:test"

/**
 * Architecture-contract checks for the submit orchestrator: these assert that
 * `submit.ts` delegates to its extracted helpers (transport, directory,
 * create-session, command-prompt) rather than re-implementing them inline, and
 * that the session-config dedupe stays query-owned. They read source text on
 * purpose (tracked in source-text-assertions-baseline.json); the behavioral
 * suites live in the sibling submit.<concern>.test.ts files on submit.harness.test.ts.
 */
describe("submit.ts architecture contract", () => {
  test("rubric C1: session config dedupe state is query-owned", async () => {
    const source = await Bun.file(new URL("./submit.ts", import.meta.url)).text()

    expect(source).not.toContain("lastSavedConfigBySession = new Map")
    expect(source).not.toContain("lastSavedConfigBySession.get")
    expect(source).not.toContain("lastSavedConfigBySession.set")
  })

  test("draft submit reads harness ownership from the exact scope owned by the picker", async () => {
    const source = await Bun.file(new URL("./submit.ts", import.meta.url)).text()
    const sourceScope = source.slice(source.indexOf("const sourceScope"), source.indexOf("const scope =", source.indexOf("const sourceScope")))

    expect(sourceScope).toContain("input.harnessScope?.()")
    const composer = await Bun.file(new URL("../composer.tsx", import.meta.url)).text()
    expect(composer).toContain("harnessScope: scope")
  })


  test("normal submit dispatch uses the shared submit phases without a prompt-machine side adapter", async () => {
    const source = await Bun.file(new URL("./submit-normal-prompt.ts", import.meta.url)).text()

    expect(source).not.toContain("prompt-machine-effects")
    expect(source).not.toContain("runExistingSessionPromptMachineEffects")
    expect(source).not.toContain("shouldRunExistingSessionPromptMachineEffects")
    expect(source.indexOf("const promptRequest = preparePromptRequest(prepare)")).toBeLessThan(source.indexOf("applyOptimisticPromptHandoff(handoff(promptRequest))"))
    expect(source.indexOf("applyOptimisticPromptHandoff(handoff(promptRequest))")).toBeLessThan(source.indexOf("await recordPromptSubmission(input.record)"))
    expect(source.indexOf("await recordPromptSubmission(input.record)")).toBeLessThan(source.indexOf("void sendPromptRequest"))
  })


  test("shell and slash dispatch stay in the command helper without slash re-parsing", async () => {
    const submitSource = await Bun.file(new URL("./submit.ts", import.meta.url)).text()
    const helperSource = await Bun.file(new URL("./submit-command-prompt.ts", import.meta.url)).text()

    expect(submitSource).toContain("dispatchCommandPromptSubmit")
    expect(submitSource).not.toContain("dispatchShellCommand")
    expect(submitSource).not.toContain("dispatchSlashCommand")
    expect(helperSource).toContain("dispatchShellCommand")
    expect(helperSource).toContain("dispatchSlashCommand")
    expect(helperSource).not.toContain("startsWith")
    expect(helperSource).not.toContain("customCommandNames")
  })


  test("created session finalization stays in the create-session helper", async () => {
    const submitSource = await Bun.file(new URL("./submit.ts", import.meta.url)).text()
    const helperSource = await Bun.file(new URL("./submit-create-session.ts", import.meta.url)).text()
    const directorySource = await Bun.file(new URL("./submit-directory.ts", import.meta.url)).text()
    const transportSource = await Bun.file(new URL("./submit-transport.ts", import.meta.url)).text()

    expect(submitSource).toContain("resolvePreparedSubmitDirectory")
    expect(submitSource).toContain("acquireSubmitSessionTarget")
    expect(submitSource).toContain("finalizeSubmitSessionTarget")
    expect(submitSource).toContain("createSubmitTransportAdapter")
    expect(submitSource).not.toContain("const createCloudWorkspace")
    expect(submitSource).not.toContain("const createLocalWorktree")
    expect(submitSource).not.toContain("const resolveCloudSessionDirectory")
    expect(submitSource).not.toContain("const prepareCloudSessionDirectory")
    expect(submitSource).not.toContain("createTransport(")
    expect(submitSource).not.toContain("createOpencodeClient({")
    expect(submitSource).not.toContain("submitTransportForPlacement")
    expect(submitSource).not.toContain("/config?directory")
    expect(submitSource).not.toContain("resolveSubmitSessionTarget")
    expect(submitSource).not.toContain("createOpencodeSessionWithLifecycle")
    expect(submitSource).not.toContain("createRuntimeSessionTarget")
    expect(submitSource).not.toContain("applyCreatedSessionTargetEffects")
    expect(submitSource).not.toContain("scheduleSessionProjectionPull")
    expect(helperSource).toContain("resolveSubmitSessionTarget")
    expect(helperSource).toContain("createOpencodeSessionWithLifecycle")
    expect(helperSource).toContain("applyCreatedSessionTargetEffects")
    expect(helperSource).toContain("scheduleSessionProjectionPull")
    expect(helperSource).toContain('idempotencyKey: `session-created:')
    expect(directorySource).toContain("resolveSubmitDirectory")
    expect(directorySource).toContain("resolveWorkspaceSubmitPlan")
    expect(directorySource).toContain("prepareWorkspaceRuntime")
    expect(directorySource).toContain("prepareUserHostedRuntime")
    expect(transportSource).toContain("createTransport(")
    expect(transportSource).toContain("createClient")
    expect(transportSource).toContain("submitTransportForPlacement")
    expect(transportSource).toContain("/config")
  })

})
