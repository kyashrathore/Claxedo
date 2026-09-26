import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lookup } from "node:dns/promises"
import { createBoundedGit, runGit, type GitHttpCredential } from "@claxedo/workspace-runtime/host"
import type { RepoAddressResolver } from "@claxedo/sandbox-contract"
import { dataDir } from "../platform/runtime/lib/paths"
import type { SignedControlPlaneAuth } from "../platform/auth/auth"
import {
  deleteProjectRecord,
  deleteWorkspace,
  ensureWorkspace,
  findProjectRecordByName,
  getProjectRecord,
  getProjectWorkspace,
  getWorkspaceByDirectory,
  listProjectRecords,
  listProjects,
  listWorkspaces,
  updateProjectMetadata,
  upsertProjectRecord,
} from "../workspace/store/index"
import { lastPathSegment } from "./repository-source"
import {
  freeProjectName,
  projectSlug,
  ProjectStoreError,
  trimmedProjectName,
  type ProjectCreateInput,
  type ProjectRecord,
  type ProjectStore,
  type ProjectUpdateInput,
} from "./store"

/**
 * Projects on a server with its own filesystem, kept in the workspace store
 * (`workspaces.json`). Every project here has a checkout on disk: a folder the
 * caller already has, or a repository cloned into `<dataDir>/projects/<slug>`
 * at creation. That checkout is the project's local worktree; the workspace
 * rows carrying the project's id are its placements.
 *
 * Names are unique per server (case-insensitive).
 */

/**
 * Cloning a repository takes as long as the repository is large, so it runs on
 * a pool of its own: on the shared runner a clone would hold a slot the file
 * tree and diff routes are waiting for.
 */
const CLONE_TIMEOUT_MS = 30 * 60_000
const cloneGit = createBoundedGit({ timeoutMs: CLONE_TIMEOUT_MS })

export function projectsDirectory() {
  return path.join(dataDir(), "projects")
}

export type CloneOptions = {
  /** An `Authorization` header value for the repository's host, never placed in argv. */
  authorization?: string
  host?: string
}

async function cloneRepository(repoUrl: string, directory: string, options: CloneOptions = {}) {
  const parent = path.dirname(directory)
  await fs.mkdir(parent, { recursive: true })
  await cloneGit(["clone", "--", repoUrl, directory], parent,
    options.authorization && options.host
      ? { credential: { host: options.host, authorization: options.authorization } }
      : {})
}

/**
 * The system resolver, so clone admission sees the answers `git` will actually
 * dial: getaddrinfo honours /etc/hosts, mDNS and split-horizon DNS, and a
 * private answer anywhere is a private destination. An unresolvable name
 * answers empty, which the admission reads as refused.
 */
export const systemRepoAddresses: RepoAddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true }).catch(() => [])).map((answer) => answer.address)

/** The repository's name by its `origin` remote; `undefined` when the folder has none or is not a repository. */
async function originRepositoryName(directory: string) {
  const remote = await runGit(["remote", "get-url", "origin"], directory).catch(() => "")
  return trimmedProjectName(lastPathSegment(remote.trim()).replace(/\.git$/, ""))
}

/**
 * A local project's workspace as the signed authority should know it. On a
 * signed server every engine call for a directory is authorised against the
 * authority's workspace membership, so a folder project must exist there too
 * or it can never be opened.
 *
 * `projectId` is the local store's project id, and the authority must file the
 * workspace under that same id: the signed `/project` list authorises each
 * local project by its own id, so a workspace registered under a freshly
 * minted authority project leaves its project invisible to the caller who
 * just created it.
 */
export type LocalProjectWorkspaceRegistration = {
  workspaceId: string
  projectId: string
  displayName: string
  directory: string
  repoUrl?: string
}

