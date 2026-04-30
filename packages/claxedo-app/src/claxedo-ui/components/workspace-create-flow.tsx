import { For, Show, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

type CreateType = "local" | "cloud"

type PipelineStep = {
  key: string
  label: string
}

export type WorkspaceCreateProject = {
  id: string
  name: string
  worktree: string
}

const CLOUD_PIPELINE: PipelineStep[] = [
  { key: "creating", label: "Creating workspace" },
  { key: "acquiring_sandbox", label: "Acquiring sandbox" },
  { key: "cloning", label: "Cloning repository" },
  { key: "uploading_runtime", label: "Uploading runtime" },
  { key: "starting_runtime", label: "Starting runtime" },
  { key: "waiting_health", label: "Waiting for health check" },
]

const LOCAL_PIPELINE: PipelineStep[] = [
  { key: "creating", label: "Creating worktree" },
]

const WS_ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "crisp", "curious", "eager", "gentle",
  "glowing", "happy", "hidden", "jolly", "kind", "lucky", "mighty", "misty",
  "neon", "nimble", "playful", "proud", "quick", "quiet", "shiny", "silent",
  "stellar", "sunny", "swift", "tidy", "witty",
]

const WS_NOUNS = [
  "cabin", "cactus", "canyon", "circuit", "comet", "eagle", "engine", "falcon",
  "forest", "garden", "harbor", "island", "knight", "lagoon", "meadow", "moon",
  "mountain", "nebula", "orchid", "otter", "panda", "pixel", "planet", "river",
  "rocket", "sailor", "squid", "star", "tiger", "wizard", "wolf",
]

function randomWorkspaceName() {
  const adj = WS_ADJECTIVES[Math.floor(Math.random() * WS_ADJECTIVES.length)]
  const noun = WS_NOUNS[Math.floor(Math.random() * WS_NOUNS.length)]
  return `${adj}-${noun}`
}

