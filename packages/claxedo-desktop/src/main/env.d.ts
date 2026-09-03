interface ImportMetaEnv {
  readonly CLAXEDO_CHANNEL: string
  readonly CLAXEDO_CORE_ORIGIN?: string
  readonly CLAXEDO_RELEASE_VALIDATION_OPERATION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
