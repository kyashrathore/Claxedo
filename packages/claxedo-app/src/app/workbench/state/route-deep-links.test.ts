import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  collectSessionDeepLinks,
  createDeepLinkProjectOpener,
  deepLinkConfirmCopy,
  deepLinkDirectory,
  deepLinkProjectRegistered,
  type DeepLinkOpenRequest,
  type DeepLinkProject,
  deepLinkEvent,
  drainPendingDeepLinks,
  newSessionDeepLinkRoute,
  parseDeepLink,
  parseNewSessionDeepLink,
  parseSessionDeepLink,
  sessionDeepLink,
} from "./route-deep-links"

type Effect =
  | { kind: "confirm"; request: DeepLinkOpenRequest }
  | { kind: "ensure"; directory: string }
  | { kind: "open"; directory: string }
  | { kind: "navigate"; route: string }

function harness(input: {
  local?: boolean
  projects?: DeepLinkProject[]
  confirm?: boolean | "pending"
  ensured?: DeepLinkProject[]
}) {
  const effects: Effect[] = []
  let decide: ((accepted: boolean) => void) | undefined
  const opener = createDeepLinkProjectOpener({
    local: () => input.local ?? true,
    projects: () => input.projects ?? [],
    confirm: (request) => {
      effects.push({ kind: "confirm", request })
      if (input.confirm === "pending") return new Promise<boolean>((resolve) => (decide = resolve))
      return Promise.resolve(input.confirm ?? true)
    },
    ensure: async (directory) => {
      effects.push({ kind: "ensure", directory })
      return input.ensured
    },
    open: (directory) => effects.push({ kind: "open", directory }),
    navigate: (route) => effects.push({ kind: "navigate", route }),
  })
  return { effects, handle: opener, decide: (accepted: boolean) => decide?.(accepted) }
}

const registered: DeepLinkProject[] = [{ id: "ws_main", worktree: "/repo/main" }]

describe("deepLinkDirectory", () => {
  test("keeps an absolute path, collapsed lexically", () => {
    expect(deepLinkDirectory("/repo/main")).toBe("/repo/main")
    expect(deepLinkDirectory(" /repo/main/ ")).toBe("/repo/main")
    expect(deepLinkDirectory("/repo/main/../other/./x//y")).toBe("/repo/other/x/y")
    expect(deepLinkDirectory("/../../etc")).toBe("/etc")
    expect(deepLinkDirectory("/")).toBe("/")
    expect(deepLinkDirectory("C:\\repo\\..\\x/y\\")).toBe("C:\\x\\y")
    expect(deepLinkDirectory("c:/")).toBe("c:\\")
  })

  test("refuses anything the server would resolve against its own cwd", () => {
    expect(deepLinkDirectory("repo/main")).toBeUndefined()
    expect(deepLinkDirectory("./repo")).toBeUndefined()
    expect(deepLinkDirectory("../repo")).toBeUndefined()
    expect(deepLinkDirectory("~/repo")).toBeUndefined()
    expect(deepLinkDirectory("")).toBeUndefined()
    expect(deepLinkDirectory("   ")).toBeUndefined()
    expect(deepLinkDirectory("\\\\server\\share")).toBeUndefined()
    expect(deepLinkDirectory("//server/share")).toBeUndefined()
    expect(deepLinkDirectory("C:repo")).toBeUndefined()
  })
})

describe("deepLinkProjectRegistered", () => {
  test("answers from project worktrees, sandboxes and workspace directories only", () => {
    const projects: DeepLinkProject[] = [
      { worktree: "/repo/main", sandboxes: ["/repo/main-sandbox"], workspaces: { "/repo/main-ws": { directory: "/repo/main-ws" } } },
      { worktree: "/repo/keyed", workspaces: { "/repo/keyed-ws": {} } },
    ]
    expect(deepLinkProjectRegistered(projects, "/repo/main")).toBe(true)
    expect(deepLinkProjectRegistered(projects, "/repo/main-sandbox")).toBe(true)
    expect(deepLinkProjectRegistered(projects, "/repo/main-ws")).toBe(true)
    expect(deepLinkProjectRegistered(projects, "/repo/keyed-ws")).toBe(true)
    expect(deepLinkProjectRegistered(projects, "/repo/main/sub")).toBe(false)
    expect(deepLinkProjectRegistered(projects, "/repo")).toBe(false)
    expect(deepLinkProjectRegistered([], "/repo/main")).toBe(false)
  })
})

