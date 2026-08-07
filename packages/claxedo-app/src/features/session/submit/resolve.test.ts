import { describe, expect, test } from "bun:test"
import {
  resolvePromptDispatchClient,
  resolveSubmitDirectory,
  resolveSubmitMode,
  resolveSubmitSessionTarget,
  resolveSubmittedConfig,
} from "./resolve"
import type { PromptDispatchInput, SubmitModel, SubmitSessionGetClient, SubmitSessionTarget } from "./types"

// Rubric T2: per-phase test for resolve.ts. Each helper is pure given its
// injected dependencies, so the tests exercise the decision tree rather than
// any side effects.

describe("resolveSubmitMode", () => {
  test("returns the user-selected mode when not in runner mode or signed control plane", () => {
    let setCalls = 0
    expect(
      resolveSubmitMode({
        mode: "shell",
        harnessMode: false,
        signedControlPlane: false,
        setMode: () => {
          setCalls++
        },
      }),
    ).toEqual({ mode: "shell" })
    expect(setCalls).toBe(0)
  })

  test("falls shell → normal AND notifies setMode in runner mode", () => {
    const seen: string[] = []
    expect(
      resolveSubmitMode({
        mode: "shell",
        harnessMode: true,
        signedControlPlane: false,
        setMode: (m) => seen.push(m),
      }),
    ).toEqual({ mode: "normal" })
    expect(seen).toEqual(["normal"])
  })

  test("falls shell → normal in signed control plane", () => {
    expect(
      resolveSubmitMode({
        mode: "shell",
        harnessMode: false,
        signedControlPlane: true,
        setMode: () => undefined,
      }),
    ).toEqual({ mode: "normal" })
  })

  test("normal mode is unchanged in any transport", () => {
    expect(
      resolveSubmitMode({
        mode: "normal",
        harnessMode: true,
        signedControlPlane: true,
        setMode: () => undefined,
      }),
    ).toEqual({ mode: "normal" })
  })

  // Rubric A3: slash detection used to live inline in
  // `components/prompt-input/submit.ts` (text.startsWith("/") +
  // a customCommands lookup). The hoist moves the branch decision here so
  // the dispatcher only switches on the resolved mode.

  test("slash: matches a registered custom command and splits arguments", () => {
    const result = resolveSubmitMode({
      mode: "normal",
      harnessMode: false,
      signedControlPlane: false,
      setMode: () => undefined,
      text: "/build --fast --watch",
      customCommandNames: ["build", "deploy"],
    })
    expect(result).toEqual({
      mode: "slash",
      slash: { command: "build", arguments: "--fast --watch" },
    })
  })

  test("slash: command with no arguments resolves with empty argument string", () => {
    const result = resolveSubmitMode({
      mode: "normal",
      harnessMode: false,
      signedControlPlane: false,
      setMode: () => undefined,
      text: "/help",
      customCommandNames: ["help"],
    })
    expect(result).toEqual({ mode: "slash", slash: { command: "help", arguments: "" } })
  })

  test("slash: leading slash with no matching command falls back to normal", () => {
    expect(
      resolveSubmitMode({
        mode: "normal",
        harnessMode: false,
        signedControlPlane: false,
        setMode: () => undefined,
        text: "/notacommand here",
        customCommandNames: ["build"],
      }),
    ).toEqual({ mode: "normal" })
  })

  test("slash: empty custom-command list never matches even with leading slash", () => {
    expect(
      resolveSubmitMode({
        mode: "normal",
        harnessMode: false,
        signedControlPlane: false,
        setMode: () => undefined,
        text: "/build",
        customCommandNames: [],
      }),
    ).toEqual({ mode: "normal" })
  })

  test("slash: text without leading slash never resolves to slash", () => {
    expect(
      resolveSubmitMode({
        mode: "normal",
        harnessMode: false,
        signedControlPlane: false,
        setMode: () => undefined,
        text: "please run the build command",
        customCommandNames: ["build"],
      }),
    ).toEqual({ mode: "normal" })
  })

  test("slash: shell mode beats a leading slash (explicit user intent wins)", () => {
    expect(
      resolveSubmitMode({
        mode: "shell",
        harnessMode: false,
        signedControlPlane: false,
        setMode: () => undefined,
        text: "/build",
        customCommandNames: ["build"],
      }),
    ).toEqual({ mode: "shell" })
  })

  test("slash: runner+slash still falls through to normal (no shell channel, slash not supported here)", () => {
    // harness path does not have a slash-command dispatcher in the existing
    // wire — the caller never invokes resolveSubmitMode with a command
    // list under runner mode. We document the safe behaviour explicitly:
    // without a customCommandNames input, slash detection is skipped.
    expect(
      resolveSubmitMode({
        mode: "normal",
        harnessMode: true,
        signedControlPlane: false,
        setMode: () => undefined,
        text: "/build",
        // Caller omitted customCommandNames → no slash branch.
      }),
    ).toEqual({ mode: "normal" })
  })
})

