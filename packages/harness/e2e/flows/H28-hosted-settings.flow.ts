import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { assistantText } from "../harness/api"
import { SCRIPTED_ACP_HARNESS, scriptedAcpConnection } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { acpScriptToken, writeAcpScript } from "../harness/acp/script"
import { hostedFetch } from "../harness/hosted-auth"
import { hostedApi, hostedOwner, hostedWorkspace } from "../harness/hosted-flow"
import { HOSTED_PLUGIN_NAME, HOSTED_PLUGIN_REPOSITORY } from "../harness/hosted-scripted-github"
import { HOSTED_MCP_AUTHORIZATION_CODE, HOSTED_MCP_UPSTREAM_TOKEN, hostedMcpCallsFile, type HostedMcpUpstreamCall } from "../harness/hosted-scripted-mcp"
import { HOSTED_MCP_GATEWAY_ORIGIN } from "../harness/hosted-sandbox-worker"
import { startHostedStack } from "../harness/hosted-stack"
import { frameSessionId, frameType, openEventStream } from "../harness/stream"

type Catalog = {
  revision: number
  harnessTargets: Array<{ id: string }>
  candidates: Array<{
    pluginInstanceId: string
    manifest: { name: string } | null
    mcpServers: Array<{ name: string; type: string; authentication: { state: string; integrationId?: string }; cloud: { state: string; reason?: string } }>
  }>
}

type McpEntry = { name: string; type?: string; url?: string; headers?: Array<{ name: string; value: string }> }

async function json<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function upstreamCalls(root: string): Promise<HostedMcpUpstreamCall[]> {
  try {
    return (await fs.readFile(hostedMcpCallsFile(root), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as HostedMcpUpstreamCall)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function filesMentioning(root: string, needle: string) {
  const hits: string[] = []
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".sock")) continue
    const file = path.join(entry.parentPath, entry.name)
    if (file.includes("/node_modules/") || file.includes("/.git/")) continue
    try {
      if ((await fs.readFile(file, "utf8")).includes(needle)) hits.push(file)
    } catch {
      continue
    }
  }
  return hits
}

function bearerClaims(authorization: string | undefined): { iss?: unknown; aud?: unknown } {
  const payload = /^Bearer [^.]+\.([^.]+)\.[^.]+$/.exec(authorization ?? "")?.[1]
  return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: unknown; aud?: unknown } : {}
}

function assertOwnServer(servers: McpEntry[], session: string): McpEntry {
  const own = servers.filter((server) => server.name === "claxedo")
  assert.equal(own.length, 1, `the consented project's sandbox carries Claxedo's own MCP server once in ${session}: ${JSON.stringify(servers.map((server) => server.name))}`)
  const [server] = own
  assert.ok(server.url?.startsWith("http://127.0.0.1:") && server.url.includes("/api/claxedo/mcp?session="),
    `Claxedo's own MCP server in ${session} is not the sandbox runtime's loopback endpoint: ${server.url}`)
  const claims = bearerClaims(server.headers?.find((header) => header.name === "Authorization")?.value)
  assert.deepEqual({ iss: claims.iss, aud: claims.aud }, { iss: "claxedo-workspace-runtime", aud: "claxedo-mcp" },
    `Claxedo's own MCP server in ${session} carries a credential other than the sandbox runtime's own`)
  return server
}

