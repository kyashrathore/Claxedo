import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { useConfigOptional } from "@/app/providers/config"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useServer } from "@/app/connection/server"
import {
  AIConnectSurface,
  createLocalOnboardingDestination,
  createLocalOnboardingDismissals,
  createOnboardingFunnel,
  DestinationSurface,
  destinationIncludesCloud,
  hasConnectedCodeHost,
  listOnboardingCredentials,
  onboardingGoFurtherCards,
  onboardingHomeView,
  onboardingState,
  readCodeHostStatus,
  readSandboxProviderCatalog,
  RemoteAccessSurface,
  sandboxProviderQueryOptions,
  SetupOptionRow,
  SetupPage,
  SetupRows,
  useRemoteAccessController,
  type AIConnectView,
  type CodeHostRequest,
  type OnboardingGoFurtherCardId,
  type OnboardingStepAction,
  type OnboardingStepId,
  type OnboardingDestination,
  type SetupPageStep,
  type SetupStepSubmit,
} from "@/features/onboarding"
import { workspaceSandboxDriverAuthUrl } from "@/features/settings/ui/sandbox-section-logic"
import { authFetch } from "@/platform/api/api"
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
  // The answer to step 0, persisted. It replaces the inference this component
  // used to make from `sandboxProviderConfigured`, which could not tell "local
  // only" from "hasn't set up cloud yet" and was the circularity §4.1 names.
  const destinationChoice = createLocalOnboardingDestination()
  const destination = () => destinationChoice.destination()
  const surface = () => platform.platform === "desktop" ? "desktop" : config?.sandboxEnabled ? "web" : "self-host"
  const machineId = () => `${platform.platform}:${server.url}`
  const funnel = createMemo(() => createOnboardingFunnel({
    deployment: surface() === "self-host" ? "self-host" : "hosted",
    // `step_done` carries its own `surface` and overrides the default below.
    capture: (name, properties) =>
      captureTelemetry(name, { ...identityProps(), surface: "onboarding", ...properties }),
  }))
  const remoteAccess = useRemoteAccessController({ serverUrl: server.url, emit: funnel().emit })
  const [aiView, setAIView] = createSignal<AIConnectView>({ kind: "chooser" })
  // Set only by the go-further card, which opens the AI step straight on its
  // harness check with no click to start the scan.
  const [harnessCheck, setHarnessCheck] = createSignal(false)
  const [runnableHarnesses, setRunnableHarnesses] = createSignal<readonly string[]>([])
  const emitted = new Set<string>()
  const credentialsQuery = useQuery(() => ({
    queryKey: ["claxedo", "onboarding", "credentials", server.url, machineId()] as const,
    queryFn: () => listOnboardingCredentials({
      serverUrl: globalSDK.url,
      machineId: machineId(),
      defaultScope: surface() === "desktop" ? "local" : "shared",
    }),
  }))
  // The real gate for cloud steps: a default sandbox driver that actually
  // carries credentials. Without it the server rejects workspace creation, so
  // offering the step would be offering something that cannot succeed.
  const sandboxQuery = useQuery(() => sandboxProviderQueryOptions({
    baseUrl: globalSDK.url,
    serverUrl: server.url,
  }))
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({ baseUrl: globalSDK.url }),
  )
  // The provider catalog behind the inline key form. Unlike `sandboxQuery` this
  // lists providers that are NOT configured — that is the state the form exists
  // to repair.
  const sandboxCatalogQuery = useQuery(() => ({
    queryKey: ["claxedo", "onboarding", "sandbox-catalog", server.url] as const,
    queryFn: () => readSandboxProviderCatalog({ baseUrl: globalSDK.url }),
    enabled: destinationIncludesCloud(destination()),
    retry: false,
  }))
  // Cloud sessions clone from a repository, so the cloud answer is only usable
  // once an account that owns one is connected.
  const codeHostRequest: CodeHostRequest = (path, init) =>
    authFetch(new URL(`/api/claxedo/integrations${path}`, globalSDK.url).toString(), init)
  const codeHostQuery = useQuery(() => ({
    queryKey: ["claxedo", "onboarding", "code-hosts", server.url] as const,
    queryFn: () => readCodeHostStatus(codeHostRequest),
    enabled: destinationIncludesCloud(destination()),
    retry: false,
  }))
  const projectSessions = createMemo(() =>
    sessionInventoryQuery.data?.sessions.filter((session) => session.directory === props.projectDirectory) ?? [],
  )
  const state = createMemo(() => {
    const remoteAvailability = remoteAccess.availability()
    return onboardingState({
      surface: surface(),
      machineId: machineId(),
      credentials: credentialsQuery.data ?? [],
      runnableHarnesses: runnableHarnesses(),
      hasProject: !!props.projectDirectory,
      ...(destination() ? { destination: destination()! } : {}),
      sandboxProviderConfigured: sandboxQuery.data?.configured === true,
      codeHostConnected: hasConnectedCodeHost(codeHostQuery.data ?? { integrations: [], connections: [] }),
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
  // The setup surface is a canvas overlay, not a route: the shell may navigate
  // to /w/:dir/session on boot and take the query string with it. So the URL is
  // read as an initial *seed*, and the chosen step then lives in state — a
  // deep link that the router discards a tick later must still land correctly.
  // Steps the user pressed Next on without finishing. Held in memory, not
  // persisted: "not now" is about this pass through setup, where a dismissal
  // is about every future one.
  const [passedOver, setPassedOver] = createSignal<readonly OnboardingStepId[]>([])
  const [chosenStep, setChosenStep] = createSignal<OnboardingStepId | undefined>(
    parseStepParam(searchParams.onboarding),
  )
  const requestedStep = createMemo<OnboardingStepId | undefined>(
    () => parseStepParam(searchParams.onboarding) ?? chosenStep(),
  )
  const setup = createMemo(() => onboardingHomeView({
    state: state(),
    dismissals: dismissals.ids(),
    passedOver: passedOver(),
    requestedStep: requestedStep(),
  }))
  const steps = createMemo<SetupPageStep[]>(() => setup().steps.map((step) => ({
    id: step.id,
    title: step.title,
    applies: step.applies,
    done: step.done,
    locked: step.locked,
    skipped: step.skipped,
    optional: step.optional,
  })))
  const activeStep = createMemo(() => {
    const location = setup().location
    if (location.kind !== "step") return
    return setup().steps.find((step) => step.id === location.step)
  })
  const visible = createMemo(() => setup().mode !== "hidden")

  // Credentials this machine holds that the cloud cannot reach yet.
  const shareCandidates = createMemo(() => state().localOnlyCredentials)
  const unshareableCredentials = createMemo(() => state().unshareableCredentials)
  const sharedCredentials = createMemo(() =>
    (credentialsQuery.data ?? []).filter((credential) => credential.scope === "shared"),
  )
  // Each step's body registers how its primary action behaves; the action bar
  // reads it. Signals, not plain refs — the label carries a live count
  // ("Save 2 connections") that has to track selection.
  const [aiSubmit, setAISubmit] = createSignal<SetupStepSubmit>()

  createEffect(() => {
    const view = setup()
    if (visible() && !emitted.has("setup_form_shown")) {
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

  function goTo(step: OnboardingStepId | undefined) {
    setAIView({ kind: "chooser" })
    setHarnessCheck(false)
    setChosenStep(step)
    setSearchParams({ onboarding: step })
  }

  /**
   * Next means "move on", which is not the same as "re-derive where I should
   * be". An unfinished optional step is still the first thing worth doing, so
   * recomputing from scratch lands the user back where they already were — a
   * live button that does nothing, which is what stranded people on the last
   * step with only Skip as a way out.
   *
   * Passing over a step is remembered for this pass only. Skip is the other
   * half of the pair and stays distinct: it writes a dismissal, so the step
   * stops being offered at all. Next is merely "not now".
   */
  function goNext() {
    const step = activeStep()
    if (step && !step.done) setPassedOver((current) => [...new Set([...current, step.id])])
    goTo(undefined)
  }

  function runAction(action: OnboardingStepAction) {
    if (action === "open-project" || action === "pick-repository") props.onNewProject?.()
  }

  /**
   * Answering does NOT advance. Clicking a row is the choice — it tags the row
   * and releases Next — and Next is the move. Doing both would skip the screen
   * out from under a user who wanted to read the other two consequences, or
   * who mis-clicked a decision about where their code and credentials go.
   */
  async function chooseDestination(next: OnboardingDestination) {
    // Stay put. Location otherwise resolves to the first UNFINISHED step, so
    // answering would complete this one and slide the screen away on its own —
    // skipping past the other two consequences, and past any mis-click, on a
    // decision about where the user's code and credentials go. The row is the
    // choice; Next is the move.
    setChosenStep("destination")
    await destinationChoice.choose(next)
  }

  function runCardAction(id: OnboardingGoFurtherCardId) {
    if (id === "workgraph") {
      navigate("/workgraph")
      return
    }
    if (id === "harnesses") {
      // The AI step's own check is the only surface that reports per-harness
      // readiness. Opening it on the check itself, rather than on the method
      // chooser, is what makes the card's promise true — the chooser asks the
      // user to connect something, which is not what they came here for.
      setHarnessCheck(true)
      setAIView({ kind: "detect" })
      setChosenStep("ai")
      setSearchParams({ onboarding: "ai" })
      return
    }
    platform.openLink("https://claxedo.com/framework")
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
        when={visible()}
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
        <div
          class="h-full min-h-0"
          classList={{ "absolute inset-0 z-20 bg-background-base": props.overlay }}
        >
          <SetupPage
            steps={steps()}
            location={setup().location}
            eyebrow={screenEyebrow()}
            title={screenTitle()}
            lede={screenLede()}
            back={backAction()}
            skip={skipAction()}
            primary={primaryAction()}
            onSelectStep={(id) => goTo(id)}
          >
            {renderBody()}
          </SetupPage>
        </div>
      </Show>
    </div>
  )

  // ── Screen composition ────────────────────────────────────────────────

  /**
   * The eyebrow names the *area*; the title states the *goal*. The header
   * already carries "Step N of M", so neither repeats the count.
   */
  function screenEyebrow() {
    const location = setup().location
    if (location.kind === "done") return "All set"
    const step = activeStep()
    if (!step) return
    if (step.id === "destination") return "Cloud sessions"
    if (step.id === "ai") return "Your AI"
    return "Remote access"
  }

  function screenTitle() {
    const location = setup().location
    if (location.kind === "done") return "You're set up"
    const step = activeStep()
    if (!step) return "Set up Claxedo"
    if (step.id === "ai") {
      if (aiView().kind === "providers") return "Choose a provider"
      if (aiView().kind === "connect") return "Connect this provider"
      if (aiView().kind === "claude") return "Set up Claude"
      // A local-only scan saves nothing, so the screen cannot be titled after a
      // choice the user is not being asked to make.
      if (aiView().kind === "detect") {
        return destination() === "local" ? "Your logins" : "Choose what to send"
      }
      return destination() === "local" ? "Your logins" : "Set up your AI"
    }
    if (step.id === "destination") return "Do you want to run cloud sessions too?"
    return "Do you want to access this machine remotely?"
  }

  /**
   * The step's own lede, unless the answer changes what the step is FOR. Saying
   * yes turns the first screen into a setup form, so its lede names the two
   * things the user is about to do rather than restating the question.
   */
  function screenLede() {
    const step = activeStep()
    if (step?.id === "destination" && destinationIncludesCloud(destination())) {
      return "Set up a sandbox provider and connect GitHub, and your sessions can keep running without your laptop."
    }
    return step?.education
  }

  function backAction() {
    const step = activeStep()
    // Inside the AI sub-flow, Back unwinds the sub-screen before the step.
    if (step?.id === "ai" && aiView().kind !== "chooser") {
      return () => setAIView({ kind: "chooser" })
    }
    const previous = setup().steps
      .slice(0, setup().steps.findIndex((item) => item.id === step?.id))
      .at(-1)
    if (!previous) return
    return () => goTo(previous.id)
  }

  function skipAction() {
    const step = activeStep()
    if (!step?.optional || step.done) return
    return {
      label: "Skip — set this up later",
      onClick: () => {
        void dismissals.dismiss(`step:${step.id}`)
        goTo(undefined)
      },
    }
  }

  /**
   * Why the current step cannot be left yet, in the user's terms. Undefined
   * means Next is live.
   *
   * Every step's commit action lives in its own body, beside the thing it acts
   * on, so the footer is pure navigation. That makes "can I move on?" a single
   * question with a single answer per step — which is what this returns.
   */
  function nextBlockedReason() {
    const step = activeStep()
    if (!step || step.done) return
    if (step.optional) return
    if (step.id === "destination") {
      if (destination() === undefined) return "Pick an answer to continue."
      if (!destinationIncludesCloud(destination())) {
        return surface() === "desktop" ? "Open a project to continue." : "Pick a repository to continue."
      }
      // Saying yes is not the same as being ready: the cloud needs somewhere to
      // run and something to clone, and the reason names whichever is missing.
      if (!state().sandboxProviderConfigured) return "Add your sandbox provider key to continue."
      if (!state().codeHostConnected) return "Connect GitHub to continue."
      return
    }
    if (step.id === "ai") return "Connect an AI provider to continue."
    return step.lockedReason
  }

  /**
   * The footer navigates; it never commits. Next is always rendered — disabled
   * with a reason when the step is unsatisfied — so the nav row keeps its shape
   * as the user moves through the flow.
   */
  function primaryAction() {
    const location = setup().location
    if (location.kind === "done") {
      return { label: "Start your first task", onClick: () => goTo(undefined) }
    }
    const step = activeStep()
    if (!step) return
    const blocked = nextBlockedReason()
    return {
      label: "Next",
      disabled: !!blocked,
      ...(blocked ? { hint: blocked } : {}),
      onClick: () => goNext(),
    }
  }

  function renderBody() {
    const location = setup().location
    if (location.kind === "done") return renderDone()
    const step = activeStep()
    if (!step) return
    if (step.id === "destination") {
      return (
        <DestinationSurface
          destination={destination()}
          onChoose={(next) => void chooseDestination(next)}
          sandboxCatalog={sandboxCatalogQuery.data}
          codeHosts={codeHostQuery.data}
          loading={sandboxCatalogQuery.isFetching || codeHostQuery.isFetching}
          baseUrl={globalSDK.url}
          sandboxAuthUrl={workspaceSandboxDriverAuthUrl}
          codeHostRequest={codeHostRequest}
          openUrl={(url) => platform.openLink(url)}
          onSandboxConfigured={async () => {
            await Promise.all([sandboxQuery.refetch(), sandboxCatalogQuery.refetch()])
            funnel().emit({
              name: "sandbox_provider_configured",
              provider: sandboxCatalogQuery.data?.defaultProviderId ?? "unknown",
            })
          }}
          onCodeHostConnected={() => void codeHostQuery.refetch()}
          projectPicker={
            <SetupRows>
              <SetupOptionRow
                label={surface() === "desktop" ? "Open a project" : "Pick a repository"}
                consequence={surface() === "desktop"
                  ? "Opens your file browser. Claxedo reads the folder you pick and nothing else."
                  : "Pick a repository you've connected. You can add more later."}
                onClick={() => props.onNewProject?.()}
              />
            </SetupRows>
          }
        />
      )
    }
    if (step.id === "ai") {
      return (
        <AIConnectSurface
          localDiscovery={server.isLocal()}
          serverUrl={globalSDK.url}
          defaultScope={surface() === "desktop" ? "local" : "shared"}
          destination={destination()}
          autoDiscover={harnessCheck()}
          deviceLoginConfigured={remoteAccess.status.data?.deviceLoginConfigured === true}
          view={aiView()}
          onViewChange={setAIView}
          registerSubmit={(submit) => setAISubmit(() => submit)}
          onLocalHarnessesDetected={setRunnableHarnesses}
          onConnected={() => goTo(undefined)}
          emit={funnel().emit}
        />
      )
    }
    if (step.id === "remote-access") {
      return (
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
      )
    }
    return
  }

  function renderDone() {
    return (
      <div class="setup-block">
        <div class="setup-rows">
          {setup().steps.filter((step) => step.done).map((step) => (
            <div class="setup-row">
              <span class="setup-row-copy">
                <span class="text-13-medium text-text-strong">{step.title}</span>
              </span>
              <span class="setup-status text-12-regular">Done</span>
            </div>
          ))}
        </div>
        <div class="setup-rows">
          {onboardingGoFurtherCards
            .filter((card) => setup().goFurtherCards.some((item) => item.id === card.id))
            .map((card) => (
              <button
                type="button"
                class="setup-row"
                onClick={() => {
                  funnel().emit({ name: "gofurther_card_clicked", card: card.id })
                  runCardAction(card.id)
                }}
              >
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">{card.title}</span>
                  <span class="setup-row-consequence text-12-regular">{card.education}</span>
                </span>
                <span class="setup-status text-12-regular">{card.action}</span>
              </button>
            ))}
        </div>
      </div>
    )
  }
}

const stepParams: readonly OnboardingStepId[] = ["destination", "ai", "remote-access"]

function parseStepParam(value: unknown): OnboardingStepId | undefined {
  return stepParams.find((step) => step === value)
}
