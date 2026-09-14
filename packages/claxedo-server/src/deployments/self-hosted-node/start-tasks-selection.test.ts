/**
 * Which Tasks composition a self-hosted box mounts.
 *
 * Asserted through the mounted ROUTES rather than by identity of the returned
 * object: the two compositions differ in who they admit, and "the signed one
 * was selected" is only worth checking because a caller with no bearer must
 * then be refused. A selector that returned the loopback composition for a
 * signed box would pass an identity check written against the wrong module and
 * still hand every remote member one shared preset catalog.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { betterAuthAdapter, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { mountControlPlaneRouteContributions } from "@claxedo/server-core/platform/http/route-contribution"
import type { ControlPlaneServices } from "../../authority/services"
import { selfHostedTasksRouteContributions } from "./start"

const TASKS = "/api/claxedo/tasks"
const LOOPBACK = "http://127.0.0.1:4096"

let dataDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-tasks-selection-"))
  for (const key of ["CLAXEDO_DATA_DIR", "CLAXEDO_DEPLOYMENT_MODE"]) {
    saved[key] = process.env[key]
  }
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
})

afterEach(() => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true })
})

function baseServices() {
  return {
    authority: {
      resolveOrgId: vi.fn(async () => "org-1"),
      authorizeProject: vi.fn(async () => ({ ok: true, role: "admin", orgId: "org-1" })),
      authorizeSessionRead: vi.fn(async () => undefined),
    },
    telemetry: { capture: vi.fn() },
    relay: {},
    sandbox: {},
    localExecution: { enabled: true },
  }
}

/** The posture `createDefaultLocalControlPlaneServices` composes with CLAXEDO_EMBEDDED_AUTH on. */
function signedServices(): ControlPlaneServices {
  return {
    ...baseServices(),
    auth: betterAuthAdapter({
      issuer: "claxedo-embedded",
      verifier: async (token) =>
        token === "alice" ? { subject: "alice", tokenIdentifier: "session:alice", issuer: "claxedo-embedded" } : null,
    }),
  } as unknown as ControlPlaneServices
}

/** The single-user posture: no embedded issuer, so no signed identity to read. */
function unsignedServices(): ControlPlaneServices {
  return { ...baseServices(), auth: localOnlyAuthAdapter() } as unknown as ControlPlaneServices
}

async function mounted(services: ControlPlaneServices) {
  const contributions = await selfHostedTasksRouteContributions(services)
  const bare = new Hono()
  mountControlPlaneRouteContributions({
    contributions,
    mount: (contribution) => bare.route(contribution.path, contribution.routes),
  })
  return { contributions, request: (init?: RequestInit) => bare.request(`${LOOPBACK}${TASKS}/capabilities`, init) }
}

describe("self-hosted Tasks selection", () => {
  test("a signed box mounts the composition that requires a bearer", async () => {
    const app = await mounted(signedServices())

    expect(app.contributions.map((contribution) => contribution.id)).toEqual(["claxedo-tasks"])
    // Loopback is deliberately the origin: the loopback composition would
    // answer 200 here, so a 401 is the property that separates the two.
    expect((await app.request()).status).toBe(401)
    expect((await app.request({ headers: { authorization: "Bearer alice" } })).status).toBe(200)
  })

  test("an unsigned box mounts the composition that admits loopback", async () => {
    const app = await mounted(unsignedServices())

    expect(app.contributions.map((contribution) => contribution.id)).toEqual(["claxedo-tasks"])
    expect((await app.request()).status).toBe(200)
  })
})
