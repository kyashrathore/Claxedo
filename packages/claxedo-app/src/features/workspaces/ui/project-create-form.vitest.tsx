import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import * as codeHostApi from "@/features/onboarding/code-host-api"
import type { CodeHostRequest } from "@/features/onboarding/code-host-api"
import type { ProjectSource } from "../data/project-api"
import { ProjectCreateForm } from "./project-create-form"

const created = vi.hoisted(() => ({
  calls: [] as { baseUrl?: string; source: unknown }[],
  reject: undefined as string | undefined,
}))

vi.mock("@/features/workspaces/data/project-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/workspaces/data/project-api")>()),
  createProject: async (input: { baseUrl?: string; source: unknown }) => {
    created.calls.push(input)
    if (created.reject) throw new Error(created.reject)
    return {
      id: "prj_1",
      name: "demo",
      env: {},
      checkoutDirectory: "/home/me/demo",
      repoUrl: null,
      created_at: 1,
      updated_at: 1,
    }
  },
}))

// The default request is the app's dual-path client; it must never be
// consulted by a test, so the default itself is the tripwire.
vi.mock("@/platform/account/integrations-request", () => ({
  createIntegrationsRequest: () => async () => {
    throw new Error("the default integrations request was used")
  },
}))

// The shell hands the form its code-host client through the workspaces ports;
// the client itself is the real one, only the request behind it is faked.
beforeAll(() => configureAppPortsForTest({ workspaces: codeHostApi }))

const github = (methods: ("key" | "oauth")[]) => ({
  id: "github",
  name: "GitHub",
  methods,
  capabilities: ["code-host"],
  prompts: [{
    id: "token",
    label: "Fine-grained personal access token",
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    secret: true,
  }],
})

const repository = (fullName: string, isPrivate = false) => ({
  id: fullName,
  name: fullName.split("/")[1],
  fullName,
  cloneUrl: `https://github.com/${fullName}.git`,
  private: isPrivate,
  permissions: { read: true, write: true },
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/**
 * A code host that answers the integrations mount the way the server does:
 * the root list, connect, the attempt poll and the repository list. Every
 * request is recorded so a test can say what was and was not asked.
 */
function fakeCodeHost(options: {
  methods?: ("key" | "oauth")[]
  connected?: boolean
  repositories?: ReturnType<typeof repository>[]
  root?: Response
  pendingPolls?: number
}) {
  const requests: { path: string; method: string; body?: unknown }[] = []
  let connected = options.connected ?? false
  let polls = 0
  const request: CodeHostRequest = async (path, init) => {
    const method = (init?.method ?? "GET").toUpperCase()
    requests.push({ path, method, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) })
    if (path === "") {
      if (options.root) return options.root
      return json({
        integrations: [github(options.methods ?? ["key"])],
        connections: connected
          ? [{ id: "conn-1", integrationId: "github", accountLabel: "me", status: "connected" }]
          : [],
      })
    }
    if (path === "/github/connect" && method === "POST") {
      if ((options.methods ?? ["key"]).includes("oauth")) {
        return json({ url: "https://github.com/login/device", attemptId: "attempt-1", userCode: "WDJB-MJHT", intervalMs: 1 })
      }
      connected = true
      return json({ ok: true })
    }
    if (path === "/attempts/attempt-1") {
      polls += 1
      if (polls <= (options.pendingPolls ?? 0)) return json({ status: "pending" })
      connected = true
      return json({ status: "complete" })
    }
    if (path === "/connections/conn-1/repositories") {
      return json({ repositories: options.repositories ?? [] })
    }
    return json({ code: "not_found" }, 404)
  }
  return { request, requests }
}

const renderForm = (props: Partial<Parameters<typeof ProjectCreateForm>[0]> = {}) => {
  const onCreated = vi.fn()
  const result = render(() => (
    <ProjectCreateForm baseUrl="http://server.test" localExecution={false} onCreated={onCreated} {...(props as object)} />
  ))
  return { ...result, onCreated }
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create project" }))

afterEach(() => {
  created.calls = []
  created.reject = undefined
  cleanup()
})

describe("folder source", () => {
  test("a chosen folder is posted as its source and nothing else", async () => {
    const host = fakeCodeHost({})
    const { onCreated } = renderForm({
      localExecution: true,
      pickFolder: async () => "/home/me/demo",
      codeHost: host.request,
    })

    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }))
    await waitFor(() => expect(screen.getByText("/home/me/demo")).toBeTruthy())

    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(created.calls).toEqual([
      { baseUrl: "http://server.test", source: { kind: "directory", folder: "/home/me/demo" } },
    ])
    expect(host.requests).toEqual([])
  })

  test("the create button waits for a folder", () => {
    renderForm({ localExecution: true, pickFolder: async () => undefined, codeHost: fakeCodeHost({}).request })

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create project" }).disabled).toBe(true)
  })

  test("the code host is read on the first switch to a repository and survives every later switch", async () => {
    const host = fakeCodeHost({ connected: true, repositories: [repository("me/app")] })
    renderForm({ localExecution: true, pickFolder: async () => undefined, codeHost: host.request })

    fireEvent.click(screen.getByRole("button", { name: "Clone a repository instead" }))
    fireEvent.click(screen.getByRole("button", { name: "Select a folder instead" }))
    for (let round = 0; round < 3; round++) {
      fireEvent.click(screen.getByRole("button", { name: "Clone a repository instead" }))
      await waitFor(() => expect(screen.getByText("me/app")).toBeTruthy())
      fireEvent.click(screen.getByRole("button", { name: "Select a folder instead" }))
      fireEvent.click(screen.getByRole("button", { name: "Clone a repository instead" }))
      expect(screen.queryByText("Checking connected accounts…")).toBeNull()
      expect(screen.getByText("me/app")).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Select a folder instead" }))
    }

    expect(host.requests.filter((request) => request.path === "")).toHaveLength(1)
    expect(host.requests.filter((request) => request.path === "/connections/conn-1/repositories")).toHaveLength(1)
  })
})