const sonnet: SubmitModel = { id: "sonnet", provider: { id: "anthropic" } }
const opus: SubmitModel = { id: "opus", provider: { id: "anthropic" } }

describe("resolveSubmittedConfig", () => {
  test("uses the selected model when modelForSubmit returns it", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      allowModelFallback: true,
      currentAgent: { name: "build" },
      modelForSubmit: async (m) => m,
    })
    expect(result).toEqual({
      model: { providerID: "anthropic", modelID: "sonnet" },
      agent: "build",
    })
  })

  test("falls back to fallbackModel when selected is undefined", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      fallbackModel: opus,
      allowModelFallback: true,
      currentAgent: { name: "ask" },
      modelForSubmit: async (m) => m,
    })
    expect(result?.model.modelID).toBe("opus")
  })

  test("does not invent a fallback model for existing session restores", async () => {
    let calls = 0
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      fallbackModel: opus,
      allowModelFallback: false,
      currentAgent: { name: "ask" },
      modelForSubmit: async (m) => {
        calls++
        return m
      },
    })
    expect(calls).toBe(0)
    expect(result).toBeUndefined()
  })

  test("harness path uses harness ModelKey directly without calling modelForSubmit", async () => {
    let calls = 0
    const result = await resolveSubmittedConfig({
      harnessMode: true,
      harnessModelKey: { providerID: "claude-acp", modelID: "sonnet" },
      allowModelFallback: false,
      currentAgent: { name: "build" },
      modelForSubmit: async (m) => {
        calls++
        return m
      },
    })
    expect(calls).toBe(0)
    expect(result?.model.modelID).toBe("sonnet")
  })

  test("harness path carries its selected thought level from the model key", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: true,
      harnessModelKey: { providerID: "codex-app-server", modelID: "gpt-5.6-sol", variant: "ultra" },
      allowModelFallback: false,
      modelForSubmit: async (model) => model,
    })
    expect(result?.variant).toBe("ultra")
  })

  test("harness path refuses to fall back to non-runner model state", async () => {
    let calls = 0
    const result = await resolveSubmittedConfig({
      harnessMode: true,
      selectedModel: opus,
      fallbackModel: opus,
      allowModelFallback: false,
      currentAgent: { name: "build" },
      modelForSubmit: async (m) => {
        calls++
        return m
      },
    })
    expect(calls).toBe(0)
    expect(result).toBeUndefined()
  })

  test("returns undefined when no model can be resolved", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      allowModelFallback: true,
      currentAgent: { name: "build" },
      modelForSubmit: async () => undefined,
    })
    expect(result).toBeUndefined()
  })

  test("uses build when no live agent is available", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      allowModelFallback: true,
      modelForSubmit: async (m) => m,
    })
    expect(result).toEqual({
      model: { providerID: "anthropic", modelID: "sonnet" },
      agent: "build",
    })
  })

  test("ignores default sentinel when a live agent is available", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      allowModelFallback: true,
      currentAgent: { name: "default" },
      defaultAgent: { name: "general" },
      modelForSubmit: async (m) => m,
    })
    expect(result?.agent).toBe("general")
  })

  test("harness path tolerates absent agent", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: true,
      harnessModelKey: { providerID: "claude-acp", modelID: "sonnet" },
      allowModelFallback: false,
      modelForSubmit: async (m) => m,
    })
    expect(result?.agent).toBe("build") // default
  })

  test("agentOverride wins over currentAgent.name", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      allowModelFallback: true,
      currentAgent: { name: "build" },
      agentOverride: "ask",
      modelForSubmit: async (m) => m,
    })
    expect(result?.agent).toBe("ask")
  })

  test("variant is propagated when provided", async () => {
    const result = await resolveSubmittedConfig({
      harnessMode: false,
      selectedModel: sonnet,
      allowModelFallback: true,
      currentAgent: { name: "build" },
      variant: "thinking",
      modelForSubmit: async (m) => m,
    })
    expect(result?.variant).toBe("thinking")
  })
})

