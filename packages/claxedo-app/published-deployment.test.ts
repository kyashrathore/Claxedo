import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { publishDeployment, readPublishedDeployment } from "./published-deployment"
import { PUBLISHED_DEPLOYMENT_ELEMENT_ID, publishedDeployment } from "./src/server/published-deployment"

const API = "https://api.claxedo.test"
const HOSTED = { healthy: true, version: "1.0.0", events: { hostAggregate: false }, deployment: { serverKind: "hosted", issuesSessions: true, capabilities: ["documents"], connections: true } }

function descriptor(expiresAt = Date.now() + 60_000) {
  return { adapter: "better-auth", deploymentId: "staging", configurationVersion: "v1", expiresAt, issuer: `${API}/api/auth`, methods: ["github"], native: { cli: { clientId: "</script><script>alert(1)</script>" } } }
}

function server(bootstrap: unknown, authDescriptor: unknown, reads: string[] = []) {
  return async (url: string) => {
    reads.push(url)
    if (url === `${API}/api/claxedo/bootstrap`) return Response.json(bootstrap)
    if (url === `${API}/api/claxedo/auth/descriptor`) return Response.json(authDescriptor)
    return new Response(null, { status: 404 })
  }
}

function documentOf(html: string) {
  const match = new RegExp(`<script id="${PUBLISHED_DEPLOYMENT_ELEMENT_ID}" type="application/json">([^<]*)</script>`).exec(html)
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: (id: string) => (id === PUBLISHED_DEPLOYMENT_ELEMENT_ID && match ? { textContent: match[1] } : null) },
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document")
})

describe("readPublishedDeployment", () => {
  test("reads the bootstrap and the auth descriptor from the API that serves them", async () => {
    const reads: string[] = []
    const authDescriptor = descriptor()
    expect(await readPublishedDeployment(API, server(HOSTED, authDescriptor, reads))).toEqual({ server: API, bootstrap: HOSTED, authDescriptor })
    expect(reads.sort()).toEqual([`${API}/api/claxedo/auth/descriptor`, `${API}/api/claxedo/bootstrap`])
  })

  test("refuses a daemon's bootstrap, which lists one machine's projects", async () => {
    const daemon = { deployment: { serverKind: "daemon", issuesSessions: false }, host: { name: "ada" }, project: [] }
    await expect(readPublishedDeployment(API, server(daemon, descriptor()))).rejects.toThrow("not a hosted deployment's bootstrap")
  })

  test("refuses an expired descriptor and a failed read", async () => {
    await expect(readPublishedDeployment(API, server(HOSTED, descriptor(Date.now() - 1)))).rejects.toThrow("expired descriptor")
    await expect(readPublishedDeployment(API, async () => new Response(null, { status: 503 }))).rejects.toThrow("HTTP 503")
  })

  test("names the API by its origin alone", async () => {
    await expect(readPublishedDeployment(`${API}/`, server(HOSTED, descriptor()))).rejects.toThrow("is not an origin")
  })
})

describe("publishDeployment", () => {
  test("writes the deployment into the built shell, where the app reads it back for that server only", async () => {
    const shell = await readFile(new URL("./index.html", import.meta.url), "utf8")
    const deployment = { server: API, bootstrap: HOSTED, authDescriptor: descriptor() }
    const html = publishDeployment(shell, deployment)
    expect(html).not.toContain("</script><script>alert(1)")
    documentOf(html)
    expect(publishedDeployment(API)).toEqual(deployment)
    expect(publishedDeployment("https://other.claxedo.test")).toBeUndefined()
  })

  test("replaces a deployment published earlier instead of adding a second", () => {
    const first = publishDeployment("<html><head></head></html>", { server: API, bootstrap: HOSTED, authDescriptor: descriptor(1) })
    const second = publishDeployment(first, { server: API, bootstrap: HOSTED, authDescriptor: descriptor(2) })
    expect(second.split(PUBLISHED_DEPLOYMENT_ELEMENT_ID)).toHaveLength(2)
    documentOf(second)
    expect(publishedDeployment(API)?.authDescriptor).toMatchObject({ expiresAt: 2 })
  })
})