describe("repository from the connected code host", () => {
  test("the list is searched by full name and the chosen row posts the connection source", async () => {
    const host = fakeCodeHost({
      connected: true,
      repositories: [repository("me/zebra"), repository("me/apple", true), repository("team/apple-docs")],
    })
    const { onCreated } = renderForm({ codeHost: host.request })

    const search = await screen.findByRole("searchbox", { name: "Search repositories" })
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(3))
    // The server's order (the host's "recently updated") is kept, not the alphabet's.
    expect(screen.getAllByRole("radio").map((row) => row.textContent)).toEqual([
      "me/zebra",
      "me/appleprivate",
      "team/apple-docs",
    ])

    fireEvent.input(search, { target: { value: "APPLE" } })
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2))
    expect(screen.queryByRole("radio", { name: /zebra/ })).toBeNull()

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create project" }).disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: /me\/apple/ }))
    expect(screen.getByRole("radio", { name: /me\/apple/ }).getAttribute("aria-checked")).toBe("true")

    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(created.calls).toEqual([
      {
        baseUrl: "http://server.test",
        source: { kind: "repository", connectionId: "conn-1", repo: { fullName: "me/apple" } },
      },
    ])
    expect(host.requests.map((item) => item.path)).toEqual(["", "/connections/conn-1/repositories"])
  })

  test("the URL link swaps to the URL field, which posts the repository URL", async () => {
    const host = fakeCodeHost({ connected: true, repositories: [repository("me/zebra")] })
    const { onCreated } = renderForm({ codeHost: host.request })

    await screen.findByRole("searchbox", { name: "Search repositories" })
    fireEvent.click(screen.getByText("Paste a URL instead"))

    expect(screen.queryByRole("searchbox", { name: "Search repositories" })).toBeNull()
    fireEvent.input(screen.getByRole("textbox", { name: "Repository URL" }), {
      target: { value: " https://example.com/owner/repo.git " },
    })
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(created.calls).toEqual([
      { baseUrl: "http://server.test", source: { kind: "repository", repoUrl: "https://example.com/owner/repo.git" } },
    ])

    fireEvent.click(screen.getByText("Choose from GitHub"))
    await screen.findByRole("searchbox", { name: "Search repositories" })
    expect(host.requests.filter((item) => item.path.endsWith("/repositories"))).toHaveLength(1)
  })

  test("a refused list says why and leaves the URL path open", async () => {
    const host = fakeCodeHost({ connected: true })
    host.requests.length = 0
    const refusing: CodeHostRequest = (path, init) =>
      path === "/connections/conn-1/repositories"
        ? Promise.resolve(json({ code: "repository_listing_unsupported" }, 501))
        : host.request(path, init)
    renderForm({ codeHost: refusing })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("can't list repositories")
    expect(screen.getByText("Paste a URL instead")).toBeTruthy()
  })
})

