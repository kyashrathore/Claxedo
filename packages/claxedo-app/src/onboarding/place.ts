import { createOrOpenFolderProject, ServerError, toAppError, type PlacementId, type ProjectId, type Server } from "@/server"
import type { OnboardingText } from "./i18n"
import { openable, type Created, type ExecutionChoice, type OnboardingDraft, type Openable } from "./model"

export type Placing = { readonly draft: OnboardingDraft; readonly choice: ExecutionChoice; readonly localExecution: boolean }

async function accountCloudWorkspace(server: Server, draft: OnboardingDraft, t: OnboardingText): Promise<Created> {
  const source = draft.source
  if (source.kind === "folder") throw new ServerError({ class: "invalid", message: t("onboarding.reason.execution.folder") })
  const workspace = await server.cloud.create({ source, ...(draft.name ? { name: draft.name } : {}) })
  return { kind: "workspace", placementId: workspace.id }
}

export async function createOnboardingTarget(server: Server, t: OnboardingText, placing: Placing, created: Created | undefined): Promise<Created> {
  if (created?.kind === "cloudProject") return { kind: "workspace", placementId: (await server.cloud.create({ projectId: created.project.id })).id }
  const input = { source: placing.draft.source, ...(placing.draft.name ? { name: placing.draft.name } : {}) }
  if (!placing.localExecution) return { kind: "cloudProject", project: await server.projects.create(input) }
  if (placing.choice === "cloud") return accountCloudWorkspace(server, placing.draft, t)
  return { kind: "project", project: await createOrOpenFolderProject(server, input) }
}

export function openedPlacement(t: OnboardingText, created: Openable, placementOf: (project: ProjectId) => PlacementId | undefined): PlacementId {
  if (created.kind === "workspace") return created.placementId
  const placement = placementOf(created.project.id)
  if (!placement) throw new ServerError({ class: "not_found", message: t("onboarding.failed.noPlacement", { project: created.project.name }) })
  return placement
}

export function finishFailure(t: OnboardingText, error: unknown, created: Created | undefined): string {
  const message = toAppError(error).message
  return openable(created) ? t("onboarding.failed.open", { error: message }) : message
}
