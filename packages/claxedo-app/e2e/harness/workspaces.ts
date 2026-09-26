import fs from "node:fs/promises"
import path from "node:path"
import { initRepository } from "./git"
import { sendJson, type HttpTransport } from "./transport"

export type Workspace = { id: string; directory: string; projectId: string }

async function freshRepository(root: string, name: string) {
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, `${name}-`)))
  await initRepository(directory, name)
  return directory
}

async function recordProject(transport: HttpTransport, serverUrl: string, directory: string, projectName?: string) {
  const project = await sendJson(
    transport,
    "POST",
    `${serverUrl}/api/claxedo/projects`,
    { name: projectName ?? path.basename(directory), source: { kind: "directory", directory } },
    `Project record for ${directory}`,
  )
  return (JSON.parse(project) as { project: { id: string } }).project.id
}

export async function makeWorkspace(
  transport: HttpTransport,
  serverUrl: string,
  root: string,
  name: string,
  projectName?: string,
): Promise<Workspace> {
  const directory = await freshRepository(root, name)
  const resolved = await sendJson(transport, "POST", `${serverUrl}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, {}, "Workspace registration")
  const projectId = await recordProject(transport, serverUrl, directory, projectName)
  return { id: (JSON.parse(resolved) as { workspaceId: string }).workspaceId, directory, projectId }
}

export async function makeSignedWorkspace(
  transport: HttpTransport,
  serverUrl: string,
  root: string,
  name: string,
  projectName?: string,
): Promise<Workspace> {
  const directory = await freshRepository(root, name)
  const projectId = await recordProject(transport, serverUrl, directory, projectName)
  const resolved = await transport({ method: "GET", url: `${serverUrl}/api/workspace/resolve?directory=${encodeURIComponent(directory)}` })
  if (resolved.status !== 200) throw new Error(`Resolving the signed workspace failed: ${resolved.status} ${resolved.body}`)
  return { id: (JSON.parse(resolved.body) as { workspaceId: string }).workspaceId, directory, projectId }
}
