import { requireServiceCatalog, type FirstPartyServiceDescriptor } from "@claxedo/service-contract"

type OptionalServiceBindingTarget = Readonly<{
  descriptor: FirstPartyServiceDescriptor
  workerName: string
}>

function quote(value: string) {
  if (!value || value.trim() !== value) throw new Error("optional-service binding values must be canonical")
  return JSON.stringify(value)
}

/** Adds only installed static service bindings to an already certified core config. */
export function renderHostedCoreOptionalServiceBindings(
  coreOnlyConfig: string,
  rawTargets: readonly OptionalServiceBindingTarget[],
) {
  if (/\[\[services\]\]/.test(coreOnlyConfig) || /DOCUMENTS_SERVICE/.test(coreOnlyConfig)) {
    throw new Error("coreOnlyConfig must not already contain optional-service bindings")
  }
  const descriptors = requireServiceCatalog(rawTargets.map((target) => target.descriptor))
  const workerByService = new Map(rawTargets.map((target) => [target.descriptor.serviceId, quote(target.workerName)]))
  if (workerByService.size !== rawTargets.length) throw new Error("optional-service binding target is duplicated")
  const blocks = descriptors.map((descriptor) => {
    const workerName = workerByService.get(descriptor.serviceId)
    if (!workerName) throw new Error(`missing Worker name for ${descriptor.serviceId}`)
    return `[[services]]
binding = ${quote(descriptor.bindingName)}
service = ${workerName}
entrypoint = ${quote(descriptor.entrypoint)}
`
  })
  return `${coreOnlyConfig.trimEnd()}\n${blocks.length ? `\n${blocks.join("\n")}` : ""}`
}
