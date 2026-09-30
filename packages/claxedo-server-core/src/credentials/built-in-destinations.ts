/**
 * Where a provider's binding is allowed to reach, and what the broker puts on
 * the request when it gets there.
 *
 * A provider absent from this table gets no binding at all, so adding a harness
 * to the broker means adding its row here and nowhere else. The vendor's host,
 * its allowed methods and paths, and the header shape it accepts are all one
 * fact about that vendor, which is why they are one row.
 */

import type { BindingInjection } from "@claxedo/egress-broker"
import { credentialSecretMaterial, isSubscriptionKind } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialKind } from "@claxedo/server-core/credentials/types"

export type ProviderDestination = {
  origin: string
  methods: readonly string[]
  pathPrefixes: readonly string[]
  exactPaths?: readonly string[]
  exchange?: Readonly<{ method: string; path: string; tokenField: string }>
  /**
   * Where the vendor's API root sits under the binding path. A harness whose
   * client appends the whole vendor path itself (Claude Code, the Cursor SDK)
   * configures the binding root; one that is configured with an API root
   * (Codex, Pi, the OpenCode engine) appends this to it.
   */
  apiPath: string
  injection: BindingInjection
  /**
   * The query names this vendor accepts a credential in, absent when it
   * accepts none. Only the broker can act on it — a request filling the slot
   * is refused there — but which slots a vendor honours is one more fact about
   * the vendor, so it is stated in the vendor's row.
   */
  credentialQuerySlots?: readonly string[]
  /** What the broker injects, which is the token inside a stored login document. */
  value: string
}

/**
 * Which slot a harness must put the credential in, read from the header the
 * vendor accepts it in. Every delivery path answers this question about the
 * same row, so the row answers it once.
 */
export function destinationAuthMode(
  destination: Pick<ProviderDestination, "injection">,
): "api-key" | "bearer" {
  return destination.injection.header.toLowerCase() === "authorization" ? "bearer" : "api-key"
}

export type ProviderRow = (material: {
  token: string
  accountId?: string
  form: "api-key" | "subscription"
}) => Omit<ProviderDestination, "value">

const anthropicDestination: ProviderRow = (material) => ({
  origin: "https://api.anthropic.com",
  // The routes a turn needs and no others. `/v1/messages` also covers
  // `/v1/messages/count_tokens`, which the CLI calls before a long prompt;
  // `/v1/models` is the catalog it reads to resolve a model alias. The whole
  // `/v1/` version would additionally open the Files, Batches and
  // organization-admin APIs to anything sharing the sandbox.
  methods: ["POST", "GET"],
  pathPrefixes: ["/v1/messages", "/v1/models"],
  apiPath: "/v1",
  injection: material.form === "subscription"
    ? { header: "Authorization", scheme: "Bearer" }
    : { header: "x-api-key" },
})

/**
 * A ChatGPT subscription is not served by the API host at all: its Codex
 * traffic answers on `chatgpt.com/backend-api/codex`, and the account header is
 * what tells that backend which plan the token spends — the same pair the
 * credential verification probe sends.
 */
const openaiDestination: ProviderRow = (material) => material.form === "subscription"
  ? {
    origin: "https://chatgpt.com",
    methods: ["POST", "GET"],
    // The turn itself, and the catalog the app-server reads to check a model is
    // eligible on this plan (`?client_version=`). Nothing else under
    // `/backend-api/codex/` belongs to a turn.
    pathPrefixes: ["/backend-api/codex/responses", "/backend-api/codex/models"],
    apiPath: "/backend-api/codex",
    injection: {
      header: "Authorization",
      scheme: "Bearer",
      // Declared even when the login names no account: the name is this row's,
      // so the harness's own value never travels beside the operator's token.
      headers: { "ChatGPT-Account-Id": material.accountId ?? null },
    },
  }
  : {
    origin: "https://api.openai.com",
    methods: ["POST", "GET"],
    // `responses` is Codex's wire API; `chat/completions` is what the
    // OpenAI-compatible clients the OpenCode engine and Pi build on send; both
    // resolve a model alias against the catalog. The whole `/v1/` would also
    // open Files, Assistants, fine-tuning and Batches.
    pathPrefixes: ["/v1/responses", "/v1/chat/completions", "/v1/models"],
    apiPath: "/v1",
    injection: { header: "Authorization", scheme: "Bearer" },
  }

