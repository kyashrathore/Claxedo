import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineDoc } from "@earendil-works/pi-durable"
import type { PiCredentials } from "./credentials"
import { piCatalogModel, type PiCatalogModel } from "./launch-catalog"
import type { PiSessionRuntime } from "./placement"

const ModelCatalogDoc = defineDoc<{ models: PiCatalogModel[] }>({
  kind: "claxedo.model-catalog",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ models: [] }),
  checkpointWhen: () => true,
})

export function piCatalog(credentials: PiCredentials): PiCatalogModel[] {
  return credentials.catalogProviders().flatMap((provider) => credentials.models.getModels(provider)
    .map((model) => piCatalogModel(provider, model)))
}

export function sessionModelCatalog(runtime: PiSessionRuntime): Promise<PiCatalogModel[]> {
  return runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(ModelCatalogDoc, runtime.conversation.id)
    return doc.models.map((model) => ({ ...model, efforts: [...model.efforts] }))
  }, BACKGROUND_CONTEXT)
}

export async function recordModelCatalog(runtime: PiSessionRuntime, credentials: PiCredentials): Promise<void> {
  const models = piCatalog(credentials)
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(ModelCatalogDoc, runtime.conversation.id)
    doc.models = models
  }, BACKGROUND_CONTEXT)
}
