import { expect, test } from "vitest"
import { DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import { DAEMON_CAPABILITY_HEADER } from "../app/daemon-admission"
import { createDesktopSessionCleanupAccess } from "./desktop-cleanup-grant"

function fixture() {
  let hostOwner: string | undefined
  const sent: Request[] = []
  const access = createDesktopSessionCleanupAccess({ daemonToken: "daemon-secret", protocol: 9,
    hostOwnerActorId: () => hostOwner,
    send: async (url, init) => { sent.push(new Request(url, init)); return Response.json({ candidates: [], incompleteSources: [] }) },
  })
  const capability = { token: "dedicated-cleanup-token", actorId: "owner", orgId: "org", expiresAt: Date.now() + 60_000, origin: "https://cp.test" }
  const install = (value: unknown, headers = { [DAEMON_CAPABILITY_HEADER]: "daemon-secret", [DAEMON_PROTOCOL_HEADER]: "9" }) => access.routes.request("http://daemon.test/", {
    method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ capability: value }),
  })
  return { access, capability, install, sent, hostOwner: (value: string | undefined) => { hostOwner = value } }
}

test("only the current daemon control capability and protocol can install an account grant", async () => {
  const f = fixture()
  expect((await f.install(f.capability, { [DAEMON_CAPABILITY_HEADER]: "runtime-bearer", [DAEMON_PROTOCOL_HEADER]: "9" })).status).toBe(401)
  expect((await f.install(f.capability, { [DAEMON_CAPABILITY_HEADER]: "daemon-secret", [DAEMON_PROTOCOL_HEADER]: "8" })).status).toBe(426)
  expect(f.access.grant.allowed()).toBe(false)
  expect((await f.access.routes.request("http://daemon.test/")).status).toBe(404)
  expect((await f.install({ ...f.capability, origin: "http://outside.test" })).status).toBe(400)
  expect((await f.install({ ...f.capability, expiresAt: Date.now() - 1 })).status).toBe(400)
})

test("a signed account grant reaches cleanup without any serving enrollment and never leaves its route or issuer", async () => {
  const f = fixture()
  const installed = await f.install(f.capability)
  expect(await installed.json()).toEqual({ ok: true, authenticated: true })
  expect(f.access.ownerActorId()).toBe("owner")
  await f.access.grant.fetch("/api/claxedo/session-cleanup?seen=seen")
  expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer dedicated-cleanup-token")
  expect(f.sent[0]?.redirect).toBe("manual")
  await expect(f.access.grant.fetch("https://outside.test/api/claxedo/session-cleanup")).rejects.toThrow("cannot reach")
  await expect(f.access.grant.fetch("/api/claxedo/session-cleanup/grant")).rejects.toThrow("cannot reach")
  expect(f.sent).toHaveLength(1)
})

test("signout and an enrolled owner change revoke account authority without affecting other app instances", async () => {
  const f = fixture()
  const other = fixture()
  await f.install(f.capability)
  expect(other.access.grant.allowed()).toBe(false)
  f.hostOwner("another-owner")
  expect(f.access.grant.allowed()).toBe(false)
  expect((await f.access.grant.fetch("/api/claxedo/session-cleanup")).status).toBe(503)
  f.hostOwner(undefined)
  expect(f.access.grant.allowed()).toBe(true)
  await f.install(null)
  expect(f.access.ownerActorId()).toBeUndefined()
  expect((await f.access.grant.fetch("/api/claxedo/session-cleanup")).status).toBe(503)
  expect(f.sent).toEqual([])
})

test("an explicit signed account issuance failure remains an incomplete source without granting authority", async () => {
  const f = fixture()
  const response = await f.access.routes.request("http://daemon.test/", { method: "PUT", headers: {
    [DAEMON_CAPABILITY_HEADER]: "daemon-secret", [DAEMON_PROTOCOL_HEADER]: "9", "content-type": "application/json",
  }, body: JSON.stringify({ capability: null, unavailable: "Enable Session cleanup for all projects" }) })
  expect(response.status).toBe(200)
  expect(f.access.configured()).toBe(true)
  expect(f.access.grant.allowed()).toBe(false)
  expect(f.access.ownerActorId()).toBeUndefined()
  const unavailable = await f.access.grant.fetch("/api/claxedo/session-cleanup")
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toMatchObject({ error: { message: "Enable Session cleanup for all projects" } })
  expect(f.sent).toEqual([])
  await f.install(null)
  expect(f.access.configured()).toBe(false)
})
