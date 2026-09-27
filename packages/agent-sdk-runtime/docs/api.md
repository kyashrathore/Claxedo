# Stable API

The reviewed surface is `docs/api-manifest.json`; `bun run check:api-manifest`
verifies that every entrypoint below exists and `bun run verify:publish` checks
the declaration hashes. Everything not listed there is internal.

## `@claxedo/agent-sdk-runtime`

Harness identity: `AGENT_HARNESS_DEFINITIONS`, `AGENT_HARNESS_IDS`, `AGENT_HARNESS_KEYS`, `AGENT_HARNESS_ACCESSES`, `harnessDefinition`, `harnessKey`, `isAgentHarnessId`, `isAcpConnectionId`, `normalizeHarnessIdentity`, `normalizeAgentHarnessTransport`, `connectionIdForHarness`.

Session config: `resolveSessionModel`, `defaultSessionModel`, `resolveTurnSystem`, `admitSessionInstructions`, `SESSION_INSTRUCTIONS_MAX_BYTES`, `sessionInstructionsByteLength`, `IMMUTABLE_SESSION_CONFIG_FIELDS`, `parseSessionModelGroup`, `parseStoredSessionModelGroup`, `sessionModelGroupJson`, `HARNESS_EFFORT_LEVELS`, `harnessEffortVerdict`, `isHarnessEffortLevel`, `NO_HARNESS_EFFORT`, `HARNESS_INSTRUCTION_CHANNELS`.

Titles: `acceptsSessionTitle`, `boundSessionTitleSource`.

Permission ceilings: `AUTO_LEVEL_ORDER`, `comparePermissionLevels`, `isAutoLevel`, `narrowerPermissionLevel`, `permissionCeilingAdmits`, `permissionModeLevel`, `widestPermissionModeUnder`, `PermissionCeilingError`, `isPermissionCeilingError`.

Goals: `GOAL_ACTIONS`, `GOAL_OPTIONAL_FIELDS`, `goalCapabilities`, `goalActionAvailable`, `requireGoalAction`, `GoalCapabilityError`, `RUNTIME_GOAL_STATUSES`, `isRuntimeGoalStatus`.

Provider projections (also on `./provider-projection`): `providerProjection`, `providerProjectionRecord`, `providerProjectionKey`, `providerBinding`, `liveProviderBinding`, `projectionRenewalDue`, `projectionRenewalDueAt`, `isProviderUnavailable`, `ProviderCredentialUnavailableError`, `ProviderProjectionExpiredError`.

Errors and status: `classifyFirstTurnError`, `firstTurnErrorData`, `FIRST_TURN_ERROR_CLASSES`, `chunk`, `live`, `recovering`.

Session handoff: `renderSessionHandoff`, `renderSessionTranscript`.

Types: `AgentSession`, `AgentMessage`, `AgentPermission`, `AgentQuestion`, `AgentTurnOutcome`, `PromptInput`, `PromptModel`, `PromptDelivery`, `SessionConfig`, `SessionConfigRequestUpdate`, `SessionHarness`, `SessionModelGroup`, `HarnessCapabilities`, `HarnessConnectionDescriptor`, `HarnessConnectionCapabilities`, `ConnectionSecretLease`, `ConnectionSecretResolver`, `AgentRuntimeStreamEvent`, `RuntimeDirectory`, `CompatEvent`, `CompatEnvelope`.

## `@claxedo/agent-sdk-runtime/compat-events`

Builders for every client-presentation frame (`messageUpdated`, `messagePartUpdated`, `messageCompleted`, `sessionIdle`, `sessionError`, `sessionUpdated`, `sessionDeleted`, `sessionUsage`, `permissionAsked`, `permissionReplied`, `questionAsked`, `questionReplied`, `questionRejected`, `todoUpdated`, …), `toCompatEvent` from a canonical event, `buildUserMessage`/`buildAssistantMessage`/`buildSession`, `eventSessionId`, `isRetainedCompatEvent`, `readRecordedPart`, `withDir`.

## `@claxedo/agent-sdk-runtime/status`

`live(row, recoverMessage)`, `chunk`, `recovering`, `StatusCompat`.

## `@claxedo/agent-sdk-runtime/message-page`

`projectLatestSurfaceMessages`, `AgentMessagePageError`, and the page types `AgentMessagePage`, `AgentMessagePageInput`, `AgentMessageReadInput`, `AgentTurnCoverage`, `AgentTurnCoveragePage`.

## `@claxedo/agent-sdk-runtime/adapters`

The store contract (`AgentRuntimeStoreWithRecovery`, `AgentRuntimeStoreCore`, `AgentRuntimeRecoveryStore`, `AgentRuntimeOwnerStore`, the row and turn input/output types, `RuntimeAppendSource`), `AgentRuntimeStaleTurnError`, `ACP_RECOVER`, `recoveryScopeKey`, `recoveryTargetSessionId`, the goal capability helpers and `AgentMessagePageError`.

## Stores

`./stores/memory`: `MemoryRuntimeStore`, `createMemoryRuntimeStore`. `./stores/sqlite`: `SqliteRuntimeStore`, `createSqliteRuntimeStore`, `RuntimeStoreCorruptionError`, `UnsupportedRuntimeStoreSchemaError`, `RecoveryOperationIdCollisionError`. `./stores/session-start`: `sqliteSessionStarts`.
