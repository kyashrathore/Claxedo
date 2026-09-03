import { createDocumentsServiceManifest, renderDocumentsServiceWranglerConfig } from "./manifest"

export type DocumentsDeployEnvironment = Readonly<Record<string, string | undefined>>

function required(env: DocumentsDeployEnvironment, name: string) {
  const value = env[name]
  if (!value || value.trim() !== value) throw new Error(`${name} must be configured as a non-empty trimmed value`)
  return value
}

export function renderDocumentsServiceWranglerFromEnvironment(env: DocumentsDeployEnvironment) {
  const environment = required(env, "CLAXEDO_DOCUMENTS_ENVIRONMENT")
  if (environment !== "staging" && environment !== "production") {
    throw new Error("CLAXEDO_DOCUMENTS_ENVIRONMENT must be staging or production")
  }
  return renderDocumentsServiceWranglerConfig(
    createDocumentsServiceManifest({
      environment,
      environmentId: required(env, "CLAXEDO_DOCUMENTS_ENVIRONMENT_ID"),
      deploymentId: required(env, "CLAXEDO_DOCUMENTS_DEPLOYMENT_ID"),
      workerName: required(env, "CLAXEDO_DOCUMENTS_WORKER_NAME"),
      database: {
        name: required(env, "CLAXEDO_DOCUMENTS_DATABASE_NAME"),
        id: required(env, "CLAXEDO_DOCUMENTS_DATABASE_ID"),
      },
      bucket: { name: required(env, "CLAXEDO_DOCUMENTS_BUCKET_NAME") },
      serviceBuildId: required(env, "CLAXEDO_DOCUMENTS_SERVICE_BUILD_ID"),
    }),
  )
}

if (import.meta.main) process.stdout.write(renderDocumentsServiceWranglerFromEnvironment(process.env))
