import { errorMessage, type JsonRecord, type SdkRuntimeAuth } from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import { codexChatgptAuthTokens, sourceAuthValue, sourceCodexAuthValue } from "./auth-file"

/**
 * The credentials the Codex app-server is currently logged in with, and the
 * revision fence that decides when a running process has to be told again.
 *
 * A process carries login state of its own, so the driver cannot simply resend:
 * the fence separates "the configured credentials changed" from "this process
 * has already been told", and `isCurrent` keeps a sync that started against a
 * replaced process from writing the new one's state.
 */
export class CodexProcessAuth {
  private keys: SdkRuntimeAuth = {}
  private source: JsonRecord | undefined
  private revision = 0
  private syncedRevision = -1
  private syncedExplicit = false
  private pending: Promise<void> | null = null

  constructor(private readonly isCurrent: (proc: CodexAppServerProcess) => boolean) {}

  /** The `auth.json` record, which the server-request refresh rewrites in place. */
  get codexAuth(): JsonRecord | undefined {
    return this.source
  }
  set codexAuth(value: JsonRecord | undefined) {
    this.source = value
  }

  /** True when the merge changed what the app-server would be told. */
  mergeKeys(keys: SdkRuntimeAuth): boolean {
    return this.reviseIfChanged(() => {
      this.keys = {
        ...this.keys,
        ...(keys.openai !== undefined ? { openai: keys.openai || undefined } : {}),
      }
    })
  }

  /** True when the configured source changed what the app-server would be told. */
  replaceSource(source: string | undefined): boolean {
    return this.reviseIfChanged(() => {
      this.source = sourceCodexAuthValue(source)
      this.keys = { openai: sourceAuthValue(source) }
    })
  }

  /** A freshly started process has been told nothing yet. */
  forgetProcess() {
    this.syncedRevision = -1
    this.syncedExplicit = false
  }

  async sync(proc: CodexAppServerProcess): Promise<void> {
    if (this.pending) await this.pending
    if (!this.isCurrent(proc) || !proc.alive || this.syncedRevision === this.revision) return
    const revision = this.revision
    const params = this.loginParams()
    const settled = (async () => {
      try {
        if (params) await proc.request("account/login/start", params)
        else if (this.syncedExplicit) {
          await proc.request("account/logout", null)
        }
      } catch (err) {
        throw new Error(`Codex auth could not initialize: ${errorMessage(err)}`, { cause: err })
      }
      if (this.isCurrent(proc)) {
        this.syncedExplicit = !!params
        if (revision === this.revision) this.syncedRevision = revision
      }
    })()
    const sync = settled.finally(() => {
      if (this.pending === sync) this.pending = null
    })
    this.pending = sync
    await this.pending
    if (this.isCurrent(proc) && proc.alive && this.syncedRevision !== this.revision) {
      await this.sync(proc)
    }
  }

  private reviseIfChanged(mutate: () => void): boolean {
    const previous = this.signature()
    mutate()
    if (this.signature() === previous) return false
    this.revision++
    return true
  }

  private signature() {
    return JSON.stringify(this.loginParams() ?? null)
  }

  private loginParams() {
    if (this.keys.openai) return { type: "apiKey", apiKey: this.keys.openai }
    const tokens = codexChatgptAuthTokens(this.source)
    if (!tokens) return undefined
    return {
      type: "chatgptAuthTokens",
      accessToken: tokens.access,
      chatgptAccountId: tokens.accountId,
      chatgptPlanType: tokens.planType ?? null,
    }
  }
}