/**
 * `api2.cursor.sh` is the host the installed SDK's `CURSOR_BACKEND_URL` default
 * names for the agent itself: the API-key exchange and the Connect services the
 * turn runs over. The cloud REST host (`api.cursor.com`, the model catalog) is
 * a different origin the same variable also redirects, so a brokered Cursor
 * turn cannot read that catalog and falls back to its default model.
 */
const cursorServiceMethods = [
  ["agent.v1.AgentService", `
    Run RunSSE RunPoll NameAgent UpdateConversationMetadata CreateTranscriptOverview GetUsableModels
    GetDefaultModelForCli GetAllowedModelIntents UploadConversationBlobs
    UploadLocalAgentRunToPromptQuality GetSignedUrlForAttachedMedia NotifyConversationClone
    GetNewChatNudgeLegacyModelPicker GetNewChatNudgeParameterizedModelPicker GetPromptContextUsage
    ListLocalSubscriptionTools CallLocalSubscriptionTool StreamLocalAgentMailbox
  `],
  ["aiserver.v1.BidiService", `
    BidiAppend
  `],
  ["aiserver.v1.DashboardService", `
    GetTeams GetMe ListCollapseCandidates GetUnificationIntent UpsertUnificationIntent
    StartUnifyGrokOAuth CompleteUnifyGrokOAuth StartUnifyXLogin CompleteUnifyXLogin
    StartCollapseSourceProof CompleteCollapseSourceProof ProvisionUnifyGrokAccount
    FinalizeIndividualUnification GetOrCreateXaiUnificationIntent GetXaiUnificationIntent
    SelectXaiUnificationCursorAccount ListXaiUnificationCollapseCandidates
    StartXaiUnificationCursorAccountProof CompleteXaiUnificationCursorAccountProof
    AdvanceXaiUnificationIntent GetAgenticOnboardingConfig GetUserOrganizations
    GetTeamLinkedOrganization SetUserDefaultTeam GetOrganizationMembers GetOrganizationMember
    ListOrganizationIdentityProviders UpdateOrganizationIdentityProviderSsoSettings
    SetOrganizationIdentityProviderAllowDomainJoin AddOrganizationIdentityProviderDomainJoin
    RemoveOrganizationIdentityProviderDomainJoin MergeOrganizationIdentityProvider
    PreflightMergeOrganizationIdentityProvider GetOrganizationMergeIdpRequest
    ListOrganizationMergeIdpRequests MoveOrganizationMemberToTeam SetOrganizationMemberTeams
    RemoveOrganizationMember BulkMoveOrganizationMembers StartBulkMoveOrganizationMembers
    GetBackgroundJob SetOrganizationMemberRole UpdateOrganization UpdateOrganizationTeam
    CreateOrganizationTeam PreviewOrganizationTeamSettingsCopy GetOrganizationTeamAdminCandidates
    GetDirectoryGroups UpdateDirectoryGroupSettings GetOrganizationGroups GetOrganizationGroup
    GetOrganizationGroupMembers CreateOrganizationGroup UpdateOrganizationGroup DeleteOrganizationGroup
    AddOrganizationGroupMembers RemoveOrganizationGroupMembers UpdateOrganizationGroupMember
    GetOrganizationGroupServiceAccountMembers GetOrganizationServiceAccounts
    AddOrganizationGroupServiceAccounts RemoveOrganizationGroupServiceAccounts
    GetOrganizationGroupAutorunSettings UpdateOrganizationGroupAutorunSettings
    GetOrganizationGroupMcpSettings UpdateOrganizationGroupMcpSettings
    ResetOrganizationGroupAgentRunModeToAutoReview GetOrganizationGroupModelAllowlist
    UpdateOrganizationGroupModelAllowlist GetOrganizationGroupAutoReviewSettings
    UpdateOrganizationGroupAutoReviewSettings GetOrganizationGroupSmartAutoSettings
    UpdateOrganizationGroupSmartAutoSettings CreateOrganizationGroupAnthropicCyberEnrollmentUrl
    RequestOrganizationGroupAnthropicEfs RequestOrganizationAnthropicEfs
    GetOrganizationAnthropicEfsStatus ReviewAnthropicEfsRequestInternal GetTeamGroups GetTeamGroup
    GetTeamGroupMembers CreateTeamGroup UpdateTeamGroup DeleteTeamGroup AddTeamGroupMembers
    RemoveTeamGroupMembers UpdateTeamGroupMember GetTeamGroupAutorunSettings
    UpdateTeamGroupAutorunSettings GetTeamGroupMcpSettings UpdateTeamGroupMcpSettings
    ResetTeamGroupAgentRunModeToAutoReview GetTeamGroupModelAllowlist UpdateTeamGroupModelAllowlist
    GetTeamGroupAutoReviewSettings UpdateTeamGroupAutoReviewSettings GetTeamSandNetworkSettings
    GetTeamGrokBotTrial UpdateTeamSandNetworkSettings GetTeamGroupSandNetworkSettings
    UpdateTeamGroupSandNetworkSettings GetTeamGroupGrokBotCapabilities
    UpdateTeamGroupGrokBotCapabilities GetTeamGroupSmartAutoSettings UpdateTeamGroupSmartAutoSettings
    CreateTeamGroupAnthropicCyberEnrollmentUrl RequestTeamGroupAnthropicEfs GetTeamAnthropicEfsStatus
    ListTeamGroupScimDirectories ListTeamGroupScimGroupsFromUpstream ListTeamGroupScimTargetMappings
    CreateTeamGroupScimTargetMapping DeleteTeamGroupScimTargetMapping GetGroups GetGroupMembers
    CreateGroup UpdateGroup DeleteGroup AddGroupMembers RemoveGroupMembers BulkAssignGroupMembers
    PreviewAttachGroupToDirectory DetachGroupFromDirectory GetScimConflicts ListScimDirectories
    GetOrganizationScimConfigurationLinks CreateScimDirectory UpdateScimDirectorySyncSettings
    DeleteScimDirectory ListScimGroupsFromUpstream ListScimTargetMappings
    ListOrganizationGroupTargetMappings CreateScimTargetMapping DeleteScimTargetMapping
    GetActivationCheckoutUrl CheckPromotionEligibility ActivatePromotion GetTeamCustomerPortalUrl
    CancelPendingTeamSubscriptionNow CreatePendingTeamProCheckout GetTeamPrepaidBilling
    SetTeamPrepaidAutoTopUp CreatePrepaidTopUp GetUserPrepaidBilling SetUserPrepaidAutoTopUp
    CreateUserPrepaidTopUp GetTeamMembers SendTeamInvite GetTeamInviteLink AcceptInvite
    GetTeamInviteMetadata ListContactImportConnections GetGoogleContactImportAuthUrl
    ConnectGoogleContactImportCallback ListContactImportContacts GetContactImportAvatar
    DisconnectContactImportConnection CreateTeam GetJoinableTeamsByDomain JoinTeamByDomain
    UpdateTeamDomainJoinSetting GetTeamMemberDomains GetTeamIdForReactivation ChangeSeat
    ChangeTeamSubscription ConnectGithubCallback RegisterGithubCursorCode PrepareGithubConnectFlow
    CompleteGithubConnectFlow DisconnectGithub PrepareSetupGithubEnterpriseApp
    FinishSetupGithubEnterpriseApp ListGithubEnterpriseApps DeleteGithubEnterpriseApp
    SetupGitlabEnterpriseInstance ListGitlabEnterpriseInstances
    SetGitlabEnterpriseHostControlledServiceAccountToken RotateGitlabEnterpriseWebhookSecret
    DeleteGitlabEnterpriseInstance SetupBitbucketServerInstance ListBitbucketServerInstances
    UpdateBitbucketServerInstanceToken DeleteBitbucketServerInstance SyncGitlabRepos
    GetGitlabReposSyncStatus UpdateRole RemoveMember GetMemberRemovalInsights GetSignUpType GetHardLimit
    SetHardLimit GetSpendLimitPolicy SetSpendLimitPolicy GetOrgTeamBudgets SetOrgTeamBudget
    GetOrgDailySpendByCategory EnableOnDemandSpend DeleteAccount StartAccountCollapseRun
    GetAccountCollapseRun StartAccountCollapseRunInternal GetAccountCollapseRunInternal
    StartCursorAccountCollapse GetCursorAccountCollapseByTarget StartCursorSessionAccountCollapse
    GetCursorSessionAccountCollapse ListCursorSessionAccountCollapseCandidates SendDownloadEmail
    GetMonthlyInvoice ListInvoiceCycles GetDailySpendByCategory GetPricingHistory
    ListBackgroundComposerSecrets CreateBackgroundComposerSecret CreateBackgroundComposerSecretBatch
    RevokeBackgroundComposerSecret UpdateBackgroundComposerSecret GetMcpConfig
    GetEffectiveMcpConfigForUser GetAvailableMcpServers GetMcpServerUsageSummary SetMcpConfig
    UpdateUserDefaultMcpSettings MarkMcpServersSeen StoreMcpOAuthToken GetMcpOAuthTokens
    ListSandMcpTools PreviewTeamMcpTools ExecuteSandMcpTool ClassifySandAutoReview RecordSandAuditEvents
    McpOAuthRefreshLockBegin McpOAuthRefreshLockRelease DeleteMcpOAuthToken ValidateMcpOAuthTokens
    CheckHttpMcpStatus StoreMcpOAuthPendingState GetMcpOAuthPendingState RenameMcpOAuthAccount
    DeleteMcpOAuthAccount CompleteMcpOAuth GetPluginMcpConfig BatchGetPluginMcpConfig
    AddMcpServersFromPlugin MoveUserMcpServerToTeam GetTeamMcpPlacementDefault
    UpdateTeamMcpPlacementDefault MigrateTeamMcpServersToDefaultMarketplace ProbeMcpUrl
    CreateTeamWithFreeTrial CreateTeamWithOrg GetTeamHasValidPaymentMethod GetTeamPrivacyModeForced
    SwitchTeamPrivacyMode UpdateFastRequests GetFastRequests GetDownloadLink GetCliDownloadUrl
    GetSsoConfigurationLinks GetScimConfigurationLinks SetAdminOnlyUsagePricing
    GetYearlyUpgradeEligibility UpgradeToYearly GetEnterpriseCTAEligibility GetUsageBasedPremiumRequests
    SetUsageBasedPremiumRequests GetReferrals GetReferralCodes CreateP2PReferralLink
    GetP2PReferralStatus SendP2PReferralInvites GetP2PReferralHistory CheckReferralAllowlist
    CheckReferralCode RedeemGiftCode GetEventCodeInfo RedeemEventCode GetTeamRepos
    GetTeamReposOrEmptyIfNotInTeam GetTeamRules CreateTeamRule UpdateTeamRule DeleteTeamRule
    GetTeamGroupRules CreateTeamGroupRule UpdateTeamGroupRule DeleteTeamGroupRule GetTeamHooks
    CreateTeamHook UpdateTeamHook DeleteTeamHook GetTeamCommands CreateTeamCommand UpdateTeamCommand
    DeleteTeamCommand GetGlobalCommands GetRepoSlashCommands GetBackgroundComposerSlashCommands
    GetCloudAgentPluginsSnapshot GetBugbotTeamRules CreateBugbotTeamRule UpdateBugbotTeamRule
    DeleteBugbotTeamRule GetBugbotLearnedRules UpdateBugbotLearnedRule DeleteBugbotLearnedRule
    CreateBugbotManualRepositoryRule GetBugbotManualRepositoryRules UpdateBugbotManualRepositoryRule
    DeleteBugbotManualRepositoryRule RunDiamondToBugbotMigration GetBugbotRuleAnalytics
    GetBugbotRuleById CreateTeamRepo DeleteTeamRepo AddRepoPattern RemoveRepoPattern SetTeamRepoType
    GetTeamAdminSettings GetTeamAdminSettingsOrEmptyIfNotInTeam GetBaseTeamAdminSettings
    GetTeamOriginDisabled UpdateTeamAdminSettings GetTeamCustomerTelemetryDestinations
    CreateTeamCustomerTelemetryDestination UpdateTeamCustomerTelemetryDestination
    DeleteTeamCustomerTelemetryDestination TestTeamCustomerTelemetryDestinationConnection
    GetTeamCustomerTelemetryDestinationHealth GetTeamCustomerTelemetryContentExportOptIn
    UpdateTeamCustomerTelemetryContentExportOptIn GetTeamLlmGatewayCredentialStatus
    SetTeamLlmGatewayCredential ReplaceTeamLlmGatewayCredential ClearTeamLlmGatewayCredential
    SetTeamNoZdrModelConsent SetOrganizationNoZdrModelConsent GetOrganizationOnDemandSpendDisabled
    SetOrganizationOnDemandSpendDisabled GetOrganizationCreditRequestButtonHidden
    SetOrganizationCreditRequestButtonHidden GetOrganizationRemoteControlSettings
    UpdateOrganizationRemoteControlSettings SetUserNoZdrModelConsent SetTeamMemberNoZdrModelConsent
    GetNoZdrModelConsentStatus UpdateTeamInviteLinkTTLSetting UpdateTeamMemberInviteSetting
    UpdateTeamSandOnboardingCompleted UpdateTeamSandSetupChecklistItem MarkTeamSandOnboardingSeen
    GetTeamGrokBotEligibleUserIds SendTeamSandOnboardingInvites GetProtectedGitScopes
    CreateProtectedGitScope DeleteProtectedGitScope CreateTeamFreeTrialCode
    CreateTeamFreeTrialCodeInternal SetTrialSpendLimitOverrideInternal GetTrialSpendLimitInternal
    GetOrganizationEnterpriseTrialExtendContextInternal ApplyOrganizationEnterpriseTrialEndInternal
    GetXaiUserUsageSnapshot GetXaiUserPrepaidBilling SetXaiUserPrepaidAutoTopUp
    GetXaiCommerceBearerToken GetTeamOffboardingConfigInternal UpdateTeamOffboardingConfigInternal
    CreateTeamCreditGrantInternal ListTeamCreditGrantsInternal CreateTeamsTrialV2ReferralCode
    GetTeamAnalytics GetUserAnalytics GetTeamRawData GetClientUsageData GetCurrentPeriodUsage
    UseSandBankedReset ListSandBankedResets GetSandUsageStatus StartSandTrial IsEligibleForSandTrial
    GetSandTrialClaimStatus CancelSandTrial GetSandAccessStatus GetSandMarketingIdentity
    RegisterSandMachine ListSandMachines UpdateSandMachineLabel UpdateSandMachineLocalToolPermission
    GetSandMachineMessagesEnabled UpdateSandMachineMessagesEnabled RequestSandTeamAccess
    ListPendingUserAccessRequests GetUsageSignalsProjectionSnapshot GetPlanInfo VerifyAppleTransaction
    VerifyGooglePlayPurchase GetGooglePlayBillingAccountId InspectGooglePlaySubscriptionInternal
    InspectGooglePlayTransactionsInternal GetCursorReviewEntitlement SearchOriginReviewPeople
    GetOriginReviewPreferences SetOriginReviewPreferences GetUsageLimitPolicyStatus
    GetUsageLimitStatusAndActiveGrants GetCreditGrantsBalance GetClientVisibleCreditGrants
    GetAdvancedAnalyticsEnabled GetTokenUsage ValidateBedrockIamRole GetTeamSpend
    GetTeamSeatUpgradeRecommendations GetPendingSeatTierUpgradeRequests GetCurrentBillingCycle
    GetMonthlyBillingCycle GetBugbotSettings GetBugbotAnalyticsV2 GetBugBotPRAnalytics
    GetGithubInstallations GetGithubInstallationTenantGrants GrantGithubInstallationTenant
    RevokeGithubInstallationTenant GetBugbotSuggestedRepos GetScmConnectionStatus
    GetGithubRepoAccessStatus GetScmConnectionStatuses GetInstallationRepos FetchAllInstallationRepos
    GetInstallationGithubUsers GetUserAdminOrganizations GetTeamGithubUsers AddGithubUsersToTeam
    ResolveGithubIdentities GetUserPullRequests GetUserReviewRequests GetPullRequestForBranch
    UpdateGithubRepoSettings UpdateGithubInstallationSettings UpdateAllGithubRepoSettings
    UpdateGithubInstallationTeamScope UpdateSelfGithubAllowlist GetTeamBugbotSettings
    UpdateTeamBugbotSettings MigrateTeamBugbotToUsageBasedBilling GetBugbotMergedPrScanSummary
    GetBugbotMode UpdateBugbotMode GetBugBotProUserMode UpdateBugBotProUserMode GetBugbotUserSettings
    UpdateBugbotUserSettings GetFullSelfDrivingUserSettings UpdateFullSelfDrivingUserSettings
    ListFullSelfDrivingRepoSettings SetFullSelfDrivingRepoEnabled GetFullSelfDrivingTeamSettings
    UpdateFullSelfDrivingTeamSettings ListFullSelfDrivingTeamRepoSettings
    SetFullSelfDrivingTeamRepoEnabled ListFullSelfDrivingActiveAgents
    ListFullSelfDrivingTeamActiveAgents UpdateFullSelfDrivingPrConfig GetBugBotProUserSettings
    UpdateBugBotProUserSettings MigrateBugBotProUserToUsageBasedBilling GetGlassEarlyPreviewEnrollment
    EnrollInGlassEarlyPreview UnenrollFromGlassEarlyPreview RecordBugbotDeeplinkEvent
    RecordBugbotDeeplinkEventUnauthenticated RevokeBugBotLicenses RevokeUserBugbotLicense
    StartBugbotBackfillLearning GetBugbotBackfillStatus SetSlackAuth GetSlackTeamSettings
    UpdateSlackTeamSettings GetSlackSettings GetSlackModelOptions GetSlackInstallUrl
    GetSlackInstallUrlPublic GetSlackInstallUrlPublicWithUserScopes GetFilteredUsageEvents
    GetAggregatedUsageEvents GetAuditLogs GetOrganizationAuditLogs ListTeamDataExports
    CreateTeamDataExportDownloadUrl GetUserPrivacyMode SetUserPrivacyMode
    WebAcknowledgeGracePeriodDisclaimer SkipPrivacyModeGracePeriod NeedsPrivacyModeMigration
    UpdateTeamPrivacyModeMigrationOptOut ShareConversation GetSharedConversation
    GetPublicSharedConversation ListSharedConversations DeleteSharedConversation
    UpdateSharedConversationVisibility ShareCanvas GetSharedCanvas GetPublicSharedCanvas
    ListSharedCanvases DeleteSharedCanvas LookupSharedCanvasByKey ListUserCanvases GetCanvasMetadata
    GetCanvasPayload SetCanvasVisibility DeleteCanvas GetTeamSharedConversationSettings
    UpdateTeamSharedConversationSettings GetTeamSharedCanvasSettings UpdateTeamSharedCanvasSettings
    GetTeamProjectsSettings UpdateTeamProjectsSettings GetTeamPublicProfileSettings
    UpdateTeamPublicProfileSettings GetTeamSandShareBotExportSettings
    UpdateTeamSandShareBotExportSettings UpdateTeamGrokBotCapabilities
    GetTeamSandHibernatedOwnerVmTerminationSettings UpdateTeamSandHibernatedOwnerVmTerminationSettings
    GetTeamSmartAutoSettings UpdateTeamSmartAutoSettings GetTeamPromptCachingSettings
    UpdateTeamPromptCachingSettings ResetTeamAgentRunModeToAutoReview GetUserSmartAutoSettings
    UpdateUserSmartAutoSettings GetTeamBackgroundAgentSettings UpdateTeamBackgroundAgentSettings
    GetRepoSourcePreference UpdateUserRepoSourcePreference UpdateTeamRepoSourcePreference
    ResolvePrCreationForge RevokeTeamInviteLink ListTeamInviteLinks UpdateUserName
    UploadUserProfilePicture UpdateUserProfilePicture ListInvoices ListBlockingCheckoutInvoices
    ListPayableTeamInvoices GetRemainingRefunds GetServiceAccountSpendLimit SetServiceAccountSpendLimit
    SetUserHardLimit SetUserMonthlyLimit ToggleMarketingEmailOpt GetMarketingEmailOpt
    GetGlobalLeaderboardOptIn SetGlobalLeaderboardOptIn CreateTeamApiKey RevokeTeamApiKey
    ListTeamApiKeys CreateOrganizationApiKey RevokeOrganizationApiKey ListOrganizationApiKeys
    CreateAutomationWebhookApiKey CreateTeamServiceAccount ListTeamServiceAccounts
    DeleteTeamServiceAccount ArchiveTeamServiceAccount RotateServiceAccountApiKey
    GetTeamRepositoriesForServiceAccountScope UpdateServiceAccountRepoScope CreateUserApiKey
    RevokeUserApiKey ListUserApiKeys ConfirmGithubInstallation UpdateTeamName
    UpdateTeamDashboardAnalyticsSetting UpdateTeamOriginSetting
    UpdateTeamScimRequireUserDirectorySetting GetTeamScimRequireUserDirectoryPreview
    GetEffectiveUserAgentStoreSkillsSettings UpdateUserAgentStoreSkillsSettings GetSlackUserSettings
    UpdateSlackUserSettings GetSlackRepoRoutingRules CreateSlackRepoRoutingRule
    UpdateSlackRepoRoutingRule DeleteSlackRepoRoutingRule GetSlackDefaultWorkerRules
    SetSlackDefaultWorkerRule DeleteSlackDefaultWorkerRule IsOnNewPricing GetLinearAuthUrl
    ConnectLinearCallback GetMicrosoftTeamsLinkContext SetMicrosoftTeamsAuth GetLinearStatus
    DisconnectLinear GetLinearTeams GetLinearSettings UpdateLinearTeamSetting UpdateLinearProjectSetting
    GetLinearLabels GetLinearIssues BatchGetLinearIssueSummaries GetXaiTeamLinkStatus StartXaiTeamLink
    ConfirmXaiTeamLink CancelXaiTeamLinkProposal UnlinkXaiTeam GetXaiCursorTeamMergeStatus
    GetXaiCursorTeamMembershipPreview StartXaiCursorTeamMerge ConfirmXaiCursorTeamMerge
    PrepareXaiCursorTeamMergeCheckout FinalizeXaiCursorTeamMergeCheckout EnsureXaiCursorTeamForMerge
    CancelXaiCursorTeamMergeProposal TransferXaiCredits GetXaiCreditTransferStatus
    ListXaiCreditTransfers GetPagerDutyAuthUrl ConnectPagerDutyCallback GetPagerDutyStatus
    GetPagerDutyServices DisconnectPagerDuty GetJiraInstallUrl LinkJiraInstallation GetJiraStatus
    ListJiraInstallations GetBitbucketForgeStatus DisconnectJira DisconnectBitbucketForge
    GetJiraProjects GetJiraTeamSettings UpdateJiraTeamSettings GetJiraRoutingRules CreateJiraRoutingRule
    UpdateJiraRoutingRule DeleteJiraRoutingRule LinkJiraUser ListJiraUserLinks UnlinkJiraUser
    DeleteBedrockIamRole UnlinkSlackAccess ListSlackConversations ListMicrosoftTeamsChannels
    GetSlackConversationsByIds LogSlackbotAuthConversionFunnel LogClickedConnectSlack
    CheckUserApiKeyAccess IsAllowedFreeTrialUsage IsNextSetupRunFree CompletedLinkSlackAccount
    NotifyBugbotTeamAdmins GetAdminNotificationStatus OptOutNewPricing SubmitFeedback SubmitFeedbackAnon
    SubmitRepositoryProtectionClaim ActivateRepositoryProtectionInvite GetActiveOffboardingBanner
    ClientAction ListUsageAlerts CreateUsageAlerts DeleteUsageAlerts UpdateUsageAlerts
    RequestIndividualLimitsOptOut ListMarketplacePlugins ListPublisherPublicPlugins GetUserProfile
    UpdateUserProfile ClaimUserProfileHandle GetPublicProfileByHandle GetViewableProfileByHandle
    GetTeamMemberProfileByHandle GetPlugin CreatePlugin UpdatePluginMcpConfig PublishPlugin
    UnpublishPlugin ParseGitHubRepoForPlugins ParsePluginPublisherRepoInternal
    PreviewReindexPluginRepoInternal ApplyReindexPluginRepoInternal
    PreviewMigrateReindexPluginRepoInternal ApplyMigrateReindexPluginRepoInternal
    UpdateTeamMarketplaceOriginDistributionInternal CreateSupportImpersonationSessionInternal
    RemoveOrganizationMemberInternal SubmitPluginForApproval ApprovePlugin RejectPlugin
    ListUserPluginInstalls InstallUserPlugin UpdateUserPluginInstall UninstallUserPlugin
    ListTeamPluginInstalls GetTeamPluginPopularity GetTeamPluginPrimitiveUsage
    ListTeamAvailableMarketplacePlugins GetTeamPinnedMarketplacePlugins
    UpdateTeamPinnedMarketplacePlugins InstallTeamPlugin UpdateTeamPluginInstall UninstallTeamPlugin
    GetEffectiveUserPlugins ResolvePluginsByRef ListMarketplaces AddMarketplace
    GetOrCreateDefaultTeamMarketplace UpdateMarketplace RemoveMarketplace RefreshMarketplace
    ReindexAndApplyTeamMarketplaceChanges RegisterMarketplaceAndPlugins UpdateTeamMarketplaceConfig
    SetTeamMarketplaceRepository SetMarketplaceOriginDistribution GetMarketplaceOriginDistributionStatus
    SetTeamMarketplacePluginPolicies SetTeamMarketplacePluginPolicyVariables
    ApplyTeamMarketplaceRequiredPlugins LinkPluginsToTeamMarketplace UnlinkPluginsFromTeamMarketplace
    PreviewTeamMarketplaceMcpImpact GetManagedSkills GetCursorUserState SetJobData
    ListFinancialConnections ListFinancialAccounts DeleteFinancialConnection StartFinancialLink
  `],
  ["aiserver.v1.ServerConfigService", `
    GetServerConfig ResolveNewRepoFlowBackendProbe GetNewRepoFlowConfig
  `],
] as const

