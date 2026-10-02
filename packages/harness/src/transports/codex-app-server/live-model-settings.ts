import { errorMessage } from "@claxedo/helpers"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { ModelSettings } from "../../contract"
import type { Entry } from "./entry"
import { CodexTransportError } from "./errors"
import { codexTurnSettings, type CodexModel } from "./models"
import type { v2 } from "./translate"

export async function applyCodexModelSettings(entry: Entry, requested: ModelSettings, models: readonly CodexModel[]): Promise<void> {
  const settings = codexTurnSettings(models, { model: requested.model?.modelID, effort: requested.effort })
  const turn = entry.turn
  if (turn) await turn.started
  const turnId = entry.turn === turn && !turn?.closing ? turn?.id : undefined
  const activeId = turnId ?? entry.providerTurn?.id
  const params: v2.ThreadSettingsUpdateParams = { threadId: entry.session.binding.upstreamSessionId,
    model: settings.model ?? null, effort: settings.effort ?? null }
  try {
    if (activeId) {
      const live: v2.TurnSettingsUpdateParams = { ...params, turnId: activeId }
      const result = asRecordOrEmpty(await entry.rpc.request("turn/settings/update", live))
      if (result.status !== "applied" && result.status !== "targetUnavailable") {
        throw new CodexTransportError("protocol", "Codex returned an invalid turn settings update status")
      }
    }
    await entry.rpc.request("thread/settings/update", params)
  } catch (cause) {
    throw new CodexTransportError("configuration", `Codex refused the model or effort change: ${errorMessage(cause)}`, { cause })
  }
}
