// CLAXEDO_DATA_DIR and ClaxedoDB are process-global production composition
// state. Materializers prepare multiple disposable app states in one process,
// so every temporary selection must be exclusive and must close the singleton
// before another state chooses a different database path.
let scopeTail = Promise.resolve()

export async function withClaxedoDataDirectory<T>(
  dataDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Keep the cross-package source import dynamic so this harness package's
  // TypeScript project does not absorb claxedo-server-core into its rootDir.
  const { ClaxedoDB } = await claxedoDatabase()
  const previousScope = scopeTail
  let releaseScope!: () => void
  scopeTail = new Promise<void>((resolve) => {
    releaseScope = resolve
  })
  await previousScope

  const previousDirectory = process.env.CLAXEDO_DATA_DIR
  ClaxedoDB.close()
  process.env.CLAXEDO_DATA_DIR = dataDirectory
  try {
    return await operation()
  } finally {
    ClaxedoDB.close()
    if (previousDirectory === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDirectory
    releaseScope()
  }
}

async function claxedoDatabase() {
  const databaseModule = "../../../claxedo-server-core/src/platform/db/index.ts"
  return (await import(databaseModule)) as {
    ClaxedoDB: {
      close(): void
    }
  }
}