describe("no connection yet", () => {
  test("a key-only host asks for the token inline and the list follows the connect", async () => {
    const host = fakeCodeHost({ methods: ["key"], repositories: [repository("me/zebra")] })
    renderForm({ codeHost: host.request })

    const token = await screen.findByLabelText("Fine-grained personal access token")
    expect(screen.queryByRole("searchbox", { name: "Search repositories" })).toBeNull()
    const connect = screen.getByRole("button", { name: "Connect with token" }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    expect(screen.getByRole<HTMLAnchorElement>("link", { name: "Create a token on GitHub" }).href)
      .toBe("https://github.com/settings/personal-access-tokens/new")

    fireEvent.input(token, { target: { value: "github_pat_abc" } })
    fireEvent.click(connect)

    await screen.findByRole("searchbox", { name: "Search repositories" })
    await waitFor(() => expect(screen.getByRole("radio", { name: /me\/zebra/ })).toBeTruthy())
    expect(host.requests.find((item) => item.path === "/github/connect")?.body).toEqual({
      fields: {},
      secret: "github_pat_abc",
    })
  })

  test("a device grant shows the code and the page, then polls the attempt until it completes", async () => {
    const host = fakeCodeHost({ methods: ["oauth"], pendingPolls: 2, repositories: [repository("me/zebra")] })
    renderForm({ codeHost: host.request })

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }))

    await waitFor(() => expect(screen.getByText("WDJB-MJHT")).toBeTruthy())
    expect(screen.getByRole<HTMLAnchorElement>("link").href).toBe("https://github.com/login/device")

    await screen.findByRole("searchbox", { name: "Search repositories" })
    expect(host.requests.filter((item) => item.path === "/attempts/attempt-1")).toHaveLength(3)
  })

  test("a rejected token is a sentence on the form, with the URL path still offered", async () => {
    const host = fakeCodeHost({ methods: ["key"] })
    const rejecting: CodeHostRequest = (path, init) =>
      path === "/github/connect" ? Promise.resolve(json({ code: "verify_failed" }, 400)) : host.request(path, init)
    renderForm({ codeHost: rejecting })

    fireEvent.input(await screen.findByLabelText("Fine-grained personal access token"), {
      target: { value: "bad" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Connect with token" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("token was rejected")
    expect(screen.getByText("Paste a URL instead")).toBeTruthy()
  })
})

describe("a server without a code host", () => {
  test("a status read that fails shows the URL field with the reason", async () => {
    const host = fakeCodeHost({ root: json({ code: "route_not_found" }, 404) })
    const { onCreated } = renderForm({ codeHost: host.request })

    const url = await screen.findByRole("textbox", { name: "Repository URL" })
    expect(screen.getByText(/offers no code host/)).toBeTruthy()
    expect(screen.queryByText("Paste a URL instead")).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull()

    fireEvent.input(url, { target: { value: "https://github.com/owner/repo" } })
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(created.calls[0].source).toEqual({ kind: "repository", repoUrl: "https://github.com/owner/repo" })
  })

  test("a status request that never reaches the server settles on the URL field", async () => {
    const refused: CodeHostRequest = async () => {
      throw new TypeError("Failed to fetch")
    }
    const { onCreated } = renderForm({ codeHost: refused })

    const url = await screen.findByRole("textbox", { name: "Repository URL" })
    expect(screen.queryByText("Checking connected accounts…")).toBeNull()

    fireEvent.input(url, { target: { value: "https://github.com/owner/repo" } })
    submit()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(created.calls[0].source).toEqual({ kind: "repository", repoUrl: "https://github.com/owner/repo" })
  })

  test("a refused create is the server's message, and the form stays", async () => {
    created.reject = '{"message":"a project already uses that folder"}'
    const host = fakeCodeHost({ root: json({}, 404) })
    const { onCreated } = renderForm({ codeHost: host.request })

    fireEvent.input(await screen.findByRole("textbox", { name: "Repository URL" }), {
      target: { value: "https://github.com/owner/repo" },
    })
    submit()

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("a project already uses that folder"))
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe("a host that holds the choice", () => {
  test("onSubmit receives the source and nothing is posted", async () => {
    const host = fakeCodeHost({ connected: true, repositories: [repository("me/zebra")] })
    const received: ProjectSource[] = []
    render(() => (
      <ProjectCreateForm
        localExecution={false}
        codeHost={host.request}
        onSubmit={(source) => {
          received.push(source)
        }}
      />
    ))

    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull()
    fireEvent.click(await screen.findByRole("radio", { name: /me\/zebra/ }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(received).toEqual([
      { kind: "repository", connectionId: "conn-1", repo: { fullName: "me/zebra" } },
    ]))
    expect(created.calls).toEqual([])
  })

  test("the host names its own button", async () => {
    render(() => (
      <ProjectCreateForm localExecution={false} codeHost={fakeCodeHost({}).request} onSubmit={() => {}} submitLabel="Next" />
    ))

    expect(await screen.findByRole("button", { name: "Next" })).toBeTruthy()
  })
})

describe("the leading control", () => {
  test("is the folder button where there is a folder, and the search field where the list is the screen", async () => {
    const lead: HTMLElement[] = []
    renderForm({ localExecution: true, pickFolder: async () => undefined, codeHost: fakeCodeHost({}).request, leadField: (element) => lead.push(element) })
    expect(lead.at(-1)).toBe(screen.getByRole("button", { name: "Choose folder" }))
    cleanup()

    lead.length = 0
    renderForm({ codeHost: fakeCodeHost({ connected: true }).request, leadField: (element) => lead.push(element) })
    const search = await screen.findByRole("searchbox", { name: "Search repositories" })
    expect(lead.at(-1)).toBe(search)
  })
})
