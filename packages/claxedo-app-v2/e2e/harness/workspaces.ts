import fs from "node:fs/promises"
import path from "node:path"
import { initRepository } from "./git"
import { sendJson, type HttpTransport } from "./transport"

export type Workspace = { id: string; directory: string; projectId: string }

export async function makeWorkspace(
  transport: HttpTransport,
  serverUrl: string,
  root: string,
  name: string,
  projectName?: string,
): Promise<Workspace> {
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, `${name}-`)))
  await initRepository(directory, name)
  const resolved = await sendJson(transport, "POST", `${serverUrl}/api/workspace/resolve?directory=${encodeURIComponent(directory)}`, {}, "Workspace registration")
  const project = await sendJson(
    transport,
    "POST",
    `${serverUrl}/api/claxedo/projects`,
    { name: projectName ?? path.basename(directory), source: { kind: "directory", directory } },
    `Project record for ${directory}`,
  )
  const workspaceId = (JSON.parse(resolved) as { workspaceId: string }).workspaceId
  const projectId = (JSON.parse(project) as { project: { id: string } }).project.id
  return { id: workspaceId, directory, projectId }
}
