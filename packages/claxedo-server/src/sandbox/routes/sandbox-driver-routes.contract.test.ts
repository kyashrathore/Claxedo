import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { sandboxDriverRoutes } from "./sandbox-driver-routes"
import { listSandboxDrivers } from "@claxedo/sandbox-manager/driver-catalog"
import {
  WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH,
  WORKSPACE_SANDBOX_DRIVERS_PATH,
  workspaceSandboxDriverAuthPath,
} from "../../../../claxedo-app/src/platform/runtime/agent/workspace-control-paths"

// Sandbox-driver client/server route contract.
//
// The settings UI once called `/api/workspace/providers` while the server only
// ever served `/api/workspace/drivers` — every request 404'd, and the whole
// screen was dead. Nothing caught it because every test on both sides was
// mock-only: the app tests asserted the URL STRINGS the client builds, and the
// Playwright spec intercepted `**/api/workspace/providers**` and answered it
// itself. A mock always agrees with whoever wrote it, so a server-side rename
// is invisible to it by construction.
//
// This file is the one place that holds the real client paths and the real
// server router at the same time, so drift on EITHER side fails here:
//   - rename a server route  -> Hono stops matching -> 404 -> red
//   - rename a client path   -> the constant changes -> 404 -> red
//   - rename a response key  -> the shape assertion below -> red
//
// Importing app source from a server test follows the same rules as
// `doorbell-event-contract.test.ts`: `runtime-contract.test.ts` scans
// production source only (it skips `*.test.*`), so the import edge is legal,
// and `workspace-control-paths.ts` is import-free so it needs no `@/` alias
// resolution and adds no runtime edge. Keep that module import-free.

// `server.ts` mounts `WorkspaceRoutes` — which mounts `sandboxDriverRoutes` at
// its own root — under this prefix. Asserted against the real source below so
// the prefix half of the contract cannot drift either.
const MOUNT_PREFIX = "/api/workspace"

// `/drivers/:id/auth` writes real credentials on a real driver id, so this file
// only ever probes it with an id the catalog rejects. `isSandboxDriverID` fails
// first and the handler 400s before it reaches `putCredential` or
// `saveUserConfig` — the route still had to MATCH to return 400, which is the
// whole contract. A contract test must never store a secret.
const UNROUTABLE_DRIVER_ID = "contract-test-not-a-driver"

// Belt-and-braces: `dataDir()` reads this at call time, so even an unexpected
// write lands in a temp dir instead of the developer's ~/.claxedo.
let previousDataDir: string | undefined
let tempDataDir: string

beforeAll(() => {
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-driver-contract-"))
  process.env.CLAXEDO_DATA_DIR = tempDataDir
})

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  // Close the sqlite handles the routes opened under the temp data dir:
  // Windows refuses to delete a directory holding an open database file, and
  // keeps a brief lock even after close (the retries absorb it).
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  ClaxedoDB.close()
  fs.rmSync(tempDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function mountedSandboxDriverApp() {
  return new Hono().route(MOUNT_PREFIX, sandboxDriverRoutes())
}

function serverSource(relative: string) {
  return fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8")
}

describe("sandbox driver client/server route contract", () => {
  test("server.ts still mounts the workspace routes under the prefix the client encodes", () => {
    expect(serverSource("../../deployments/self-hosted-node/app.ts")).toContain(`app.route("${MOUNT_PREFIX}", WorkspaceRoutes(`)
    // `sandboxDriverRoutes` is mounted at the WorkspaceRoutes root, so the
    // driver paths sit directly under MOUNT_PREFIX with no extra segment.
    expect(serverSource("../../workspace/routes/index.ts")).toContain('.route("/", sandboxDriverRoutes(')
  })

  test.each([
    ["GET", WORKSPACE_SANDBOX_DRIVERS_PATH],
    ["PUT", WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH],
    ["PUT", workspaceSandboxDriverAuthPath(UNROUTABLE_DRIVER_ID)],
    ["DELETE", workspaceSandboxDriverAuthPath(UNROUTABLE_DRIVER_ID)],
  ])("%s %s is served by the real router", async (method, clientPath) => {
    const response = await mountedSandboxDriverApp().request(clientPath, {
      method,
      ...(method === "GET" || method === "DELETE"
        ? {}
        : { headers: { "content-type": "application/json" }, body: "{}" }),
    })

    // 404 is the ONLY status that means "no route answers this path". Anything
    // else (200, 400 on an unsupported driver id, 403 on a signed-mode
    // mutation) means the client path reached a real handler, which is exactly
    // what this contract pins. Asserting a specific success status here would
    // couple the test to auth/config state instead.
    expect(response.status, `${method} ${clientPath} is not served`).not.toBe(404)
  })

  test("a path the client does not build is genuinely unrouted", async () => {
    // Guards the assertion above from becoming vacuous: if the router ever
    // started answering everything, `not.toBe(404)` would pass for free.
    const response = await mountedSandboxDriverApp().request("/api/workspace/providers")
    expect(response.status).toBe(404)
  })

  test("the driver list response uses the keys the client destructures", () => {
    // `sandbox-section.tsx` reads `data.drivers` / `data.default_driver`, and
    // renders `item.fields` for the credential form. This is the same catalog
    // function the GET handler returns, so a key rename fails here.
    const body = listSandboxDrivers({}, {})

    expect(Object.keys(body).sort()).toEqual(["default_driver", "drivers"])
    expect(typeof body.default_driver).toBe("string")
    expect(body.drivers.length).toBeGreaterThan(0)

    for (const driver of body.drivers) {
      expect(Object.keys(driver).sort()).toEqual([
        "configured",
        "default",
        "fields",
        "id",
        "label",
        "source",
      ])
    }
  })

  test("the default-driver mutation reads the body key the client sends", async () => {
    // `sandbox-section.tsx` PUTs `{ driver }`. The server's `defaultBody` parses
    // `driver`; the old client sent `{ provider }`, which parsed to undefined
    // and 400'd `sandbox_driver_unsupported` even once the path was correct.
    const response = await mountedSandboxDriverApp().request(WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "daytona" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "sandbox_driver_unsupported" },
    })
  })
})
