interface ImportMetaEnv {
  readonly CLAXEDO_CHANNEL: string
  /** "local" | "signed"; see `desktopProductMode` in ./navigation-guard. */
  readonly CLAXEDO_PRODUCT_MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
