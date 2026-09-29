import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import type { HarnessTransport } from "@claxedo/harness/contract"
import { Hono } from "hono"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createRuntimeEventHub, type RuntimeEventHub } from "../projection/runtime-event-hub"
import type { SessionAccessPolicy } from "../session-access-policy"
import { RuntimeStore } from "../store"
import type { RuntimeSnapshot } from "../routes/config"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost, type WorkspaceHostOptions } from "../workspace/runtime"
import { FakeTransport, fakeConnectionProvider, type FakeTransportOptions } from "./fake-transport"
import type { CompatEnvelope } from "../projection/compat-events"

export const FAKE_CONNECTION_ID = "fake"

export type FakeConnection = {
  connectionId: string
  transport: () => HarnessTransport
  capabilities?: HarnessConnectionCapabilities
}

export type FakeWorkspaceAppOptions = {
  auth?: RuntimeSnapshot["auth"]
  /** The script of the default `fake` connection's transport. */
  fakeTransport?: FakeTransportOptions
  /** Replaces the default connection's transport; the factory runs once per composition. */
  transport?: () => HarnessTransport
  /** Connections installed beside `fake`. */
  connections?: FakeConnection[]
  /** The connection every request selects; `fake` unless told otherwise. */
  defaultConnectionId?: string
  sessionAccessPolicy?: SessionAccessPolicy
  workspaceId?: string
  /** Reopens a store an earlier host wrote instead of a fresh one. */
  root?: string
  eventHub?: RuntimeEventHub
  onCompatEvent?: (event: CompatEnvelope) => void
  afterCreateSession?: WorkspaceHostOptions["afterCreateSession"]
  sessionIdWorkspace?: WorkspaceHostOptions["sessionIdWorkspace"]
  /** Middleware installed ahead of the host's routes. */
  before?: (app: Hono) => void
}

export type FakeWorkspaceApp = Awaited<ReturnType<typeof createFakeWorkspaceApp>>

/**
 * One real workspace host over a scripted harness, mounted the way the
 * runtime server mounts it: a loopback exposure, the workspace target on
 * every request and the `fake` connection selected as the default harness.
 */
export async function createFakeWorkspaceApp(options: FakeWorkspaceAppOptions = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "fake-workspace-app-"))
  const directory = join(root, "workspace")
  const workspaceId = options.workspaceId ?? "ws_fake"
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  const transports: HarnessTransport[] = []
  let store: RuntimeStore | undefined
  const connections: FakeConnection[] = [
    {
      connectionId: FAKE_CONNECTION_ID,
      transport: options.transport ?? (() => new FakeTransport(options.fakeTransport)),
    },
    ...(options.connections ?? []),
  ]
  const host = createWorkspaceHost({
    placement: loopbackMachineLoginPolicy(),
    target: { workspaceId, directory },
    storeRoot: join(root, "state"),
    harnessStateRoot: join(root, "harness"),
    eventHub,
    ...(options.sessionAccessPolicy ? { sessionAccessPolicy: options.sessionAccessPolicy } : {}),
    ...(options.onCompatEvent ? { onCompatEvent: options.onCompatEvent } : {}),
    ...(options.afterCreateSession ? { afterCreateSession: options.afterCreateSession } : {}),
    ...(options.sessionIdWorkspace ? { sessionIdWorkspace: options.sessionIdWorkspace } : {}),
    storeFactory: ({ storeRoot }) => {
      store = new RuntimeStore(storeRoot)
      return store
    },
    connectionProviders: connections.map((connection) => fakeConnectionProvider({
      providerKey: connection.connectionId,
      transport: () => {
        const transport = connection.transport()
        transports.push(transport)
        return transport
      },
      ...(connection.capabilities ? { capabilities: connection.capabilities } : {}),
    })),
  })
  const app = new Hono()
  app.use("*", async (_c, next) => withWorkspaceTarget({ workspaceId, directory }, next))
  options.before?.(app)
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  await host.apply({
    version: 4, commands: [],
    mcp: {},
    auth: options.auth ?? { machineOwnerUserId: "local", accounts: {} },
    connections: connections.map((connection) => ({
      connectionId: connection.connectionId, providerKey: connection.connectionId, configRevision: 1, enabled: true, config: {},
    })),
    defaultHarness: { kind: "connection", connectionId: options.defaultConnectionId ?? FAKE_CONNECTION_ID },
  })

  const url = (path: string, params: Record<string, string> = {}) => {
    const target = new URL(`http://localhost${path}`)
    target.searchParams.set("directory", directory)
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    return target.toString()
  }
  const json = (path: string, body: unknown, init: RequestInit & { params?: Record<string, string> } = {}) => {
    const { params, ...rest } = init
    return app.request(url(path, params), {
      method: "POST",
      ...rest,
      headers: { "content-type": "application/json", ...(rest.headers as Record<string, string> | undefined) },
      body: JSON.stringify(body),
    })
  }

  return {
    app,
    host,
    directory,
    root,
    workspaceId,
    eventHub,
    url,
    json,
    /** The store this host opened, once a request or a seed has opened it. */
    store: () => {
      if (!store) throw new Error("The workspace store has not been opened yet")
      return store
    },
    /** Every transport the host composed, in creation order. */
    transports,
    /** The one transport of the default connection, once a session has reached it. */
    transport: () => {
      const [first] = transports
      if (!(first instanceof FakeTransport)) throw new Error("The fake transport has not been composed yet")
      return first
    },
    async createSession(id: string, body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
      const response = await json("/session", { id, ...body }, { params: { connectionId: FAKE_CONNECTION_ID, ...params } })
      if (response.status !== 201) throw new Error(`Session ${id} was not created: ${response.status} ${await response.text()}`)
      return await response.json() as Record<string, unknown>
    },
    async dispose(input: { keepRoot?: boolean } = {}) {
      await host.dispose()
      if (!input.keepRoot) rmSync(root, { recursive: true, force: true })
    },
  }
}