const cursorDestination: ProviderRow = () => ({
  origin: "https://api2.cursor.sh",
  methods: ["POST", "GET"],
  pathPrefixes: [],
  exactPaths: [
    "/auth/exchange_user_api_key",
    "/v1/models",
    ...cursorServiceMethods.flatMap(([service, methods]) =>
      methods.trim().split(/\s+/).map((method) => `/${service}/${method}`)),
  ],
  exchange: { method: "POST", path: "/auth/exchange_user_api_key", tokenField: "accessToken" },
  apiPath: "",
  injection: { header: "Authorization", scheme: "Bearer" },
})

/**
 * The OpenAI-compatible model vendors the OpenCode engine and Pi define
 * providers for.
 *
 * A provider with no row here reaches them not at all, so a row is what makes
 * each of these accounts usable. Each one is the vendor's own API root and the
 * header its SDK sends the key in.
 */
const openAiCompatibleDestination = (input: {
  origin: string
  apiPath: string
  header?: string
  scheme?: string
  credentialQuerySlots?: readonly string[]
}): ProviderRow => () => ({
  origin: input.origin,
  methods: ["POST", "GET"],
  pathPrefixes: [`${input.apiPath}/`],
  apiPath: input.apiPath,
  injection: input.header
    ? { header: input.header }
    : { header: "Authorization", scheme: "Bearer" },
  ...(input.credentialQuerySlots ? { credentialQuerySlots: input.credentialQuerySlots } : {}),
})

