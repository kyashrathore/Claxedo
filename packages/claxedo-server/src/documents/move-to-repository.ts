import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { contentHash } from "./version"

const MoveRequestSchema = z
  .object({
    orgId: z.string().min(1),
    projectId: z.string().min(1),
    documentId: z.string().min(1),
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    managedRelativePath: z.string().min(1).optional(),
  })
  .strict()

export type MoveToRepositoryRequest = z.infer<typeof MoveRequestSchema>

const JournalSchema = MoveRequestSchema.extend({
  managedRelativePath: z.string().min(1),
  state: z.enum([
    "planned",
    "repository_written",
    "repository_verified",
    "index_flipped",
    "source_archived",
    "complete",
  ]),
  markdown: z.string(),
  sourceVersion: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

type Journal = z.infer<typeof JournalSchema>
const moveQueues = new Map<string, Promise<void>>()

type MoveFaults = Readonly<{
  afterRepositoryWrite?: () => void | Promise<void>
  afterRepositoryVerify?: () => void | Promise<void>
  afterIndexFlip?: () => void | Promise<void>
  afterManagedIndexRestore?: () => void | Promise<void>
  afterManagedArchive?: () => void | Promise<void>
}>

export function createMoveToRepository(
  options: Readonly<{
    journalRoot: string
    readManaged(input: MoveToRepositoryRequest): Promise<Readonly<{ markdown: string; version: string }>>
    validateDestination?(input: MoveToRepositoryRequest): Promise<void>
    writeRepository(markdown: string, input: MoveToRepositoryRequest): Promise<void>
    readRepository(input: MoveToRepositoryRequest): Promise<string | undefined>
    flipIndex(
      input: MoveToRepositoryRequest,
      sourceVersion: string,
      expected: Readonly<{ markdown: string; sha256: string }>,
    ): Promise<void>
    indexOrigin(input: MoveToRepositoryRequest): Promise<"managed" | "repository" | undefined>
    archiveManaged(input: MoveToRepositoryRequest, expectedVersion: string): Promise<void>
    restoreManagedIndex(input: MoveToRepositoryRequest): Promise<void>
    faults?: MoveFaults
  }>,
) {
  return async (requestInput: MoveToRepositoryRequest) => {
    const request = MoveRequestSchema.parse(requestInput)
    return await serializeMove(request, async () => {
      await options.validateDestination?.(request)
      const file = path.join(
        options.journalRoot,
        `${safeId(request.orgId)}.${safeId(request.projectId)}.${safeId(request.documentId)}.json`,
      )
      const journal = await loadOrCreate(file, request)

      if (journal.state === "complete") return journal
      if (journal.state === "index_flipped") {
        const origin = await options.indexOrigin(journal)
        if (origin === undefined) throw new Error(`Document ${request.documentId} is missing from the index`)
        if (origin === "managed") {
          // Recovery may have restored the managed index immediately before a
          // crash. Reconcile the durable journal with the actual authority before
          // deciding whether the source can be archived.
          journal.state = "repository_verified"
          await writeJournal(file, journal)
        }
      }

      if (stageBefore(journal.state, "repository_written")) {
        await options.writeRepository(journal.markdown, journal)
        journal.state = "repository_written"
        await writeJournal(file, journal)
        await options.faults?.afterRepositoryWrite?.()
      }

      if (stageBefore(journal.state, "repository_verified")) {
        await verifyRepository(journal)
        journal.state = "repository_verified"
        await writeJournal(file, journal)
        await options.faults?.afterRepositoryVerify?.()
      }

      if (stageBefore(journal.state, "index_flipped")) {
        // A completed verification may predate a process crash. Re-read at the
        // irreversible index boundary so a replaced destination cannot be adopted.
        await verifyRepository(journal)
        const managed = await options.readManaged(journal)
        const origin = await options.indexOrigin(journal)
        if (origin === undefined) throw new Error(`Document ${request.documentId} is missing from the index`)
        if (managed.version !== journal.sourceVersion || managed.markdown !== journal.markdown) {
          if (origin === "repository") await options.restoreManagedIndex(journal)
          await removeJournal(file)
          throw new Error("Managed source changed before the repository index flip")
        }
        if (origin === "managed") {
          await options.flipIndex(journal, journal.sourceVersion, {
            markdown: journal.markdown,
            sha256: journal.sha256,
          })
        }
        journal.state = "index_flipped"
        await writeJournal(file, journal)
        await options.faults?.afterIndexFlip?.()
      }

      if (stageBefore(journal.state, "source_archived")) {
        try {
          await options.archiveManaged(journal, journal.sourceVersion)
        } catch (error) {
          await options.restoreManagedIndex(journal)
          await options.faults?.afterManagedIndexRestore?.()
          journal.state = "repository_verified"
          await writeJournal(file, journal)
          // The source may have been replaced after the index flip. Once the
          // managed index is authoritative again, the captured source is stale;
          // retaining this journal would reject every retry before the flip.
          // Removing it only after restoration lets the next attempt capture the
          // current source while the verified repository copy remains a backup.
          await removeJournal(file)
          throw error
        }
        journal.state = "source_archived"
        await writeJournal(file, journal)
        await options.faults?.afterManagedArchive?.()
      }

      journal.state = "complete"
      await writeJournal(file, journal)
      return journal
    })

    async function loadOrCreate(file: string, input: MoveToRepositoryRequest) {
      const existing = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (existing !== undefined) {
        const parsed = JournalSchema.parse(JSON.parse(existing))
        if (
          parsed.orgId !== input.orgId ||
          parsed.projectId !== input.projectId ||
          parsed.documentId !== input.documentId ||
          parsed.workspaceId !== input.workspaceId ||
          parsed.relativePath !== input.relativePath
        ) {
          throw new Error(`Document ${input.documentId} already has a different repository move in progress`)
        }
        return parsed
      }
      if (!input.managedRelativePath) throw new Error("Managed source path is required to start a repository move")
      const source = await options.readManaged(input)
      const created: Journal = {
        ...input,
        managedRelativePath: input.managedRelativePath,
        state: "planned",
        markdown: source.markdown,
        sourceVersion: source.version,
        sha256: sha256(source.markdown),
      }
      if (await createInitialJournal(file, created)) return created
      return await loadOrCreate(file, input)
    }

    async function verifyRepository(input: Journal) {
      const observed = await options.readRepository(input)
      if (observed === undefined) await options.writeRepository(input.markdown, input)
      const markdown = observed ?? (await options.readRepository(input))
      if (markdown === undefined || sha256(markdown) !== input.sha256 || markdown !== input.markdown) {
        throw new Error("Repository destination did not preserve the managed document bytes")
      }
    }
  }
}

const stages = [
  "planned",
  "repository_written",
  "repository_verified",
  "index_flipped",
  "source_archived",
  "complete",
] as const

function stageBefore(current: Journal["state"], target: Journal["state"]) {
  return stages.indexOf(current) < stages.indexOf(target)
}

function safeId(value: string) {
  return contentHash(value)
}

async function serializeMove<T>(request: MoveToRepositoryRequest, run: () => Promise<T>) {
  const key = `${request.orgId}\0${request.projectId}\0${request.documentId}`
  const previous = moveQueues.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  moveQueues.set(key, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (moveQueues.get(key) === current) moveQueues.delete(key)
  }
}

function sha256(markdown: string) {
  return contentHash(markdown)
}

async function writeJournal(file: string, journal: Journal) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
  const directory = await fs.open(path.dirname(file), "r")
  try {
    await directory.sync()
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(String(error.code))
      )
    )
      throw error
  } finally {
    await directory.close()
  }
}

async function createInitialJournal(file: string, journal: Journal) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.initial`
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal))
    await handle.sync()
  } finally {
    await handle.close()
  }
  const created = await fs
    .link(temporary, file)
    .then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false
        throw error
      },
    )
    .finally(() => fs.unlink(temporary))
  const directory = await fs.open(path.dirname(file), "r")
  try {
    await directory.sync()
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(String(error.code))
      )
    )
      throw error
  } finally {
    await directory.close()
  }
  return created
}

async function removeJournal(file: string) {
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  const directory = await fs.open(path.dirname(file), "r")
  try {
    await directory.sync()
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(String(error.code))
      )
    )
      throw error
  } finally {
    await directory.close()
  }
}
