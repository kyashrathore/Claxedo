import type { FetchLike } from "../../adapter-contract"
import type { JsonRecord } from "../shared/sdk-runtime-adapter"
import { refreshCodexChatgptAuth } from "./auth-file"

/**
 * The operator's own Codex login, which only a turn with no binding runs on.
 *
 * The app-server asks Claxedo to renew the ChatGPT token when it expires. The
 * renewed document is cached here as well as written to the home, because the
 * next renewal has to start from the refresh token this one returned rather
 * than the one that was on disk when the process started.
 */
export class CodexOperatorLogin {
  private document: JsonRecord | undefined

  constructor(private readonly options: { home: string; fetch?: FetchLike }) {}

  async refresh() {
    const refreshed = await refreshCodexChatgptAuth({
      auth: this.document,
      home: this.options.home,
      fetch: this.options.fetch,
    })
    this.document = refreshed.auth
    return {
      access: refreshed.login.accessToken,
      accountId: refreshed.login.chatgptAccountId,
      ...(refreshed.login.chatgptPlanType ? { planType: refreshed.login.chatgptPlanType } : {}),
    }
  }
}
