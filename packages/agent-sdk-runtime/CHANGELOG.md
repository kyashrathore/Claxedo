# @claxedo/agent-sdk-runtime

Public-API changes per export-map entrypoint. `scripts/verify-publish.ts`
hashes each entrypoint's reachable declaration closure against
`docs/api-manifest.json`; an entry here records what a re-recorded hash
covers. Commits are on `dev`.

## 0.8.0 (unreleased; declaration baseline re-recorded 2026-09-15 over 27ceb6bd02)

### Breaking

- `@claxedo/agent-sdk-runtime`: removed `SDK_MODEL_CATALOG`, `isSdkModelId`,
  `requireSdkModelId`, `sdkModelConfigOption`, `sdkModelOptions`,
  `SdkModelCatalog`, `SdkModelId`, and `LiveModelSource.fallbackToCatalog`;
  model lists come only from a harness that answered (19966c2cc9).
  `modelConfigOption` and `SdkModelEntry` remain.
- `@claxedo/agent-sdk-runtime/adapters`: removed `claudeAuthValue`;
  `claudeAuthEnv` now takes a `ProviderBinding` instead of a raw secret
  (9f7d6e0f22, fda8642f74).
- `@claxedo/agent-sdk-runtime/capabilities`: `HarnessCapabilities` gained
  required `effortLevels` and `instructionChannel`; `RuntimeConfigurableAdapter`
  lost `setAuth` — credentials reach a driver through `applyConfig` as a
  `ProviderProjection` (3211452d72, b477ff71b0, 9f7d6e0f22, 52eee917ff).
- `@claxedo/agent-sdk-runtime/adapters`: `AgentHarnessAdapterCore` gained a
  required `readonly instructionChannel`, and `createSession` takes a fourth
  `AgentSessionCreateOptions` argument (5c49e2dc54, b477ff71b0). Custom
  adapters must declare the channel.
- `@claxedo/agent-sdk-runtime/harnesses/pi`: `PiDriverOptions.agentDir` is
  required at the driver; `PiAdapterOptions` / `PiFactoryOptions` keep it
  optional (b4bbc82115).
- `@claxedo/agent-sdk-runtime/harnesses/codex`: `codexPluginLaunch` and
  `CodexPluginLaunch` left the driver module (737072ba3d);
  `accountIdFromClaims` moved to `@claxedo/agent-runtime-contract`
  (bea480609b).
- `@claxedo/agent-sdk-runtime/harnesses/pi`: `piAuthProjection` and
  `writePiAuth` replaced by `piProviderOverrides`, `assertPiProvidersBindable`
  and `piSpawnEnv` over a models.json overlay (a22028ff52, b4bbc82115).

### Moved (same names, now re-exported from `@claxedo/agent-runtime-contract`)

- `SessionHarness`, `SessionHarnessId`, `AgentHarnessId`, `AgentHarnessKey`,
  `AgentHarnessAccess`, `AgentHarnessDefinition`, `AgentHarnessTransport`,
  `NativeHarnessId`, `NativeSdkHarnessId`, `AGENT_HARNESS_*`,
  `harnessDefinition`, `harnessKey`, `isAgentHarnessId`, `isAcpConnectionId`,
  `normalizeHarnessIdentity`, `normalizeAgentHarnessTransport` (19966c2cc9,
  023b8b2ba5). `src/harness-types.ts` no longer exists.

### Added

- `@claxedo/agent-sdk-runtime/stores/session-start`: `sqliteSessionStarts`
  supplies the `AgentSessionStarts` contract on a host-owned SQLite database.
  Creation ownership persists independently of provider binding, and `retire`
  removes only the matching binding after successful authorized deletion.
  Both built-in stores expose this same contract through `sessionStarts`.
- Root: `acceptsSessionTitle` and `boundSessionTitleSource` expose the shared
  title-source policy used by host projections and runtime stores.

- Root: `SessionConfig.permissionCeiling` / `permissionMode` /
  `permissionState`, `AutoLevel`, `AgentPermissionMode`, and the
  `permission-ceiling` helpers (`AUTO_LEVEL_ORDER`, `comparePermissionLevels`,
  `permissionCeilingAdmits`, `PermissionCeilingError`, ...) (aee140f86c,
  8b1e49671d).
- Root: `SessionConfig.instructions` and `.group`,
  `IMMUTABLE_SESSION_CONFIG_FIELDS`, `admitSessionInstructions`,
  `SESSION_INSTRUCTIONS_MAX_BYTES`, `resolveTurnSystem`, `harnessEffortLevels`,
  `HARNESS_EFFORT_LEVELS`, `harnessEffortVerdict`, `SessionModelGroup` parsers
  (5c49e2dc54, 3211452d72, d7e3d0387a).
- Root: `SupportsSteer` / `SteerResult`, `AgentRuntime.abort(..., { turnId })`,
  `AgentRuntime.whenIdle`, `PromptDelivery` / `PromptDeliveryRequest` on turn
  input (aeb4412663, a78ec5088b, aeeff2713c).
- Root: `provider-projection` exports (`ProviderProjection`,
  `ProviderBinding`, `providerProjection`, `isProviderUnavailable`,
  `ProviderCredentialUnavailableError`, ...) (9f7d6e0f22).
- Root: `renderSessionHandoff`, `isAgentMessage` (41c6029842).
- `@claxedo/agent-sdk-runtime/adapters`: `AgentSessionCreateOptions`,
  `harnessProjection` (fda8642f74).
- `@claxedo/agent-sdk-runtime/compat-events`: `EventSessionDeleted`,
  `sessionDeleted` (656cf95af2).
- `@claxedo/agent-sdk-runtime/subagent-admission`: `SubagentObservation.attention`
  and `.wake` (aee140f86c).
- `@claxedo/agent-sdk-runtime/stores/sqlite`: `getLatestUserMessageId`, the
  `attention` / `wake` subagent columns (0ad6904970, aee140f86c).
- `@claxedo/agent-sdk-runtime/harnesses/claude`: `claudeTurnPrompt`,
  `applyClaudePermissionUpdates`, `brokeredConfigDir` option,
  `ClaudeAuthEnv.ANTHROPIC_BASE_URL` / `CLAUDE_CODE_OAUTH_SCOPES`
  (f9388371ed, aeeff2713c, 9f7d6e0f22, b93e40c261).
- `@claxedo/agent-sdk-runtime/harnesses/codex`: `brokeredHome` option
  (737072ba3d).
- `@claxedo/agent-sdk-runtime/harnesses/cursor`: `cursorTurnPrompt` takes a
  `PromptDelivery` and may return an `SDKUserMessage` (aeeff2713c).
- `@claxedo/agent-sdk-runtime/harnesses/acp`: `instructionChannel:
  "prompt-prefix"`, `createSession` options (b477ff71b0).
- Advanced driver contract (`SdkRuntimeDriver`): `steer`, `effortLevels`,
  `interactions`, `updatePermissionState`, `createRuntime(threadId, todos?)`,
  `readHarnessCapabilities(directory?)` (2917ecdf2d, 147feaf7b4, 3211452d72,
  aeeff2713c).

`@claxedo/agent-sdk-runtime/harnesses`, `/harnesses/*`, `/stores/memory`,
`/message-page` and `/runtime-event-hub` changed only through the root and
adapter types above that their closures reach.
