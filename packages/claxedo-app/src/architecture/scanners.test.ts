import { describe, expect, test } from "bun:test"
import { metricCounts, metrics, type SourceFile } from "./scanners"

describe("architecture scanners", () => {
  test("counts core regex metrics and drops test files through caller-provided filtering", () => {
    const counts = metricCounts([
      source(
        "core.ts",
        `
        type Input = { directory: string }
        shouldUseSignedControlPlaneAccess(input)
        isWorkspaceIdRef(value)
        isFilesystemDirectory(value)
        isLoopbackHttpUrl(value)
        value.startsWith("/") || /^[A-Za-z]:/.test(value)
        if (kind === "user-hosted") return
        legacyDirectoryRouteKey(directory)
        auth.isSignedIn()
        setInterval(work, 1000)
        const x = value as any
        queryClient.setQueryData(key, value)
        import("@opencode-ai/session-ui/context")
        `,
      ),
      source("sdk.ts", `import { Opencode } from "@opencode-ai/sdk"`),
    ])

    expect(counts.directoryStringParams).toBe(1)
    expect(counts.signedControlPlaneAccess).toBe(1)
    expect(counts.isWorkspaceIdRef).toBe(1)
    expect(counts.isFilesystemDirectory).toBe(1)
    expect(counts.isLoopbackHttpUrl).toBe(1)
    expect(counts.filesystemShapeRegexClones).toBe(1)
    expect(counts.userHostedComparisons).toBe(1)
    expect(counts.legacyDirectoryRouteKeyRefs).toBe(1)
    expect(counts.isSignedInGates).toBe(1)
    expect(counts.timerDrivenDataPolls).toBe(1)
    expect(counts.asAnyCasts).toBe(1)
    expect(counts.setQueryDataCalls).toBe(1)
    expect(counts.deepSessionUiImports).toBe(1)
    expect(counts.sdkImportingFiles).toBe(1)
  })

  test("does not count near-miss package names as SDK imports", () => {
    expect(scan("sdkImportingFiles", `import { x } from "@opencode-ai/sdk-next"`)).toHaveLength(0)
  })

  test("allows isSignedIn only inside the auth boundary", () => {
    expect(metrics.find((item) => item.name === "isSignedInGates")!.scan([
      source("shell/auth/auth-session.ts", `auth.isSignedIn()`),
      source("utils/auth-client.ts", `isSignedIn: () => true`),
      source("app.tsx", `auth.isSignedIn()`),
    ])).toEqual([{
      file: "app.tsx",
      line: 1,
      match: "isSignedIn(",
    }])
  })

  test("allows deep session-ui imports only in the session-client barrel", () => {
    const metric = metrics.find((item) => item.name === "deepSessionUiImports")!

    expect(metric.scan([
      source("session-client/index.ts", `export * from "@opencode-ai/session-ui/context"`),
      source("components/file.tsx", `import { File } from "@opencode-ai/session-ui/file"`),
    ])).toEqual([
      {
        file: "components/file.tsx",
        line: 1,
        match: `import { File } from "@opencode-ai/session-ui/file"`,
      },
    ])
  })

  test("detects Solid effect writes without matching read-only effects or memos", () => {
    expect(scan("effectStateWrites", `createEffect(() => setFoo(value()))`)).toHaveLength(1)
    expect(scan("effectStateWrites", `createEffect(() => value())`)).toHaveLength(0)
    expect(scan("effectStateWrites", `createMemo(() => setFoo(value()))`)).toHaveLength(0)
  })

  test("detects top-level mutable state but not function-local state", () => {
    expect(scan("moduleScopeMutableState", `const cache = new Map<string, string>()`)).toHaveLength(1)
    expect(scan("moduleScopeMutableState", `export const [value, setValue] = createSignal(false)`)).toHaveLength(1)
    expect(scan("moduleScopeMutableState", `function make() {\n  const cache = new Map()\n}`)).toHaveLength(0)
  })

  test("detects suppression flags and untrack calls separately", () => {
    expect(scan("suppressionFlags", `const suppressNextWrite = true; const skipNextHydrate = true`)).toHaveLength(2)
    expect(scan("suppressionFlags", `fastSwitchRestoreDeferred()`)).toHaveLength(1)
    expect(scan("untrackCalls", `untrack(() => value())`)).toHaveLength(1)
  })

  test("detects props destructuring but allows accessor-preserving reads", () => {
    expect(scan("propsDestructuring", `const { data } = props`)).toHaveLength(1)
    expect(scan("propsDestructuring", `const data = () => props.data`)).toHaveLength(0)
  })

  test("detects query-mirror effects", () => {
    expect(scan("queryMirrorEffects", `createEffect(() => {\n  setThing(query.data)\n})`)).toHaveLength(1)
    expect(scan("queryMirrorEffects", `createEffect(() => query.data)`)).toHaveLength(0)
    expect(scan("queryMirrorEffects", `createEffect(() => setThing(value()))`)).toHaveLength(0)
  })

  test("detects timer-driven data polls and allows named timer exceptions", () => {
    const metric = metrics.find((item) => item.name === "timerDrivenDataPolls")
    if (!metric) throw new Error("missing timerDrivenDataPolls metric")

    expect(metric.scan([
      source("demo/handlers.ts", "setInterval(work, 1000)"),
      source("app.tsx", "const retry = () => {\n  props.onRetry?.()\n  timer = setTimeout(retry, 1000)\n}\ntimer = setTimeout(retry, 1000)"),
      source("session/store/session-controller.ts", "const schedule = (delay: number) => {\n  timeout = timers.setTimeout(() => {\n    input.refresh()\n    schedule(5000)\n  }, delay)\n}"),
      source("components/live.tsx", "setInterval(work, 1000)"),
    ])).toEqual([
      {
        file: "app.tsx",
        line: 1,
        match: "self-rearming setTimeout(retry) data poll",
      },
      {
        file: "session/store/session-controller.ts",
        line: 1,
        match: "self-rearming setTimeout(schedule) data poll",
      },
      {
        file: "components/live.tsx",
        line: 1,
        match: "setInterval(",
      },
    ])
  })

  test("allows raw conversation hydration only in the owner and transport hydrator", () => {
    const metric = metrics.find((item) => item.name === "conversationHydrationEntrypoints")
    if (!metric) throw new Error("missing conversationHydrationEntrypoints metric")

    expect(metric.scan([
      source("shell/chat/conversation-hydrator.ts", "hydrateRegisteredConversationSnapshot(input)"),
      source("shell/chat/session-conversation-owner.tsx", "hydrateRegisteredConversationSnapshot(input)"),
      source("shell/chat/conversation-registry.ts", "export function hydrateRegisteredConversationSnapshot() {}"),
      source("session/store/session-controller.ts", "hydrateRegisteredConversationSnapshot(input)"),
    ])).toEqual([{
      file: "session/store/session-controller.ts",
      line: 1,
      match: "hydrateRegisteredConversationSnapshot",
    }])
  })

  test("tracks RuntimeGateway references outside the transport boundary", () => {
    const metric = metrics.find((item) => item.name === "runtimeGatewayOutsideTransport")
    if (!metric) throw new Error("missing runtimeGatewayOutsideTransport metric")

    expect(metric.scan([
      source("shell/data/transport/transport.ts", "RuntimeGateway.workspaceRuntimeFetch(input)"),
      source("context/sdk.tsx", "RuntimeGateway.workspaceRuntimeFetch(input)"),
    ])).toEqual([{
      file: "context/sdk.tsx",
      line: 1,
      match: "RuntimeGateway.",
    }])
  })
})

function scan(name: string, text: string) {
  const metric = metrics.find((item) => item.name === name)
  if (!metric) throw new Error(`missing metric ${name}`)
  return metric.scan([source("fixture.tsx", text)])
}

function source(path: string, text: string): SourceFile {
  return { path, text }
}
