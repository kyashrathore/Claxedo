import { asRecord } from "@claxedo/helpers/guards"
import {
  TASKS_ERROR_CODES,
  type ChildListQuery,
  type InvalidField,
  type Page,
  type Preset,
  type PresetListQuery,
  type StartPreviewRequest,
  type StartPreviewResponse,
  type StartRequest,
  type StartResponse,
  type TaskChildrenResponse,
  type TaskDetailResponse,
  type TaskListQuery,
  type TaskSummary,
  type TasksCapabilities,
  type TasksCommandRequest,
  type TasksCommandResponse,
  type TasksErrorCode,
  type TasksErrorDetail,
} from "../contracts"
import {
  decodeCapabilitiesResponse,
  decodeCommandResponse,
  decodePreset,
  decodePresetPage,
  decodeStartPreviewResponse,
  decodeStartResponse,
  decodeTask,
  decodeTaskDetail,
  decodeTaskSummaryPage,
} from "../decode"
import type { Parsed } from "../validation"

/** The callable half of `fetch`; a bare `typeof fetch` differs per runtime lib. */
export type TasksFetch = (input: string, init?: RequestInit) => Promise<Response>

export type TasksClientOptions = {
  baseUrl: string
  request: TasksFetch
  headers?: HeadersInit
}

/** A refusalError the server named, carrying the server's own code. */
export class TasksApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: TasksErrorCode,
    readonly detail: TasksErrorDetail,
  ) {
    super(detail.message)
    this.name = "TasksApiError"
  }
}

/** A response that is not a tasks response: unparseable, or missing contract fields. */
export class TasksClientPayloadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: readonly InvalidField[] = [],
  ) {
    super(message)
    this.name = "TasksClientPayloadError"
  }
}

export type TasksClient = {
  capabilities(): Promise<TasksCapabilities>
  listPresets(queryString?: Partial<PresetListQuery>): Promise<Page<Preset>>
  getPreset(presetId: string): Promise<Preset>
  listTasks(queryString: Partial<TaskListQuery> & Pick<TaskListQuery, "projectId">): Promise<Page<TaskSummary>>
  getTask(taskId: string): Promise<TaskDetailResponse>
  listChildren(taskId: string, queryString?: Partial<ChildListQuery>): Promise<TaskChildrenResponse>
  command(request: TasksCommandRequest): Promise<TasksCommandResponse>
  startPreview(taskId: string, request: StartPreviewRequest): Promise<StartPreviewResponse>
  start(taskId: string, request: StartRequest): Promise<StartResponse>
}

function isErrorCode(value: unknown): value is TasksErrorCode {
  return typeof value === "string" && TASKS_ERROR_CODES.some((code) => code === value)
}

function isFieldList(value: unknown): value is readonly InvalidField[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      const row = asRecord(entry)
      return typeof row?.path === "string" && typeof row.reason === "string"
    })
  )
}

function refusalError(status: number, payload: unknown): Error {
  const detail = asRecord(asRecord(payload)?.error)
  if (!detail || !isErrorCode(detail.code) || typeof detail.message !== "string") {
    return new TasksClientPayloadError(status, `Request failed with status ${status}`)
  }
  const named: TasksErrorDetail = { code: detail.code, message: detail.message }
  // `stale_revision` carries the record to rebase onto. A record that does not
  // decode is dropped rather than raised: the refusal itself is what the caller
  // has to act on, and losing its reason to a malformed extra is worse than
  // rebasing from a second read.
  const currentPreset = detail.currentPreset === undefined ? undefined : decodePreset(detail.currentPreset)
  const currentTask = detail.currentTask === undefined ? undefined : decodeTask(detail.currentTask)
  return new TasksApiError(status, detail.code, {
    ...named,
    ...(isFieldList(detail.fields) ? { fields: detail.fields } : {}),
    ...(currentPreset?.ok === true ? { currentPreset: currentPreset.value } : {}),
    ...(currentTask?.ok === true ? { currentTask: currentTask.value } : {}),
  })
}

/** `HeadersInit` is three shapes; only `Headers` merges all three without losing entries. */
function headersOf(...values: readonly (HeadersInit | undefined)[]): Headers {
  const merged = new Headers()
  for (const value of values) {
    if (!value) continue
    new Headers(value).forEach((entry, key) => merged.set(key, entry))
  }
  return merged
}

function queryString(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const rendered = params.toString()
  return rendered.length > 0 ? `?${rendered}` : ""
}

export function createTasksClient(options: TasksClientOptions): TasksClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")

  const call = async <T>(path: string, decode: (payload: unknown) => Parsed<T>, init?: RequestInit): Promise<T> => {
    const response = await options.request(`${baseUrl}${path}`, {
      ...init,
      headers: headersOf(
        { Accept: "application/json" },
        init?.body === undefined ? undefined : { "Content-Type": "application/json" },
        options.headers,
        init?.headers,
      ),
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      throw new TasksClientPayloadError(response.status, "Response body is not JSON")
    }
    if (!response.ok) throw refusalError(response.status, payload)
    const finishDecode = decode(payload)
    if (!finishDecode.ok) {
      throw new TasksClientPayloadError(response.status, "Response did not match the tasks contract", finishDecode.fields)
    }
    return finishDecode.value
  }

  const post = <T>(path: string, body: unknown, decode: (payload: unknown) => Parsed<T>) =>
    call(path, decode, { method: "POST", body: JSON.stringify(body) })

  return {
    async capabilities() {
      return call("/capabilities", decodeCapabilitiesResponse)
    },

    async listPresets(input = {}) {
      return call(
        `/presets${queryString({ cursor: input.cursor, limit: input.limit, includeArchived: input.includeArchived })}`,
        decodePresetPage,
      )
    },

    async getPreset(presetId) {
      return call(`/presets/${encodeURIComponent(presetId)}`, (payload) => decodePreset(asRecord(payload)?.preset))
    },

    async listTasks(input) {
      return call(
        `/tasks${queryString({
          projectId: input.projectId,
          status: input.status,
          parent: input.parent,
          cursor: input.cursor,
          limit: input.limit,
          includeArchived: input.includeArchived,
        })}`,
        decodeTaskSummaryPage,
      )
    },

    async getTask(taskId) {
      return call(`/tasks/${encodeURIComponent(taskId)}`, decodeTaskDetail)
    },

    async listChildren(taskId, input = {}) {
      return call(
        `/tasks/${encodeURIComponent(taskId)}/children${queryString({
          cursor: input.cursor,
          limit: input.limit,
          includeArchived: input.includeArchived,
        })}`,
        decodeTaskSummaryPage,
      )
    },

    async command(request) {
      return post("/commands", request, decodeCommandResponse)
    },

    async startPreview(taskId, request) {
      return post(`/tasks/${encodeURIComponent(taskId)}/start-preview`, request, decodeStartPreviewResponse)
    },

    async start(taskId, request) {
      return post(`/tasks/${encodeURIComponent(taskId)}/sessions`, request, decodeStartResponse)
    },
  }
}