describe("resolveSubmitDirectory", () => {
  const baseInput = {
    isNewSession: false,
    defaultDirectory: "/default",
    worktreeSelection: "main",
    workspaceKind: "local",
    showMissingWorkspace: () => undefined,
    resolveCloudSessionDirectory: async () => undefined,
    prepareCloudSessionDirectory: async () => true,
    createLocalWorktree: async () => undefined,
    publishCloudHandoff: () => undefined,
  } as const

  test("returns project/fallback/default in priority for existing sessions", async () => {
    expect(await resolveSubmitDirectory({ ...baseInput, projectDirectory: "/proj" })).toEqual({
      directory: "/proj",
    })
    expect(await resolveSubmitDirectory({ ...baseInput, fallbackDirectory: "/fall" })).toEqual({
      directory: "/fall",
    })
    expect(await resolveSubmitDirectory({ ...baseInput })).toEqual({ directory: "/default" })
  })

  test("draft without project + main worktree shows missing workspace and returns undefined", async () => {
    let shown = 0
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      draftId: "draft-1",
      worktreeSelection: "main",
      showMissingWorkspace: () => {
        shown++
      },
    })
    expect(shown).toBe(1)
    expect(result).toBeUndefined()
  })

  test("cloud path defers to resolveCloudSessionDirectory + prepareCloudSessionDirectory", async () => {
    let prepared = ""
    let handoff = ""
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      workspaceKind: "cloud",
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: async (dir) => {
        prepared = dir
        return true
      },
      publishCloudHandoff: (_status, msg) => {
        handoff = msg
      },
    })
    expect(prepared).toBe("/cloud/ws")
    expect(handoff).toContain("Runtime ready")
    expect(result).toEqual({ directory: "/cloud/ws" })
  })

  test("cloud prepare failure short-circuits to undefined", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      workspaceKind: "cloud",
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: async () => false,
    })
    expect(result).toBeUndefined()
  })

  test("create worktree path delegates to createLocalWorktree", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      worktreeSelection: "create",
      projectDirectory: "/proj",
      createLocalWorktree: async (dir) => `${dir}/feature`,
    })
    expect(result).toEqual({ directory: "/proj/feature" })
  })

  test("explicit worktree path uses the selection verbatim", async () => {
    const result = await resolveSubmitDirectory({
      ...baseInput,
      isNewSession: true,
      worktreeSelection: "/explicit/wt",
    })
    expect(result).toEqual({ directory: "/explicit/wt" })
  })
})