export async function run() {
  const stack = await startHostedStack("h28-plugins")
  try {
    const owner = await hostedOwner(stack)
    const jsonHeaders = { "content-type": "application/json" }
    const registered = await json<{ plugins: number }>(await hostedFetch(stack, "/api/claxedo/plugins/sources", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(HOSTED_PLUGIN_REPOSITORY),
    }, owner), "H28 source registration")
    assert.equal(registered.plugins, 1)
    const catalog = await json<Catalog>(await hostedFetch(stack, "/api/claxedo/plugins", {}, owner), "H28 catalog")
    assert.ok(catalog.harnessTargets.some((target) => target.id === "acp"), "the hosted catalog offers custom ACP agents as a plugin target")
    const candidate = catalog.candidates.find((row) => row.manifest?.name === HOSTED_PLUGIN_NAME)
    assert.ok(candidate, `C-8: the registered plugin is not in the hosted catalog: ${JSON.stringify(catalog.candidates.map((row) => row.pluginInstanceId))}`)
    const local = candidate.mcpServers.find((server) => server.name === "local")
    assert.deepEqual(local?.cloud, { state: "unavailable", reason: "mcp_command_not_in_image" },
      `C-8: a local command the image lacks is not reported with its reason: ${JSON.stringify(candidate.mcpServers)}`)
    const scripted = candidate.mcpServers.find((server) => server.name === "scripted")
    assert.equal(scripted?.cloud.state, "gateway")
    assert.equal(scripted?.authentication.state, "oauth", `C-8: the HTTP server needs its OAuth connection: ${JSON.stringify(scripted)}`)
    const integrationId = scripted.authentication.integrationId!

    const activated = await json<{ revision: number; reconciliation: { state: string } }>(await hostedFetch(stack, "/api/claxedo/plugins/activation", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["acp"], choice: true, expectedRevision: catalog.revision, target: { scope: "all-projects" } }),
    }, owner), "H28 activation")
    assert.equal(activated.reconciliation.state, "applied")

    const connect = await json<{ ok: boolean; url: string }>(await hostedFetch(stack, `/api/claxedo/integrations/${encodeURIComponent(integrationId)}/connect`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ method: "oauth", scope: "personal" }),
    }, owner), "H28 OAuth connect")
    const authorize = new URL(connect.url)
    assert.equal(authorize.origin, "https://auth.hosted-e2e.test")
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
    callback.searchParams.set("code", HOSTED_MCP_AUTHORIZATION_CODE)
    const completed = await hostedFetch(stack, callback.toString(), {}, owner)
    assert.equal(completed.status, 200, `H28 OAuth callback: ${await completed.text()}`)
    const connections = await json<{ connections: Array<{ integrationId: string }> }>(await hostedFetch(stack, "/api/claxedo/integrations", {}, owner), "H28 connections")
    assert.ok(connections.connections.some((row) => row.integrationId === integrationId), "the MCP server's OAuth connection is stored")
    assert.ok((await upstreamCalls(stack.root)).some((call) => call.kind === "token" && call.code === HOSTED_MCP_AUTHORIZATION_CODE), "the control plane exchanged the code upstream")

    const scriptDir = path.join(stack.root, "acp-scripts")
    await writeAcpScript(scriptDir, "h28-proof", { steps: [{ kind: "mcp", marker: "H28HOSTED" }] })
    await writeAcpScript(scriptDir, "h28-after", { steps: [{ kind: "text", text: "H28 after change" }] })
    const configured = await hostedFetch(stack, `/api/claxedo/agent-config/connections/${SCRIPTED_ACP_HARNESS.id}`, {
      method: "PUT", headers: jsonHeaders,
      body: JSON.stringify(scriptedAcpConnection({ bunPath: process.execPath, scriptDir, red: false })),
    }, owner)
    assert.equal(configured.status, 200, `hosted ACP configuration: ${await configured.text()}`)
    const workspace = await hostedWorkspace(stack, owner, "H28 hosted plugins")
    const api = hostedApi(stack, workspace, owner)
    const stream = await openEventStream(stack.relayUrl, workspace.directory, {
      relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
    })
    try {
      const session = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
      await api.prompt(workspace.directory, session.id, acpScriptToken("h28-proof"))
      const settled = await stream.waitFor((frame) => frameSessionId(frame) === session.id &&
        (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H28 hosted ACP settlement", timeoutMs: 60_000 })
      const started = (await readAcpRequests(scriptDir)).filter((request) => request.method === "session/new").at(-1)
      const servers = (started?.params.mcpServers ?? []) as McpEntry[]
      const delivered = servers.find((server) => server.name.endsWith("-scripted"))
      assert.ok(delivered, `C-8: the sandbox's ACP session/new carried no plugin server: ${JSON.stringify(servers)}`)
      assert.ok(delivered.url?.startsWith(`${HOSTED_MCP_GATEWAY_ORIGIN}/api/claxedo/plugins/mcp/`), `the plugin server does not point at the gateway: ${delivered.url}`)
      const authorization = delivered.headers?.find((header) => header.name === "Authorization")?.value
      assert.match(authorization ?? "", /^claxedo-broker:CLAXEDO_MCP_[A-Z0-9]+$/, `the sandbox holds a placeholder, never a token: ${authorization}`)
      assert.ok(!servers.some((server) => server.name.endsWith("-local")), `C-8: the local command the image lacks reached the sandbox: ${JSON.stringify(servers)}`)
      assert.equal(frameType(settled), "session.idle", `hosted ACP turn failed: ${JSON.stringify(settled)}`)
      assert.match(assistantText(await api.messages(workspace.directory, session.id)), /MCP_PROOF:H28HOSTED/)
      const calls = await upstreamCalls(stack.root)
      const proof = calls.find((call) => call.kind === "rpc" && call.method === "tools/call")
      assert.ok(proof && proof.kind === "rpc" && proof.marker === "H28HOSTED" && proof.authorization === `Bearer ${HOSTED_MCP_UPSTREAM_TOKEN}`,
        `the gateway did not present the upstream token for the proof call: ${JSON.stringify(calls)}`)
      assert.equal((await api.session(workspace.directory, session.id)).id, session.id)
      const leaks = await filesMentioning(path.join(stack.root, "sandbox-workspaces"), HOSTED_MCP_UPSTREAM_TOKEN)
      assert.deepEqual(leaks, [], "the upstream token never appears inside the sandbox")
      const own = assertOwnServer(servers, "the first session")
      const gatewayLeaks = servers.filter((server) => server !== own).flatMap((server) => server.headers ?? [])
        .map((header) => header.value).filter((value) => value.includes("eyJ"))
      assert.deepEqual(gatewayLeaks, [], "no signed gateway credential reached the sandbox")

      const changed = await json<{ revision: number; reconciliation: { state: string } }>(await hostedFetch(stack, "/api/claxedo/plugins/activation", {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["acp"], choice: false, expectedRevision: activated.revision, target: { scope: "all-projects" } }),
      }, owner), "H28 deactivation")
      assert.equal(changed.reconciliation.state, "applied", `C-8: the plugin change did not reach the running sandbox: ${JSON.stringify(changed)}`)
      // The withdrawn gateway credential changes the sandbox's brokered set,
      // which the driver installs by re-ensuring the host; the runtime and its
      // event channel come back before the next session.
      let healthy = false
      for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
        const health = await fetch(`${stack.relayUrl}/workspaces/${encodeURIComponent(workspace.id)}/api/wr/health`, { headers: { authorization: `Bearer ${workspace.runtimeAccessToken}` } })
        healthy = health.ok
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assert.ok(healthy, "the sandbox runtime did not come back after the plugin change")
      stream.close()
      const afterStream = await openEventStream(stack.relayUrl, workspace.directory, {
        relayWorkspaceId: workspace.id, authorization: `Bearer ${workspace.runtimeAccessToken}`,
      })
      try {
        const after = await api.createSession(workspace.directory, { harness: SCRIPTED_ACP_HARNESS })
        await api.prompt(workspace.directory, after.id, acpScriptToken("h28-after"))
        await afterStream.waitFor((frame) => frameSessionId(frame) === after.id &&
          (frameType(frame) === "session.idle" || frameType(frame) === "session.error"), { label: "H28 after-change settlement", timeoutMs: 60_000 })
        const restarted = (await readAcpRequests(scriptDir)).filter((request) => request.method === "session/new").at(-1)
        const afterServers = (restarted?.params.mcpServers ?? []) as McpEntry[]
        assert.ok(!afterServers.some((server) => server.name.endsWith("-scripted")), `C-8: the deactivated plugin still reaches the running sandbox: ${JSON.stringify(afterServers)}`)
        assertOwnServer(afterServers, "the session after the plugin change")
        assert.match(assistantText(await api.messages(workspace.directory, after.id)), /H28 after change/)
      } finally {
        afterStream.close()
      }
      console.log("H28: the plugin's HTTP server reached the hosted sandbox through the gateway with a placeholder, the missing local command was reported, and a plugin change reached the running sandbox")
    } finally {
      stream.close()
    }
  } finally {
    console.log(`H28 refused outbound: ${JSON.stringify(await stack.outboundAttempts())}`)
    await stack.close()
  }
}
