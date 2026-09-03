import { createWorkGraphServiceManifest, renderWorkGraphServiceWranglerConfig } from "./manifest"

export type WorkGraphDeployEnvironment = Readonly<Record<string, string | undefined>>

function required(env: WorkGraphDeployEnvironment, name: string) {
  const value = env[name]
  if (!value || value.trim() !== value) throw new Error(`${name} must be configured as a non-empty trimmed value`)
  return value
}

export function renderWorkGraphServiceWranglerFromEnvironment(env: WorkGraphDeployEnvironment) {
  const environment = required(env, "CLAXEDO_WORKGRAPH_ENVIRONMENT")
  if (environment !== "staging" && environment !== "production") {
    throw new Error("CLAXEDO_WORKGRAPH_ENVIRONMENT must be staging or production")
  }
  return renderWorkGraphServiceWranglerConfig(
    createWorkGraphServiceManifest({
      environment,
      environmentId: required(env, "CLAXEDO_WORKGRAPH_ENVIRONMENT_ID"),
      deploymentId: required(env, "CLAXEDO_WORKGRAPH_DEPLOYMENT_ID"),
      workerName: required(env, "CLAXEDO_WORKGRAPH_WORKER_NAME"),
      database: {
        name: required(env, "CLAXEDO_WORKGRAPH_DATABASE_NAME"),
        id: required(env, "CLAXEDO_WORKGRAPH_DATABASE_ID"),
      },
      serviceBuildId: required(env, "CLAXEDO_WORKGRAPH_SERVICE_BUILD_ID"),
    }),
  )
}

if (import.meta.main) process.stdout.write(renderWorkGraphServiceWranglerFromEnvironment(process.env))
