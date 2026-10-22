export { RUNTIME_DIR, WORKSPACE_RUNTIME_PORT, WORKSPACE_DIR } from "./defaults"
export {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotVersion,
  assertSandboxImageReference,
  defaultSandboxImage,
} from "./image-name"
export { SERVED_WORKSPACE_RUNTIME_FLOOR } from "./runtime-version"
import { defaultSandboxImage, sandboxImageRepository } from "./image-name"

export const SANDBOX_IMAGE_REPOSITORY = sandboxImageRepository()

export const SANDBOX_IMAGE = process.env.CLAXEDO_SANDBOX_IMAGE || defaultSandboxImage()