export type LocalProjectStoreDeps = {
  clone?: typeof cloneRepository
  /**
   * Registers the workspace with the signed caller's authority. Required of a
   * signed composition and checked before the first write, since it is the
   * only thing that makes a created project reachable by the account that
   * asked for it. The unsigned local product has no authority and no caller
   * identity, and registers nothing.
   */
  registerWorkspace?: (auth: SignedControlPlaneAuth, workspace: LocalProjectWorkspaceRegistration) => Promise<void>
  /**
   * The reverse: retires the project and its placements in the signed
   * caller's authority. Required of a signed composition, because an
   * authority row left behind claims the same repository for the retired id
   * and hides the project the next create makes for that folder.
   */
  unregisterProject?: (auth: SignedControlPlaneAuth, project: { projectId: string; workspaceIds: string[] }) => Promise<void>
}

type CatalogProject = Awaited<ReturnType<typeof listProjects>>[number]

type StoredProject = NonNullable<Awaited<ReturnType<typeof getProjectRecord>>>

/**
 * A project is every entry of the workspace catalog, the list the engine's
 * own project routes serve, plus any record not placed yet. Its name, icon
 * and startup command are the catalog's (the root workspace's `project_*`
 * fields, which those routes also write); the record adds the environment,
 * and its name only lets creation refuse a taken one. It is available while
 * one of its placements exists: a folder that is there, or a cloud workspace
 * that has not failed, whether or not its sandbox runs now (the placement's
 * `reachable` says that).
 */
async function projectView(id: string, catalog: CatalogProject | undefined, record: StoredProject | undefined): Promise<ProjectRecord | undefined> {
  const known = record ?? (catalog && { name: catalog.name, created_at: catalog.time.created, updated_at: catalog.time.updated })
  if (!known) return undefined
  const workspace = await getProjectWorkspace(id)
  return {
    id,
    name: catalog?.name ?? known.name,
    env: record?.env ?? {},
    directory: workspace?.directory ?? null,
    repoUrl: workspace?.repo_url ?? null,
    ...(catalog?.icon ? { icon: catalog.icon } : {}),
    ...(catalog?.commands ? { commands: catalog.commands } : {}),
    available: Object.values(catalog?.workspaces ?? {}).some((placement) => placement.available),
    created_at: known.created_at,
    updated_at: Math.max(known.updated_at, catalog?.time.updated ?? 0),
  }
}

async function findProject(id: string) {
  const catalog = (await listProjects()).find((project) => project.id === id)
  return projectView(id, catalog, await getProjectRecord(id))
}

const nameTaken = async (name: string) => Boolean(await findProjectRecordByName(name))

function signedOnly<Dep>(caller: SignedControlPlaneAuth | undefined, dep: Dep | undefined, what: string) {
  if (!caller) return undefined
  if (!dep) throw new ProjectStoreError(503, "authority_unavailable", `${what} is not configured for signed callers`)
  return dep
}

function expandHome(directory: string): string {
  if (directory === "~") return os.homedir()
  if (directory.startsWith("~/")) return path.join(os.homedir(), directory.slice(2))
  return directory
}