export function WorkspaceCreateFlow(props: {
  project: WorkspaceCreateProject
  projectName?: string
  canCreateCloud?: boolean
  initialType?: CreateType
  onBack?: () => void
  onComplete?: () => void
  onCreateLocal?: (
    project: WorkspaceCreateProject,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<unknown>
  onCreateCloud?: (
    project: WorkspaceCreateProject,
    onProgress?: (step: string, message?: string) => void,
    workspaceName?: string,
  ) => Promise<unknown>
}) {
  type Step = "type" | "name" | "provisioning"

  const [step, setStep] = createSignal<Step>("type")
  const [createType, setCreateType] = createSignal<CreateType>(props.initialType ?? (props.canCreateCloud ? "cloud" : "local"))
  const [workspaceName, setWorkspaceName] = createSignal("")
  const [provisionSteps, setProvisionSteps] = createSignal<Array<{ step: string; message?: string; ts: number }>>([])
  const [provisionError, setProvisionError] = createSignal("")

  const lastPipelineKey = () => {
    const steps = provisionSteps()
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].step !== "ready" && steps[i].step !== "redirecting" && steps[i].step !== "error") {
        return steps[i].step
      }
    }
    return null
  }

  const isProvisionReady = () => provisionSteps().some((step) => step.step === "ready")
  const isProvisionRedirecting = () => provisionSteps().some((step) => step.step === "redirecting")

  const pipelineStepState = (key: string): "done" | "active" | "pending" | "error" => {
    if (isProvisionReady()) return "done"
    const lastKey = lastPipelineKey()
    if (!lastKey) return "pending"
    const pipeline = createType() === "local" ? LOCAL_PIPELINE : CLOUD_PIPELINE
    const keyIdx = pipeline.findIndex((step) => step.key === key)
    const lastIdx = pipeline.findIndex((step) => step.key === lastKey)
    if (provisionError() && keyIdx === lastIdx) return "error"
    if (keyIdx === lastIdx) return "active"
    if (keyIdx < lastIdx) return "done"
    return "pending"
  }

  const pipelineStepDuration = (key: string) => {
    const steps = provisionSteps()
    const idx = steps.findIndex((step) => step.step === key)
    if (idx === -1) return undefined
    const next = steps[idx + 1]
    if (!next) return undefined
    return ((next.ts - steps[idx].ts) / 1000).toFixed(1)
  }

  const provisionTotalElapsed = () => {
    const steps = provisionSteps()
    const readyStep = steps.find((step) => step.step === "ready")
    if (!readyStep || steps.length < 2) return undefined
    return ((readyStep.ts - steps[0].ts) / 1000).toFixed(1)
  }

  const beginCreate = async () => {
    const type = createType()
    const name = workspaceName().trim() || undefined
    setStep("provisioning")
    setProvisionSteps([])
    setProvisionError("")
    const push = (stepName: string, message?: string) => {
      if (stepName === "error") {
        setProvisionError(message || "Failed")
        return
      }
      setProvisionSteps((prev) => {
        if (prev.some((step) => step.step === stepName)) return prev
        return [...prev, { step: stepName, message, ts: Date.now() }]
      })
    }

    if (type === "local") {
      await props.onCreateLocal?.(props.project, push, name)
    } else {
      setProvisionSteps([{ step: "creating", message: "Creating cloud workspace...", ts: Date.now() }])
      await props.onCreateCloud?.(props.project, push, name)
    }

    if (!provisionError()) props.onComplete?.()
  }

  return (
    <>
      <Show when={step() === "type"}>
        <div class="flex flex-col p-3 gap-3">
          <div class="flex items-center gap-2">
            <Show when={props.onBack}>
              <button
                type="button"
                class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
                onClick={() => props.onBack?.()}
              >
                <Icon name="chevron-left" size="small" />
              </button>
            </Show>
            <span class="text-[13px] font-medium text-text-base truncate">New workspace</span>
          </div>
          <span class="text-[11px] text-text-weaker px-1">
            in {props.projectName ?? props.project.name}
          </span>
          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-surface-base-hover transition-colors cursor-pointer border border-border-weak-base/50 bg-transparent"
              onClick={() => {
                setCreateType("local")
                setWorkspaceName(randomWorkspaceName())
                setStep("name")
              }}
            >
              <div class="flex items-center justify-center size-8 rounded bg-surface-base-hover/50">
                <Icon name="console" size="small" class="text-icon-base" />
              </div>
              <div class="flex flex-col gap-0.5 text-left">
                <span class="text-[13px] font-medium text-text-base">Local</span>
                <span class="text-[11px] text-text-weaker">Git worktree on this machine</span>
              </div>
            </button>
            <Show when={props.canCreateCloud}>
              <button
                type="button"
                class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-surface-base-hover transition-colors cursor-pointer border border-border-weak-base/50 bg-transparent"
                onClick={() => {
                  setCreateType("cloud")
                  setWorkspaceName(randomWorkspaceName())
                  setStep("name")
                }}
              >
                <div class="flex items-center justify-center size-8 rounded bg-surface-base-hover/50">
                  <Icon name="cloud-upload" size="small" class="text-icon-base" />
                </div>
                <div class="flex flex-col gap-0.5 text-left">
                  <span class="text-[13px] font-medium text-text-base">Cloud</span>
                  <span class="text-[11px] text-text-weaker">Remote sandbox environment</span>
                </div>
              </button>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={step() === "name"}>
        <div class="flex flex-col p-3 gap-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex items-center justify-center size-6 rounded text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover transition-colors cursor-pointer border-none bg-transparent"
              onClick={() => setStep("type")}
            >
              <Icon name="chevron-left" size="small" />
            </button>
            <span class="text-[13px] font-medium text-text-base truncate">Name your workspace</span>
          </div>
          <input
            type="text"
            placeholder="e.g. feature-auth, staging"
            value={workspaceName()}
            onInput={(event) => setWorkspaceName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void beginCreate()
            }}
            class="w-full px-3 py-2 rounded-md border border-border-weak-base/50 bg-transparent text-[13px] text-text-base placeholder:text-text-weaker outline-none focus:border-border-base"
            autofocus
          />
          <button
            type="button"
            class="flex items-center justify-center w-full px-3 py-2 rounded-md bg-surface-base-hover hover:bg-surface-base-active transition-colors cursor-pointer border border-border-weak-base/50 text-[13px] font-medium text-text-base"
            onClick={() => void beginCreate()}
          >
            Create
          </button>
        </div>
      </Show>

      <Show when={step() === "provisioning"}>
        <div class="flex flex-col gap-2 p-4">
          <span class="text-[12px] font-medium text-text-base mb-1">Provisioning...</span>
          <div class="flex flex-col gap-2 text-[11px]">
            <For each={createType() === "local" ? LOCAL_PIPELINE : CLOUD_PIPELINE}>
              {(pipelineStep) => {
                const state = () => pipelineStepState(pipelineStep.key)
                const duration = () => pipelineStepDuration(pipelineStep.key)
                return (
                  <div class="flex items-center gap-2">
                    <Show when={state() === "active"} fallback={
                      <Show when={state() === "error"} fallback={
                        <Icon name="circle-check" size="small" class="shrink-0" classList={{
                          "text-text-on-success-base": state() === "done",
                          "text-text-weaker/20": state() === "pending",
                        }} />
                      }>
                        <Icon name="circle-ban-sign" size="small" class="text-text-on-critical-base shrink-0" />
                      </Show>
                    }>
                      <span class="inline-flex items-center justify-center size-4 shrink-0">
                        <span
                          class="size-3 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
                          style={{ "animation-duration": "3s" }}
                        />
                      </span>
                    </Show>
                    <span class="truncate flex-1" classList={{
                      "text-text-base": state() === "active",
                      "text-text-weak": state() === "done",
                      "text-text-weaker/40": state() === "pending",
                      "text-text-on-critical-base": state() === "error",
                    }}>
                      {pipelineStep.label}
                    </span>
                    <Show when={state() === "done" && duration()}>
                      <span class="text-text-weaker tabular-nums shrink-0">{duration()}s</span>
                    </Show>
                  </div>
                )
              }}
            </For>
            <Show when={isProvisionReady()}>
              <div class="flex items-center gap-2">
                <Icon name="circle-check" size="small" class="text-text-on-success-base shrink-0" />
                <span class="text-text-on-success-base flex-1">Ready</span>
                <Show when={provisionTotalElapsed()}>
                  <span class="text-text-on-success-base/60 tabular-nums shrink-0">{provisionTotalElapsed()}s</span>
                </Show>
              </div>
            </Show>
            <Show when={isProvisionRedirecting()}>
              <div class="flex items-center gap-2">
                <span class="inline-flex items-center justify-center size-4 shrink-0">
                  <span
                    class="size-3 rounded-full border-[1.5px] border-dashed border-border-interactive-base animate-spin"
                    style={{ "animation-duration": "3s" }}
                  />
                </span>
                <span class="text-text-interactive-base flex-1">Redirecting to new session...</span>
              </div>
            </Show>
          </div>
          <Show when={provisionError()}>
            <div class="flex items-start gap-2 mt-2 px-2 py-1.5 rounded bg-surface-critical-base/10 border border-border-critical-base/20">
              <Icon name="warning" size="small" class="text-text-on-critical-base mt-0.5 shrink-0" />
              <span class="text-[11px] text-text-on-critical-base break-words min-w-0">{provisionError()}</span>
            </div>
            <button
              type="button"
              class="text-[12px] text-text-weak hover:text-text-base mt-1 cursor-pointer border-none bg-transparent"
              onClick={() => {
                setStep("type")
                setProvisionError("")
                setProvisionSteps([])
              }}
            >
              ← Back
            </button>
          </Show>
        </div>
      </Show>
    </>
  )
}
