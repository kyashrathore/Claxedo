// WHAT: The workspace-runtime API is placement-agnostic. The SAME route
//       (/api/wr/health) serves a workspace whether the runtime sits on your
//       loopback ("local") or behind @claxedo/workspace-relay with signed
//       runtime-access tokens ("cloud-vm") — the only thing that changes is
//       the exposure option the runtime is constructed with.
// RUN:  bun run recipe:08-place-anywhere            (Bun — the relay adapter rides Bun.serve)
// NEEDS: bun. Nothing else — both runtimes, the relay, and the keys are created
//        in-process on loopback ports; no LLM, no docker, no network.
// WOW:  one option flips placement: exposure loopback -> relay. Same route, same
//       JSON shape, and the relay-attached runtime PROVES its boundary
//       (routeAuthBoundary: "relay-host-auth") while rejecting direct calls.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateKeyPair } from "jose"
import {
  createWorkspaceRuntimeApp,
  loopbackWorkspaceRuntimeExposure,
  relayWorkspaceRuntimeExposure,
} from "@claxedo/workspace-runtime"
import { createWorkspaceRelayBun, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { banner, printResult, skip, waitForHttp } from "./_shared"

if (typeof Bun === "undefined") {
  skip(
    "this recipe needs Bun (@claxedo/workspace-relay's adapter requires Bun.serve)",
    "bun run recipe:08-place-anywhere",
  )
}

banner({
  recipe: "08-place-anywhere",
  what: "same workspace-runtime API, placement flips local <-> relay-attached with one option",
  wow: "one exposure option moves the workspace behind an authenticated relay — same route, same shape",
})

const cleanups: Array<() => unknown> = []
try {
  // -------------------------------------------------------------------------
  // Placement 1 — LOCAL. A workspace runtime on a loopback port, no auth
  // beyond the loopback boundary itself.
  // -------------------------------------------------------------------------
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cookbook-local-"))
  cleanups.push(() => fs.rm(localDir, { recursive: true, force: true }))
  const local = createWorkspaceRuntimeApp({
    target: { workspaceId: "cookbook-local", directory: localDir },
    storeRoot: path.join(localDir, ".claxedo-runtime-store"),
    exposure: loopbackWorkspaceRuntimeExposure(),
  })
  const localServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: local.app.fetch })
  cleanups.push(() => local.host.dispose(), () => localServer.stop(true))
  const localUrl = String(localServer.url).replace(/\/$/, "")
  await waitForHttp(`${localUrl}/api/wr/health`)

  const localResponse = await fetch(`${localUrl}/api/wr/health`)
  const localHealth = await localResponse.json()
  console.log(`placement: local`)
  console.log(`  GET ${localUrl}/api/wr/health -> ${localResponse.status}`)

  // -------------------------------------------------------------------------
  // Placement 2 — CLOUD-VM (via relay). Two keypairs:
  //  - accessKeys: control plane mints runtime-access tokens (client -> relay)
  //  - hostKeys:   relay signs forwarded requests (relay -> runtime)
  // The runtime differs from placement 1 by ONE option: its exposure is
  // relay(...) instead of loopback().
  // -------------------------------------------------------------------------
  const accessKeys = await generateKeyPair("EdDSA", { extractable: true })
  const hostKeys = await generateKeyPair("EdDSA", { extractable: true })
  const workspaceId = "cookbook-cloud"
  const hostId = "cookbook-host"

  const cloudDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cookbook-cloud-"))
  cleanups.push(() => fs.rm(cloudDir, { recursive: true, force: true }))
  const cloud = createWorkspaceRuntimeApp({
    target: { workspaceId, directory: cloudDir },
    storeRoot: path.join(cloudDir, ".claxedo-runtime-store"),
    exposure: relayWorkspaceRuntimeExposure({ key: hostKeys.publicKey, workspaceId, hostId }),
  })
  const cloudServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: cloud.app.fetch })
  cleanups.push(() => cloud.host.dispose(), () => cloudServer.stop(true))
  const cloudUrl = String(cloudServer.url).replace(/\/$/, "")

  const relay = createWorkspaceRelayBun({
    runtimeAccessKey: accessKeys.publicKey,
    relayHostSigningKey: hostKeys.privateKey,
    relayHostAlgorithm: "EdDSA",
    resolveTarget: (claims) => ({
      workspaceId: claims.workspace_id,
      hostId: claims.host_id,
      baseUrl: cloudUrl,
      access: "cloud",
      backing: "cloud-vm",
    }),
  })
  const relayServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: relay.fetch,
    websocket: relay.websocket,
  })
  cleanups.push(() => relayServer.stop(true))
  const relayUrl = String(relayServer.url).replace(/\/$/, "")
  await waitForHttp(`${relayUrl}/health`)

  // The relay only forwards requests carrying a signed runtime-access token.
  const token = await mintRuntimeAccessToken(
    { subject: "cookbook-user", orgId: "cookbook-org", workspaceId, hostId, role: "editor" },
    accessKeys.privateKey,
    "EdDSA",
  )
  const relayRoute = `${relayUrl}/workspaces/${workspaceId}/api/wr/health`
  const cloudResponse = await fetch(relayRoute, { headers: { authorization: `Bearer ${token}` } })
  const cloudHealth = await cloudResponse.json()
  console.log(`placement: cloud-vm (via relay)`)
  console.log(`  GET ${relayRoute} -> ${cloudResponse.status}`)

  // Boundary proof: the same runtime refuses a direct, un-relayed call —
  // only requests the relay signed (and stamped x-forwarded-by) get through.
  const direct = await fetch(`${cloudUrl}/api/wr/health`)
  await direct.text()
  console.log(`  direct (bypassing relay) GET ${cloudUrl}/api/wr/health -> ${direct.status} (refused)`)

  // -------------------------------------------------------------------------
  // Same route, side by side.
  // -------------------------------------------------------------------------
  printResult("same route, two placements", {
    route: "/api/wr/health",
    local: {
      placement: "local",
      url: `${localUrl}/api/wr/health`,
      status: localResponse.status,
      routeAuthBoundary: localHealth.routeAuthBoundary,
      exposure: localHealth.exposure,
      body: localHealth,
    },
    cloudVm: {
      placement: "cloud-vm (via relay)",
      url: relayRoute,
      status: cloudResponse.status,
      routeAuthBoundary: cloudHealth.routeAuthBoundary,
      exposure: cloudHealth.exposure,
      directBypassStatus: direct.status,
      // x-forwarded-by is stamped by the relay on the FORWARDED request; the
      // runtime's relay-host auth verifies it. Echo it here if the response
      // carried it back, plus the relay's server-timing phases as evidence
      // the hop happened.
      xForwardedBy: cloudResponse.headers.get("x-forwarded-by") ?? "(request-side header; verified by the runtime)",
      relayServerTiming: cloudResponse.headers.get("server-timing"),
      body: cloudHealth,
    },
  })
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // best-effort teardown; never mask the recipe result
    }
  }
}
