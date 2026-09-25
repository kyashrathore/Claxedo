import {
  applyDraftDefault,
  beginDraftDefault,
  beginDraftHarnessChoice,
  canSelectDraftModel,
  draftDefaultApplication,
  markServer,
  promote,
  protectDraftModel,
  rememberDraftHarness,
  rememberDraftModel,
} from "./draft-default-store"
import { createDraftDefaultPreferences, type DraftDefaultStorage } from "./draft-defaults"
import { createHarnessScopes, holdHarness, restoreHeldHarness } from "./harness-scopes"
import { harnessOptionsReads, harnessSelectionReads, harnessStoreWrites } from "./harness-store-reads"
import type { ModelChoice } from "@/server"

export function createHarnessStore(storage: DraftDefaultStorage) {
  const scopes = createHarnessScopes()
  const context = { scopes, memory: createDraftDefaultPreferences(storage) }
  return {
    applyPatch: scopes.applyPatch,
    read: scopes.read,
    seed: scopes.seed,
    state: (scope: string) => scopes.store[scope],
    holdHarness: holdHarness.bind(null, scopes),
    restoreHeldHarness: restoreHeldHarness.bind(null, scopes),
    promote: promote.bind(null, scopes),
    markServer: markServer.bind(null, scopes),
    applyDraftDefault: applyDraftDefault.bind(null, scopes),
    draftDefaultApplication: draftDefaultApplication.bind(null, scopes),
    protectDraftModel: protectDraftModel.bind(null, scopes),
    beginDraftDefault: beginDraftDefault.bind(null, context),
    beginDraftHarnessChoice: beginDraftHarnessChoice.bind(null, context),
    rememberDraftHarness: rememberDraftHarness.bind(null, context),
    rememberDraftModel: rememberDraftModel.bind(null, context),
    acceptsDraftModel: (scope: string, model: ModelChoice) => canSelectDraftModel(scopes.read(scope), model),
    ...harnessStoreWrites(scopes),
    ...harnessSelectionReads(scopes.read),
    ...harnessOptionsReads(scopes.read),
  }
}