export function localProjectStore(deps: LocalProjectStoreDeps = {}): ProjectStore {
  const clone = deps.clone ?? cloneRepository

  async function checkout(input: ProjectCreateInput): Promise<{ directory: string; repoUrl?: string; name: string; credential?: GitHttpCredential }> {
    if (input.source.kind === "directory") {
      const directory = expandHome(input.source.directory.trim())
      if (!path.isAbsolute(directory)) {
        throw new ProjectStoreError(400, "project_directory_relative", "Use the folder's full path, for example /Users/you/code/app")
      }
      const stat = await fs.stat(directory).catch(() => undefined)
      if (!stat?.isDirectory()) throw new ProjectStoreError(400, "project_directory_missing", "That folder does not exist on this server")
      const existing = await getWorkspaceByDirectory(directory)
      const owner = existing?.project_id ? await getProjectRecord(existing.project_id) : undefined
      if (owner) throw new ProjectStoreError(409, "project_directory_taken", `That folder is already the project "${owner.name}"`)
      const name = input.name ?? await freeProjectName(await originRepositoryName(directory) ?? path.basename(directory), nameTaken)
      return { directory, name }
    }
    const repository = await input.source.resolve()
    const name = input.name ?? await freeProjectName(repository.name, nameTaken)
    const slug = projectSlug(name)
    if (!slug) throw new ProjectStoreError(400, "project_invalid", "name must contain a letter or digit")
    const directory = path.join(projectsDirectory(), slug)
    if (await fs.stat(directory).catch(() => undefined)) {
      throw new ProjectStoreError(409, "project_directory_taken", `${directory} already exists on this server`)
    }
    return { directory, repoUrl: repository.repoUrl, name, ...(repository.credential ? { credential: repository.credential } : {}) }
  }

  return {
    folders: true,

    async list() {
      const catalog = new Map((await listProjects()).map((project) => [project.id, project]))
      const records = new Map((await listProjectRecords()).map((record) => [record.id, record]))
      const projects: ProjectRecord[] = []
      for (const id of new Set([...records.keys(), ...catalog.keys()])) {
        const view = await projectView(id, catalog.get(id), records.get(id))
        if (view) projects.push(view)
      }
      return projects.sort((a, b) => a.created_at - b.created_at)
    },

    get: findProject,

    async create(input, caller) {
      const register = signedOnly(caller, deps.registerWorkspace, "Project registration")
      if (input.name && await nameTaken(input.name)) {
        throw new ProjectStoreError(409, "project_name_taken", `A project named "${input.name}" already exists`)
      }
      const { directory, repoUrl, name, credential } = await checkout(input)
      if (repoUrl) {
        try {
          await clone(repoUrl, directory, credential ?? {})
        } catch (cause) {
          await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
          const message = cause instanceof Error ? cause.message : String(cause)
          throw new ProjectStoreError(502, "project_clone_failed", `Cloning failed: ${message.split("\n").find((line) => line.trim()) ?? message}`)
        }
      }
      const workspace = await ensureWorkspace({ directory, kind: "local", project_name: name, ...(repoUrl ? { repo_url: repoUrl } : {}) })
      if (!workspace?.project_id) {
        throw new ProjectStoreError(400, "project_not_git", "Only git repositories can be projects; that folder is not one")
      }
      if (register && caller) {
        try {
          await register(caller, {
            workspaceId: workspace.id,
            projectId: workspace.project_id,
            displayName: name,
            directory,
            ...(repoUrl ? { repoUrl } : {}),
          })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          throw new ProjectStoreError(502, "project_register_failed", `The project could not be registered for your account: ${message}`)
        }
      }
      const record = await upsertProjectRecord({ id: workspace.project_id, name, env: input.env ?? {} })
      return (await findProject(record.id))!
    },

    async update(id, input: ProjectUpdateInput) {
      const current = await findProject(id)
      if (!current) return undefined
      const name = input.name?.trim()
      if (name) {
        const clash = await findProjectRecordByName(name)
        if (clash && clash.id !== id) throw new ProjectStoreError(409, "project_name_taken", `A project named "${name}" already exists`)
      }
      if (name !== undefined || input.icon || input.commands) {
        await updateProjectMetadata(id, {
          ...(name !== undefined ? { name } : {}),
          ...(input.icon ? { icon: input.icon } : {}),
          ...(input.commands ? { commands: input.commands } : {}),
        })
      }
      const record = await getProjectRecord(id)
      if (input.env !== undefined || (record && name)) {
        await upsertProjectRecord({
          id,
          name: name || record?.name || current.name,
          ...(input.env !== undefined ? { env: input.env } : {}),
        })
      }
      return findProject(id)
    },

    async remove(id, caller) {
      const unregister = signedOnly(caller, deps.unregisterProject, "Project unregistration")
      const record = await getProjectRecord(id)
      const placements = (await listWorkspaces()).filter((workspace) => workspace.project_id === id)
      if (!record && placements.length === 0) return false
      if (placements.some((workspace) => workspace.kind === "cloud")) {
        throw new ProjectStoreError(409, "project_has_cloud_workspaces", "Delete the project's cloud workspaces before removing it")
      }
      if (unregister && caller) {
        try {
          await unregister(caller, { projectId: id, workspaceIds: placements.map((workspace) => workspace.id) })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          throw new ProjectStoreError(502, "project_unregister_failed", `The project could not be retired for your account: ${message}`)
        }
      }
      for (const workspace of placements) await deleteWorkspace(workspace.id)
      if (record) await deleteProjectRecord(id)
      return true
    },
  }
}
