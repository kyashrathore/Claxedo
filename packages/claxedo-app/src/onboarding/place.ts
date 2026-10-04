import { createOrOpenFolderProject, ServerError, toAppError, type PlacementId, type ProjectId, type Server } from "@/server"
import type { OnboardingText } from "./i18n"
import type { Created, ExecutionPlan, OnboardingDraft } from "./model"

export type Placing = { readonly draft: OnboardingDraft; readonly plan: ExecutionPlan }

async function accountCloudWorkspace(server: Server, draft: OnboardingDraft, name: string, t: OnboardingText, hold: (created: Created) => void): Promise<Created> {
  const source = draft.source
  if (source.kind === "folder") throw new ServerError({ class: "invalid", message: t("onboarding.reason.execution.folder") })
  const onCreated = (id: PlacementId) => hold({ kind: "workspace", placementId: id })
  const workspace = await server.cloud.create({ source, name, onCreated })
  return { kind: "workspace", placementId: workspace.id }
}

export async function createOnboardingTarget(server: Server, t: OnboardingText, placing: Placing, hold: (created: Created) => void): Promise<Created> {
  if (placing.plan.kind === "cloud") return accountCloudWorkspace(server, placing.draft, placing.plan.name, t, hold)
  const input = { source: placing.draft.source, ...(placing.draft.name ? { name: placing.draft.name } : {}) }
  return { kind: "project", project: await createOrOpenFolderProject(server, input) }
}

export async function startCreated(server: Server, created: Created): Promise<void> {
  if (created.kind === "workspace") await server.cloud.start(created.placementId)
}

export function openedPlacement(t: OnboardingText, created: Created, placementOf: (project: ProjectId) => PlacementId | undefined): PlacementId {
  if (created.kind === "workspace") return created.placementId
  const placement = placementOf(created.project.id)
  if (!placement) throw new ServerError({ class: "not_found", message: t("onboarding.failed.noPlacement", { project: created.project.name }) })
  return placement
}

export function finishFailure(t: OnboardingText, error: unknown, created: Created | undefined): string {
  const message = toAppError(error).message
  return created ? t("onboarding.failed.open", { error: message }) : message
}