describe("deepLinkConfirmCopy", () => {
  const t = (key: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce((text, [name, value]) => `${text} ${name}=${value}`, key)

  test("prints the directory, and the prompt only when the link carries one", () => {
    expect(deepLinkConfirmCopy({ directory: "/repo/new" }, t)).toEqual({
      title: "dialog.deeplink.open.title",
      body: "dialog.deeplink.open.body directory=/repo/new",
      confirmLabel: "dialog.deeplink.open.confirm",
    })
    expect(deepLinkConfirmCopy({ directory: "/repo/new", prompt: "ship it" }, t).body).toBe(
      "dialog.deeplink.open.body directory=/repo/new\n\ndialog.deeplink.open.prompt prompt=ship it",
    )
  })
})

describe("deep-link project opener", () => {
  test("an unregistered directory registers nothing until the user accepts", async () => {
    const h = harness({ confirm: "pending", ensured: [{ id: "ws_new", worktree: "/repo/new" }] })
    const done = h.handle(["claxedo://open-project?directory=/repo/new"])
    await Promise.resolve()
    expect(h.effects).toEqual([{ kind: "confirm", request: { directory: "/repo/new" } }])

    h.decide(true)
    await done
    expect(h.effects).toEqual([
      { kind: "confirm", request: { directory: "/repo/new" } },
      { kind: "ensure", directory: "/repo/new" },
      { kind: "open", directory: "/repo/new" },
      { kind: "navigate", route: "/w/ws_new" },
    ])
  })

  test("cancel registers nothing, opens nothing, navigates nowhere", async () => {
    const h = harness({ confirm: false, ensured: [{ id: "ws_new", worktree: "/repo/new" }] })
    await h.handle([
      "claxedo://open-project?directory=/repo/new",
      "claxedo://new-session?directory=/repo/new&prompt=ship",
      "claxedo://open-session?directory=/repo/new&session=ses_1",
    ])
    expect(h.effects.map((effect) => effect.kind)).toEqual(["confirm", "confirm", "confirm"])
  })

  test("the confirmation shows the collapsed absolute directory and the prompt text", async () => {
    const h = harness({ confirm: false })
    await h.handle(["claxedo://new-session?directory=%2Frepo%2Fmain%2F..%2Fnew%2F&prompt=%20ship%20it%20"])
    expect(h.effects).toEqual([{ kind: "confirm", request: { directory: "/repo/new", prompt: "ship it" } }])
  })

  test("an accepted new-session link lands the prompt in the route query, never in a send", async () => {
    const h = harness({ ensured: [{ id: "ws_new", worktree: "/repo/new" }] })
    await h.handle(["claxedo://new-session?directory=/repo/new&prompt=ship%20it"])
    expect(h.effects).toEqual([
      { kind: "confirm", request: { directory: "/repo/new", prompt: "ship it" } },
      { kind: "ensure", directory: "/repo/new" },
      { kind: "open", directory: "/repo/new" },
      { kind: "navigate", route: "/w/ws_new/session?prompt=ship%20it" },
    ])
  })

  test("a registered project opens without a confirmation", async () => {
    const h = harness({ projects: registered, confirm: false })
    await h.handle([
      "claxedo://open-project?directory=/repo/main",
      "claxedo://new-session?directory=/repo/main&prompt=ship",
      "claxedo://open-session?directory=/repo/main&session=ses_1",
    ])
    expect(h.effects).toEqual([
      { kind: "ensure", directory: "/repo/main" },
      { kind: "open", directory: "/repo/main" },
      { kind: "navigate", route: "/w/ws_main" },
      { kind: "ensure", directory: "/repo/main" },
      { kind: "open", directory: "/repo/main" },
      { kind: "navigate", route: "/w/ws_main/session?prompt=ship" },
      { kind: "ensure", directory: "/repo/main" },
      { kind: "open", directory: "/repo/main" },
      { kind: "navigate", route: "/s/ses_1" },
    ])
  })

  test("a registered directory named with a trailing slash is still registered", async () => {
    const h = harness({ projects: registered, confirm: false })
    await h.handle(["claxedo://open-project?directory=/repo/main/"])
    expect(h.effects.map((effect) => effect.kind)).toEqual(["ensure", "open", "navigate"])
  })

  test("a session link without a directory routes straight to the session", async () => {
    const h = harness({ confirm: false })
    await h.handle(["claxedo://open-session?session=ses_1"])
    expect(h.effects).toEqual([{ kind: "navigate", route: "/s/ses_1" }])
  })

  test("a relative directory is dropped before anyone is asked", async () => {
    const h = harness({})
    await h.handle([
      "claxedo://open-project?directory=repo/main",
      "claxedo://new-session?directory=../secrets&prompt=ship",
      "claxedo://open-session?directory=~/repo&session=ses_1",
    ])
    expect(h.effects).toEqual([])
  })

  test("a server that does not run on this machine ignores every link", async () => {
    const h = harness({ local: false })
    await h.handle(["claxedo://open-project?directory=/repo/new"])
    expect(h.effects).toEqual([])
  })

  test("a second link to the directory the first one just created asks nothing", async () => {
    const effects: Effect[] = []
    let projects: DeepLinkProject[] = []
    const handle = createDeepLinkProjectOpener({
      local: () => true,
      projects: () => projects,
      confirm: (request) => {
        effects.push({ kind: "confirm", request })
        return Promise.resolve(true)
      },
      ensure: async (directory) => {
        effects.push({ kind: "ensure", directory })
        projects = [{ id: "ws_new", worktree: directory }]
        return projects
      },
      open: (directory) => effects.push({ kind: "open", directory }),
      navigate: (route) => effects.push({ kind: "navigate", route }),
    })

    await handle([
      "claxedo://open-project?directory=/repo/new",
      "claxedo://new-session?directory=/repo/new&prompt=ship",
    ])
    expect(effects.filter((effect) => effect.kind === "confirm")).toEqual([
      { kind: "confirm", request: { directory: "/repo/new" } },
    ])
    expect(effects.at(-1)).toEqual({ kind: "navigate", route: "/w/ws_new/session?prompt=ship" })
  })

  test("acceptance without a workspace id afterwards opens nothing", async () => {
    const h = harness({ ensured: undefined })
    await h.handle(["claxedo://open-project?directory=/repo/new"])
    expect(h.effects).toEqual([
      { kind: "confirm", request: { directory: "/repo/new" } },
      { kind: "ensure", directory: "/repo/new" },
    ])
  })
})

describe("deep link urls", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("claxedo://open-project?directory=/repo/main")).toBe("/repo/main")
    expect(parseDeepLink("claxedo://new-session?directory=/repo/main")).toBeUndefined()
    expect(collectOpenProjectDeepLinks([
      "https://example.com",
      "claxedo://open-project?directory=/repo/main",
      "claxedo://open-project",
    ])).toEqual(["/repo/main"])
  })

  test("parses new-session deep links with optional prompt payloads", () => {
    expect(parseNewSessionDeepLink("claxedo://new-session?directory=/repo/main")).toEqual({
      directory: "/repo/main",
    })
    expect(parseNewSessionDeepLink("claxedo://new-session?directory=/repo/main&prompt=hello")).toEqual({
      directory: "/repo/main",
      prompt: "hello",
    })
    expect(collectNewSessionDeepLinks([
      "claxedo://open-project?directory=/repo/main",
      "claxedo://new-session?directory=/repo/next&prompt=ship",
    ])).toEqual([{ directory: "/repo/next", prompt: "ship" }])
  })

  test("round-trips a session's on-disk location through open-session deep links", () => {
    const link = sessionDeepLink({
      workspaceDirectory: "/repo/main",
      sessionId: "ses_1",
      store: "/home/me/.claxedo/opencode-runtime/opencode.db",
    })
    expect(link).toBe(
      "claxedo://open-session?directory=%2Frepo%2Fmain&store=%2Fhome%2Fme%2F.claxedo%2Fopencode-runtime%2Fopencode.db&session=ses_1",
    )
    expect(parseSessionDeepLink(link)).toEqual({
      sessionId: "ses_1",
      workspaceDirectory: "/repo/main",
      store: "/home/me/.claxedo/opencode-runtime/opencode.db",
    })
    // A bare `session` param still opens the session; the rest is provenance.
    expect(parseSessionDeepLink("claxedo://open-session?session=ses_1"))
      .toEqual({ sessionId: "ses_1", workspaceDirectory: undefined, store: undefined })
    expect(collectSessionDeepLinks([
      "https://example.com",
      link,
      "claxedo://open-session?directory=/repo/main",
      "claxedo://open-project?directory=/repo/main",
    ])).toEqual([{ sessionId: "ses_1", workspaceDirectory: "/repo/main", store: "/home/me/.claxedo/opencode-runtime/opencode.db" }])
  })

  test("carries new-session prompt text in the routed workspace URL", () => {
    const routeFor = (directory: string) => `/w/${encodeURIComponent(directory)}/session`

    expect(newSessionDeepLinkRoute({ directory: "/repo/main" }, "ws_1", routeFor)).toBe("/w/ws_1/session")
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "  ship it  " }, "ws_1", routeFor)).toBe(
      "/w/ws_1/session?prompt=ship%20it",
    )
    expect(newSessionDeepLinkRoute({ directory: "/repo/main", prompt: "line one\nline two & more" }, "ws_1", routeFor)).toBe(
      "/w/ws_1/session?prompt=line%20one%0Aline%20two%20%26%20more",
    )
  })

  test("drains pending window deep links exactly once", () => {
    const target = {
      __CLAXEDO__: {
        deepLinks: ["claxedo://open-project?directory=/repo/main"],
      },
    } as Window & { __CLAXEDO__: { deepLinks: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["claxedo://open-project?directory=/repo/main"])
    expect(target.__CLAXEDO__.deepLinks).toEqual([])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })

  test("keeps the desktop event name stable", () => {
    expect(deepLinkEvent).toBe("claxedo:deep-link")
  })
})
