/**
 * Stable hosted-service facade. Provider selections live under adapters/ so
 * importing the neutral contracts does not make a storage choice.
 */
export * from "./provider-neutral-hosted-services"
export {
  composeHostedControlPlane,
  lifecycleMinutes,
  sandboxDriver,
} from "./adapters/worker/retained-hosted-services"
