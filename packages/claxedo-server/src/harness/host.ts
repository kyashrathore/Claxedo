import { randomUUID } from "crypto"
import type { CompatEvent } from "../../../workspace-runtime/src/compat-events"
import type { AgentAdapter, PromptInput, SessionConfig, SessionConfigPatch } from "../../../workspace-runtime/src/adapters/index"
import { defaultRunner, listCommands, loadUserConfig } from "../agent-config"
import { sessionError } from "../../../workspace-runtime/src/compat-events"
import {
  deleteSessionRunner,
  getSessionConfig,
  setSessionConfig,
  updateSessionConfig as patchSessionConfig,
} from "../session-runner"
import type { Workspace } from "../workspace-store"
import type { ProjectionStore } from "../control-plane/projection-store"

function row(input: Awaited<ReturnType<ProjectionStore["session_meta"]>>) {
  if (!input) return null
  return {
    id: input.sessionID,
    title: input.title ?? null,
    directory: input.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    ...(input.rootID ? { rootID: input.rootID } : {}),
    ...(input.projectID ? { projectID: input.projectID } : {}),
    tags: input.tags,
    attachments: input.attachments,
    time: {
      created: input.createdAt,
      updated: input.updatedAt,
      ...(typeof input.archived === "number" ? { archived: input.archived } : {}),
    },
  }
}

async function cfg(ws: Workspace, sessionID: string): Promise<SessionConfig> {
  const saved = getSessionConfig(ws.id, sessionID)
  if (saved) return saved
  const runner = defaultRunner(await loadUserConfig())
  return {
    runner,
    ...(runner.type !== "opencode" && runner.model
      ? { model: { providerID: runner.type, modelID: runner.model } }
      : {}),
    variant: null,
    agent: null,
  }
}

class PlaceholderAdapter implements AgentAdapter {
  constructor(
    private ws: Workspace,
    private projectionStore: ProjectionStore,
  ) {}

  async listSessions(directory: string) {
    return (await this.projectionStore.list_session_metas({
      workspaceID: this.ws.id,
      directory,
    })).map(row).filter((item): item is Exclude<typeof item, null> => !!item)
  }

  async getSession(id: string) {
    return row(await this.projectionStore.session_meta(id))
  }

  async createSession(directory: string, title?: string) {
    const id = randomUUID()
    await this.projectionStore.put_session_meta(id, {
      ws: this.ws,
      directory,
      title: title ?? null,
    })
    setSessionConfig(this.ws.id, id, await cfg(this.ws, id))
    return { id }
  }

  async updateSession(id: string, input: { title?: string; time?: { archived?: number } }) {
    const hit = await this.projectionStore.session_meta(id)
    if (!hit) return null
    await this.projectionStore.put_session_meta(id, {
      ws: this.ws,
      directory: hit.directory,
      title: input.title ?? hit.title ?? null,
      parentID: hit.parentID ?? null,
      archived: input.time?.archived ?? hit.archived ?? null,
      tags: hit.tags,
      attachments: hit.attachments,
    })
    return row(await this.projectionStore.session_meta(id))
  }

  async getSessionConfig(id: string) {
    return cfg(this.ws, id)
  }

  async updateSessionConfig(id: string, patch: SessionConfigPatch) {
    const prev = await cfg(this.ws, id)
    const next = {
      runner: patch.runner ?? prev.runner,
      ...(patch.model === undefined
        ? prev.model
          ? { model: prev.model }
          : {}
        : patch.model
        ? { model: patch.model }
        : {}),
      variant: patch.variant === undefined ? prev.variant ?? null : patch.variant,
      agent: patch.agent === undefined ? prev.agent ?? null : patch.agent,
    } satisfies SessionConfig
    patchSessionConfig(this.ws.id, id, next)
    return next
  }

  async deleteSession(id: string) {
    await this.projectionStore.delete_session_meta(id)
    deleteSessionRunner(this.ws.id, id)
  }

  async *sendMessage(id: string, _input: PromptInput): AsyncIterable<CompatEvent> {
    yield sessionError(
      "Central harness scaffolding is enabled, but no central runner is configured yet.",
      id,
    )
  }

  async getMessages(id: string) {
    return this.projectionStore.read_session_messages(id)
  }

  async abort(): Promise<{ ok: true; status: "already_idle" }> {
    return { ok: true, status: "already_idle" }
  }

  async revert() {}

  async unrevert() {}

  async forkSession(id: string) {
    const hit = await this.projectionStore.session_meta(id)
    if (!hit) throw new Error(`Session ${id} not found`)
    const next = randomUUID()
    await this.projectionStore.put_session_meta(next, {
      ws: this.ws,
      directory: hit.directory,
      title: hit.title ?? null,
      parentID: id,
      tags: hit.tags,
      attachments: hit.attachments,
    })
    setSessionConfig(this.ws.id, next, await cfg(this.ws, next))
    return { id: next }
  }

  async executeCommand() {}

  async listCommands() {
    return listCommands()
  }

  async listAgents() {
    return [{
      name: "central",
      description: "Experimental central harness scaffold",
      mode: "primary",
    }]
  }

  async getTodos() {
    return []
  }

  async listPermissions() {
    return []
  }

  async respondPermission() {}

  async listQuestions() {
    return []
  }

  async replyQuestion() {}

  async rejectQuestion() {}

  async applyConfig() {}

  async probeConfigOptions() {
    return []
  }

  dispose() {}
}

export interface HarnessHost {
  id: string
  createAdapter: (ws: Workspace) => Promise<AgentAdapter>
}

const state = {
  host: undefined as HarnessHost | undefined,
}

export function configureHarnessHost(host: HarnessHost) {
  state.host = host
}

export function hasHarnessHost() {
  return !!state.host
}

export function getHarnessHost(projectionStore: ProjectionStore): HarnessHost {
  if (state.host) return state.host
  return {
    id: "placeholder",
    createAdapter: async (ws) => new PlaceholderAdapter(ws, projectionStore),
  }
}