const PROVIDER_ROWS: Record<string, ProviderRow> = {
  anthropic: anthropicDestination,
  "claude-sdk": anthropicDestination,
  openai: openaiDestination,
  "codex-app-server": openaiDestination,
  cursor: cursorDestination,
  "cursor-sdk": cursorDestination,
  openrouter: openAiCompatibleDestination({ origin: "https://openrouter.ai", apiPath: "/api/v1" }),
  // Gemini takes its key in its own header rather than a bearer, and answers
  // `?key=` just as readily — the one vendor here that spends whatever the URL
  // carries instead of the injected account.
  google: openAiCompatibleDestination({
    origin: "https://generativelanguage.googleapis.com",
    apiPath: "/v1beta",
    header: "x-goog-api-key",
    credentialQuerySlots: ["key"],
  }),
  groq: openAiCompatibleDestination({ origin: "https://api.groq.com", apiPath: "/openai/v1" }),
  xai: openAiCompatibleDestination({ origin: "https://api.x.ai", apiPath: "/v1" }),
}


export function builtInProviderRow(providerId: string): ProviderRow | undefined {
  return Object.hasOwn(PROVIDER_ROWS, providerId) ? PROVIDER_ROWS[providerId] : undefined
}

export function builtInProviderDestinationShape(input: {
  providerId: string
  kind: CredentialKind
}): Omit<ProviderDestination, "value"> | undefined {
  return builtInProviderRow(input.providerId)?.({ token: "", form: isSubscriptionKind(input.kind) ? "subscription" : "api-key" })
}

export function builtInProviderDestination(input: {
  providerId: string
  kind: CredentialKind
  secret: string
}): ProviderDestination | undefined {
  const row = builtInProviderRow(input.providerId)
  if (!row) return undefined
  const material = credentialSecretMaterial({ kind: input.kind, secret: input.secret })
  if (!material) return undefined
  return { ...row(material), value: material.token }
}