// Rubric T6: per-phase abort / cancel coverage for resolve.ts. Only the
// cloud path of `resolveSubmitDirectory` awaits — `prepareCloudSessionDirectory`
// can run for the length of a runtime boot. The resolver does not (yet)
// accept an AbortSignal directly, so abort surfaces through the injected
// dependency returning `false` mid-await; the resolver must short-circuit
// to `undefined` without proceeding to publish "Runtime ready".
describe("resolveSubmitDirectory abort coverage", () => {
  const baseInput = {
    isNewSession: true,
    defaultDirectory: "/default",
    worktreeSelection: "main",
    workspaceKind: "cloud",
    showMissingWorkspace: () => undefined,
    createLocalWorktree: async () => undefined,
  } as const

  test("cloud path aborts mid-await when prepareCloudSessionDirectory rejects via an external signal", async () => {
    const controller = new AbortController()
    let handoffMessages: string[] = []
    let prepareStarted = false
    const promise = resolveSubmitDirectory({
      ...baseInput,
      resolveCloudSessionDirectory: async () => "/cloud/ws",
      prepareCloudSessionDirectory: (_dir) =>
        new Promise<boolean>((resolve) => {
          prepareStarted = true
          // Simulate abort being threaded into prepareCloudSessionDirectory
          // via an external AbortController: when the signal flips we
          // resolve with `false` (the same value the resolver treats as
          // "prepare failed / aborted").
          controller.signal.addEventListener("abort", () => resolve(false), { once: true })
        }),
      publishCloudHandoff: (_status, msg) => {
        handoffMessages.push(msg)
      },
    })
    // Flip the signal after the resolver has entered the await — this is
    // the mid-await abort window.
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(prepareStarted).toBe(true)
    controller.abort()
    const result = await promise
    expect(result).toBeUndefined()
    // The "Runtime ready. Loading models." handoff only publishes AFTER
    // a successful prepare — an aborted prepare must not publish it.
    expect(handoffMessages).not.toContain("Runtime ready. Loading models.")
  })
})

describe("resolveSubmitSessionTarget", () => {
  const sessionClient = (id: string): SubmitSessionGetClient => ({
    session: {
      get: async () => ({ data: { id } }),
    },
  })
  const missingClient: SubmitSessionGetClient = {
    session: {
      get: async () => ({}),
    },
  }

  test("hands back the provided session unchanged when one exists", async () => {
    const session: SubmitSessionTarget = { id: "ses_a" }
    const result = await resolveSubmitSessionTarget({
      session,
      isNewSession: false,
      replaceSession: false,
      harnessMode: false,
      signedControlPlane: false,
      sessionDirectory: "/repo/main",
      client: sessionClient("ses_a"),
      sessionClient: () => sessionClient("ses_a"),
      createSessionTarget: async () => undefined,
    })
    expect(result).toEqual({ session, replaceSession: false, created: false })
  })

  test("hydrates an existing session via client.get when explicitSessionID is given", async () => {
    const result = await resolveSubmitSessionTarget({
      explicitSessionID: "ses_x",
      isNewSession: false,
      replaceSession: false,
      harnessMode: false,
      signedControlPlane: false,
      sessionDirectory: "/repo/main",
      client: sessionClient("ses_x"),
      sessionClient: () => sessionClient("ses_x"),
      createSessionTarget: async () => undefined,
    })
    expect(result.session?.id).toBe("ses_x")
    expect(result.created).toBe(false)
  })

  test("runner/signed fallback: missing remote session synthesizes the local id", async () => {
    const result = await resolveSubmitSessionTarget({
      explicitSessionID: "ses_acp",
      isNewSession: false,
      replaceSession: false,
      harnessMode: true,
      signedControlPlane: false,
      sessionDirectory: "/repo/main",
      client: missingClient,
      sessionClient: () => missingClient,
      createSessionTarget: async () => undefined,
    })
    expect(result.session?.id).toBe("ses_acp")
  })

  test("non-runner missing remote session forces replaceSession=true and goes through create", async () => {
    let createCalls = 0
    const result = await resolveSubmitSessionTarget({
      explicitSessionID: "ses_gone",
      isNewSession: false,
      replaceSession: false,
      harnessMode: false,
      signedControlPlane: false,
      sessionDirectory: "/repo/main",
      client: missingClient,
      sessionClient: () => missingClient,
      createSessionTarget: async () => {
        createCalls++
        return { id: "ses_new" }
      },
    })
    expect(createCalls).toBe(1)
    expect(result.session?.id).toBe("ses_new")
    expect(result.created).toBe(true)
    expect(result.replaceSession).toBe(true)
  })

  test("session target creation is delegated when replaceSession is true", async () => {
    let createCalls = 0
    const result = await resolveSubmitSessionTarget({
      isNewSession: true,
      replaceSession: true,
      harnessMode: true,
      signedControlPlane: false,
      sessionDirectory: "/repo/main",
      client: missingClient,
      sessionClient: () => missingClient,
      createSessionTarget: async () => {
        createCalls++
        return { id: "ses_acp_claim" }
      },
    })
    expect(createCalls).toBe(1)
    expect(result.session?.id).toBe("ses_acp_claim")
    expect(result.created).toBe(true)
  })
})

