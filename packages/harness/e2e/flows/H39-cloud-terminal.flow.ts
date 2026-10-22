import assert from "node:assert/strict"
import { hostedWorkspace } from "../harness/hosted-flow"
import { startHostedCloudStack } from "../harness/hosted-cloud"

type HostedWorkspace = Awaited<ReturnType<typeof hostedWorkspace>>

async function relayJson(relayUrl: string, workspace: HostedWorkspace, method: string, route: string, body?: unknown) {
  const response = await fetch(new URL(`/workspaces/${encodeURIComponent(workspace.id)}${route}`, relayUrl), {
    method,
    headers: { authorization: `Bearer ${workspace.runtimeAccessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : undefined }
}

function attach(relayUrl: string, workspace: HostedWorkspace, terminalId: string) {
  const url = new URL(`/workspaces/${encodeURIComponent(workspace.id)}/api/wr/pty/${encodeURIComponent(terminalId)}/connect?cursor=0`, relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = new WebSocket(url, [`claxedo-rat.${workspace.runtimeAccessToken}`])
  socket.binaryType = "arraybuffer"
  const decoder = new TextDecoder()
  let output = ""
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") output += event.data
    else if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data)
      if (bytes[0] !== 0) output += decoder.decode(bytes, { stream: true })
    }
  }
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onclose = (event) => reject(new Error(`the terminal stream closed before it opened: ${event.code} ${event.reason}`))
  })
  const until = async (text: string) => {
    const deadline = Date.now() + 20_000
    while (!output.includes(text)) {
      if (Date.now() > deadline) throw new Error(`the terminal never printed ${text}; it printed ${JSON.stringify(output.slice(-500))}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return { opened, until, send: (data: string) => socket.send(data), close: () => socket.close() }
}

export async function run() {
  const stack = await startHostedCloudStack("h39-cloud-terminal")
  try {
    const workspace = await hostedWorkspace(stack, stack.owner, "h39")
    const created = await relayJson(stack.relayUrl, workspace, "POST", "/api/wr/pty", { title: "skew", createRequestId: crypto.randomUUID() })
    assert.equal(created.status, 200, `the cloud terminal create answered ${created.status}: ${JSON.stringify(created.body)}`)
    const terminalId = (created.body as { id: string }).id
    const listed = await relayJson(stack.relayUrl, workspace, "GET", "/api/wr/pty")
    assert.ok((listed.body as Array<{ id: string }>).some((row) => row.id === terminalId), "the created terminal is not listed")

    const terminal = attach(stack.relayUrl, workspace, terminalId)
    await terminal.opened
    terminal.send("echo terminal-$((40 + 2))\n")
    await terminal.until("terminal-42")
    terminal.close()

    const closed = await relayJson(stack.relayUrl, workspace, "DELETE", `/api/wr/pty/${encodeURIComponent(terminalId)}`)
    assert.equal(closed.status, 200, `the cloud terminal close answered ${closed.status}: ${JSON.stringify(closed.body)}`)
    const after = await relayJson(stack.relayUrl, workspace, "GET", "/api/wr/pty")
    assert.ok(!(after.body as Array<{ id: string }>).some((row) => row.id === terminalId), "a closed terminal is still listed")
  } finally {
    await stack.close()
  }
}
