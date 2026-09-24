import fs from "node:fs/promises"
import path from "node:path"
import { initRepository } from "./git"
import type { HttpTransport } from "./transport"

export type Workspace = { id: string; directory: string }

export async function makeWorkspace(transport: HttpTransport, serverUrl: string, root: string, name: string): Promise<Workspace> {
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, `${name}-`)))
  await initRepository(directory, name)
  const reply = await transport({ method: "POST", url: `${serverUrl}/api/workspace/resolve?directory=${encodeURIComponent(directory)}` })
  if (reply.status < 200 || reply.status >= 300) throw new Error(`workspace registration failed (${reply.status}): ${reply.body}`)
  const body = JSON.parse(reply.body) as { workspaceId: string }
  return { id: body.workspaceId, directory }
}