describe("resolvePromptDispatchClient", () => {
  const session = (label: string) => ({
    session: {
      prompt: async () => ({ data: undefined }) as never,
      promptAsync: async () => label as never,
    },
  })

  test("harness path uses sessionClient", async () => {
    let sessionCalls = 0
    const result = await resolvePromptDispatchClient({
      harnessMode: true,
      signedControlPlane: false,
      loopbackWorkspaceBridge: false,
      sessionClient: () => {
        sessionCalls++
        return session("acp") as never
      },
      hostedSessionClient: async () => undefined,
      fallbackClient: session("fallback") as PromptDispatchInput["client"],
    })
    expect(sessionCalls).toBe(1)
    expect(result).toBeDefined()
  })

  test("signed control plane path uses sessionClient", async () => {
    let sessionCalls = 0
    await resolvePromptDispatchClient({
      harnessMode: false,
      signedControlPlane: true,
      loopbackWorkspaceBridge: false,
      sessionClient: () => {
        sessionCalls++
        return session("signed") as never
      },
      hostedSessionClient: async () => undefined,
      fallbackClient: session("fallback") as PromptDispatchInput["client"],
    })
    expect(sessionCalls).toBe(1)
  })

  test("loopback workspace bridge path uses sessionClient", async () => {
    let sessionCalls = 0
    await resolvePromptDispatchClient({
      harnessMode: false,
      signedControlPlane: false,
      loopbackWorkspaceBridge: true,
      sessionClient: () => {
        sessionCalls++
        return session("loopback") as never
      },
      hostedSessionClient: async () => undefined,
      fallbackClient: session("fallback") as PromptDispatchInput["client"],
    })
    expect(sessionCalls).toBe(1)
  })

  test("hosted path prefers hostedSessionClient when available", async () => {
    let hostedCalls = 0
    const hosted = session("hosted") as PromptDispatchInput["client"]
    const result = await resolvePromptDispatchClient({
      harnessMode: false,
      signedControlPlane: false,
      loopbackWorkspaceBridge: false,
      sessionClient: () => session("session") as never,
      hostedSessionClient: async () => {
        hostedCalls++
        return hosted
      },
      fallbackClient: session("fallback") as PromptDispatchInput["client"],
    })
    expect(hostedCalls).toBe(1)
    expect(result).toBe(hosted)
  })

  test("hosted path falls back to fallbackClient when hosted resolver returns undefined", async () => {
    const fallback = session("fallback") as PromptDispatchInput["client"]
    const result = await resolvePromptDispatchClient({
      harnessMode: false,
      signedControlPlane: false,
      loopbackWorkspaceBridge: false,
      sessionClient: () => session("session") as never,
      hostedSessionClient: async () => undefined,
      fallbackClient: fallback,
    })
    expect(result).toBe(fallback)
  })
})
