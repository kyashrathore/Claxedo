import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { useConfigOptional } from "@/app/providers/config"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useServer } from "@/app/connection/server"
import { DialogSelectProvider } from "@/app/dialogs/select-provider"
import { DialogConnectProvider } from "@/app/dialogs/connect-provider"
import { DialogCreateCloudProject } from "@/features/workspaces/ui/dialogs/create-cloud-project"
import {
  AIConnectSurface,
  aiConnectFailureCopy,
  createLocalOnboardingDismissals,
  createOnboardingFunnel,
  listOnboardingCredentials,
  invalidateAIConnectQueries,
  onboardingGoFurtherCards,
  onboardingHomeView,
  onboardingState,
  RemoteAccessSurface,
  useRemoteAccessController,
  verifyProviderAIConnections,
  type OnboardingStepAction,
  type OnboardingStepId,
  type SetupShellMode,
} from "@/features/onboarding"
import { SetupShell } from "@/features/onboarding/setup-shell"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { capture as captureTelemetry, identityProps } from "@/platform/telemetry/analytics"
import { sessionInventoryQueryOptions } from "@/features/session/data/sync/queries"
import type { SessionInventoryRow } from "@/features/session/data/query/types"

export function OnboardingEmptyState(props: {
  projectDirectory?: string
  fallback?: JSX.Element | false
  overlay?: boolean
  onDiagnostics?: () => void
  onNewProject?: () => void
}) {
  const platform = usePlatform()
  const server = useServer()
  const globalSDK = useGlobalSDK()
  const config = useConfigOptional()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const dismissals = createLocalOnboardingDismissals()
  const surface = () => platform.platform === "desktop" ? "desktop" : config?.sandboxEnabled ? "web" : "self-host"
  const machineId = () => `${platform.platform}:${server.url}`
  const funnel = createMemo(() => createOnboardingFunnel({
    deployment: surface() === "self-host" ? "self-host" : "hosted",
    // `step_done` carries its own `surface` and overrides the default below.
    capture: (name, properties) =>
      captureTelemetry(name, { ...identityProps(), surface: "onboarding", ...properties }),
  }))
  const remoteAccess = useRemoteAccessController({ serverUrl: server.url, emit: funnel().emit })
  const [selectedStep, setSelectedStep] = createSignal<OnboardingStepId>()
  const requestedStep = createMemo<OnboardingStepId | undefined>(() => {
    const step = searchParams.onboarding
    if (step === "project" || step === "ai" || step === "compute" || step === "remote-access") return step
  })
  const emitted = new Set<string>()
  const credentialsQuery = useQuery(() => ({
    queryKey: ["claxedo", "onboarding", "credentials", server.url, machineId()] as const,
    queryFn: () => listOnboardingCredentials({
      serverUrl: globalSDK.url,
      machineId: machineId(),
      defaultScope: surface() === "desktop" ? "local" : "shared",
    }),
  }))
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: globalSDK.url }),
  )
  const projectSessions = createMemo(() =>
    sessionInventoryQuery.data?.sessions.filter((session) => session.directory === props.projectDirectory) ?? [],
  )
  const state = createMemo(() => {
    const remoteAvailability = remoteAccess.availability()
    return onboardingState({
      surface: surface(),
      machineId: machineId(),
      credentials: credentialsQuery.data ?? [],
      runnableHarnesses: [],
      hasProject: !!props.projectDirectory,
      sandboxProviderConfigured: false,
      hasFirstTurn: projectSessions().some((session) => session.lastTurn?.status === "completed"),
      hasFirstCloudTurn: projectSessions().some((session) =>
        session.lastTurn?.status === "completed" && session.environment?.kind === "cloud",
      ),
      hostedSignedIn: remoteAccess.status.data?.hostedSignedIn === true,
      remoteAccessEnabled: remoteAccess.status.data?.enabled === true,
      remoteAccessAvailable: remoteAvailability.state !== "locked",
      remoteAccessLockedReason: remoteAvailability.state === "locked"
        ? remoteAvailability.reason
        : undefined,
      secondDeviceOpen: remoteAccess.status.data?.secondDeviceOpen === true,
    })
  })
  const setup = createMemo(() => onboardingHomeView({
    state: state(),
    dismissals: dismissals.ids(),
  }))
  const visibleSetup = createMemo(() => {
    const view = setup()
    if (view.mode === "hidden") return
    return view as typeof view & { mode: Exclude<SetupShellMode, "hidden"> }
  })

  createEffect(() => {
    const view = setup()
    if (view.mode === "form" && !emitted.has("setup_form_shown")) {
      emitted.add("setup_form_shown")
      funnel().emit({ name: "setup_form_shown" })
    }
    view.steps.filter((step) => step.done).forEach((step) => {
      const key = `step_done:${step.id}`
      if (emitted.has(key)) return
      emitted.add(key)
      funnel().emit({ name: "step_done", step: step.id, surface: surface() })
    })
  })

  function runAction(action: OnboardingStepAction) {
    if (action === "open-project" || action === "pick-repository") {
      props.onNewProject?.()
      return
    }
    if (action === "connect-ai") return
    if (action === "sign-in") {
      navigate("/login")
      return
    }
    if (action === "add-compute") {
      dialog.show(() => <DialogCreateCloudProject onSelect={() => undefined} />)
    }
  }

  function runCardAction(id: "workgraph" | "harnesses" | "self-host") {
    if (id === "workgraph") {
      navigate("/workgraph")
      return
    }
    if (id === "harnesses") {
      dialog.show(() => <DialogSelectProvider />)
      return
    }
    platform.openLink("https://claxedo.com/framework")
  }

  function connectProvider(providerId: string) {
    dialog.show(() => (
      <DialogConnectProvider
        provider={providerId}
        onConnected={async () => {
          const results = await verifyProviderAIConnections({ serverUrl: globalSDK.url, providerId })
          await invalidateAIConnectQueries()
          const failed = results.find((result) => result.result !== "ok")
          if (failed && failed.result !== "ok") {
            funnel().emit({ name: "step_verify_failed", step: "ai", class: failed.result })
            throw new Error(aiConnectFailureCopy(failed.result))
          }
          results.forEach((result) => funnel().emit({ name: "provider_connected", provider: result.providerId }))
        }}
      />
    ))
  }

  return (
    <div
      class="contents"
      data-testid="onboarding-owner"
      data-mode={setup().mode}
      data-project={String(!!props.projectDirectory)}
      data-usable-credential={String(state().hasUsableCredential)}
      data-dismissals={dismissals.ids().join(",")}
    >
      <Show
        when={visibleSetup()}
        fallback={props.fallback === false ? undefined : props.fallback ?? (
          <div class="flex h-full flex-col items-center justify-center gap-4 text-text-weak">
            <h1 class="sr-only">No projects yet</h1>
            <span class="text-14-regular">No projects yet. Create one to get started.</span>
            <Button icon="plus-small" onClick={() => props.onNewProject?.()}>New Project</Button>
            <Show when={props.onDiagnostics}>
              {(onDiagnostics) => (
                <Button data-testid="empty-diagnostics-trigger" variant="ghost" onClick={onDiagnostics()}>
                  Diagnostics
                </Button>
              )}
            </Show>
          </div>
        )}
      >
        {(view) => (
          <div
            class="flex h-full items-center justify-center overflow-auto p-4"
            classList={{ "absolute inset-0 z-20 bg-background-base": props.overlay }}
          >
          <Show when={props.onDiagnostics}>
            {(onDiagnostics) => (
              <Button
                class="absolute bottom-4 right-4"
                data-testid="empty-diagnostics-trigger"
                variant="ghost"
                onClick={onDiagnostics()}
              >
                Diagnostics
              </Button>
            )}
          </Show>
          <SetupShell
            mode={view().mode}
            steps={view().steps}
            activeStep={(() => {
              const selected = view().steps.find((step) => step.id === (selectedStep() ?? requestedStep()))
              return selected && !selected.done && !selected.locked ? selected.id : view().activeStep
            })()}
            goFurtherCards={onboardingGoFurtherCards.filter((card) => view().goFurtherCards.some((item) => item.id === card.id))}
            onSelectStep={(id) => {
              const step = view().steps.find((item) => item.id === id)
              if (!step || step.locked) return
              setSelectedStep(id)
              setSearchParams({ onboarding: id })
              if (step.id !== "ai") runAction(step.cta.action)
            }}
            onDismiss={() => {
              if (view().mode === "form") funnel().emit({ name: "setup_form_dismissed" })
              void dismissals.dismiss(view().mode === "checklist" ? "checklist" : "setup")
            }}
            onSkip={(id) => void dismissals.dismiss(`step:${id}`)}
            onSelectCard={(id) => {
              funnel().emit({ name: "gofurther_card_clicked", card: id })
              runCardAction(id)
            }}
            onDismissCard={(id) => {
              funnel().emit({ name: "gofurther_card_dismissed", card: id })
              void dismissals.dismiss(`gofurther:${id}`)
            }}
            renderStep={(id) => {
              const step = view().steps.find((item) => item.id === id)
              return (
                <Show when={step}>
                  {(item) => (
                    <div class="flex h-full flex-col items-start gap-4">
                      <div>
                        <div class="text-16-medium text-text-strong">{item().title}</div>
                        <div class="mt-1 text-13-regular text-text-weak">{item().education}</div>
                      </div>
                      <Show
                        when={item().id === "ai"}
                        fallback={
                          <Show
                            when={item().id === "remote-access"}
                            fallback={<Button class="mt-auto" onClick={() => runAction(item().cta.action)}>{item().cta.label}</Button>}
                          >
                            <RemoteAccessSurface
                              availability={remoteAccess.availability()}
                              workspaceLink={remoteAccess.workspaceLink()}
                              devices={remoteAccess.devices.data ?? []}
                              showDevices={false}
                              startAtLogin={remoteAccess.startAtLogin()}
                              onStartAtLoginChange={(enabled) => void remoteAccess.setStartAtLogin(enabled)}
                              onEnable={() => void remoteAccess.enable()}
                              onSignIn={() => navigate("/login")}
                              onRevoke={(hostId) => void remoteAccess.revoke(hostId)}
                            />
                          </Show>
                        }
                      >
                        <AIConnectSurface
                          localDiscovery={server.isLocal()}
                          serverUrl={globalSDK.url}
                          defaultScope={surface() === "desktop" ? "local" : "shared"}
                          deviceLoginConfigured={remoteAccess.status.data?.deviceLoginConfigured === true}
                          onProviderConnect={connectProvider}
                          emit={funnel().emit}
                        />
                      </Show>
                    </div>
                  )}
                </Show>
              )
            }}
          />
          </div>
        )}
      </Show>
    </div>
  )
}
