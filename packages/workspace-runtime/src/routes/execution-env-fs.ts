import { z } from "zod"
import type { Context } from "@earendil-works/chord"
import { FileError, type FileSystem, type Result } from "@earendil-works/pi-durable/env"

type Operation = (fs: FileSystem, args: unknown, context: Context) => z.ZodError | Promise<Result<unknown, FileError>>

export type FileSystemWireResult =
  | { invalid: string }
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; path?: string } }

const MAX_READ_BYTES = 8 * 1024 * 1024
const path = z.string()
const content = z.union([z.string(), z.object({ base64: z.string() }).strict()]).transform((value) =>
  typeof value === "string" ? value : new Uint8Array(Buffer.from(value.base64, "base64")))
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? undefined)

async function boundedRead<T>(fs: FileSystem, target: string, context: Context, read: () => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
  const info = await fs.fileInfo(target, context)
  if (info.ok && info.value.size > MAX_READ_BYTES) {
    return { ok: false, error: new FileError("invalid", `${target} is larger than the ${MAX_READ_BYTES}-byte read limit`, target) }
  }
  return read()
}

function op<A>(schema: z.ZodType<A>, call: (fs: FileSystem, args: A, context: Context) => Promise<Result<unknown, FileError>>): Operation {
  return (fs, raw, context) => {
    const args = schema.safeParse(raw)
    return args.success ? call(fs, args.data, context) : args.error
  }
}

const OPERATIONS = new Map<string, Operation>(Object.entries({
  absolutePath: op(z.tuple([path]), (fs, [target], context) => fs.absolutePath(target, context)),
  joinPath: op(z.tuple([z.array(path)]), (fs, [parts], context) => fs.joinPath(parts, context)),
  readTextFile: op(z.tuple([path]), (fs, [target], context) => boundedRead(fs, target, context, () => fs.readTextFile(target, context))),
  readTextLines: op(z.tuple([path, optional(z.object({ maxLines: z.number().int().positive().optional() }).strict())]),
    (fs, [target, options], context) => options?.maxLines === undefined
      ? boundedRead(fs, target, context, () => fs.readTextLines(target, options, context))
      : fs.readTextLines(target, options, context)),
  readBinaryFile: op(z.tuple([path]), (fs, [target], context) => boundedRead(fs, target, context, () => fs.readBinaryFile(target, context))),
  writeFile: op(z.tuple([path, content]), (fs, [target, data], context) => fs.writeFile(target, data, context)),
  appendFile: op(z.tuple([path, content]), (fs, [target, data], context) => fs.appendFile(target, data, context)),
  truncateFile: op(z.tuple([path, z.number().int().nonnegative()]), (fs, [target, size], context) => fs.truncateFile(target, size, context)),
  flushFile: op(z.tuple([path]), (fs, [target], context) => fs.flushFile(target, context)),
  renameFile: op(z.tuple([path, path]), (fs, [source, destination], context) => fs.renameFile(source, destination, context)),
  fileInfo: op(z.tuple([path]), (fs, [target], context) => fs.fileInfo(target, context)),
  listDir: op(z.tuple([path]), (fs, [target], context) => fs.listDir(target, context)),
  canonicalPath: op(z.tuple([path]), (fs, [target], context) => fs.canonicalPath(target, context)),
  exists: op(z.tuple([path]), (fs, [target], context) => fs.exists(target, context)),
  createDir: op(z.tuple([path, optional(z.object({ recursive: z.boolean().optional() }).strict())]),
    (fs, [target, options], context) => fs.createDir(target, options, context)),
  remove: op(z.tuple([path, optional(z.object({ recursive: z.boolean().optional(), force: z.boolean().optional() }).strict())]),
    (fs, [target, options], context) => fs.remove(target, options, context)),
  createTempDir: op(z.tuple([optional(z.string())]), (fs, [prefix], context) => fs.createTempDir(prefix, context)),
  createTempFile: op(z.tuple([optional(z.object({ prefix: z.string().optional(), suffix: z.string().optional() }).strict())]),
    (fs, [options], context) => fs.createTempFile(options, context)),
}))

function wireValue(value: unknown) {
  return value instanceof Uint8Array ? { base64: Buffer.from(value).toString("base64") } : value
}

export async function runFileSystemOperation(fs: FileSystem, request: { op: string; args: unknown }, context: Context): Promise<FileSystemWireResult> {
  const operation = OPERATIONS.get(request.op)
  if (!operation) return { invalid: `Unknown file system operation ${request.op}` }
  const result = operation(fs, request.args, context)
  if (result instanceof z.ZodError) return { invalid: z.prettifyError(result) }
  const settled = await result
  if (settled.ok) return { ok: true, value: wireValue(settled.value) }
  const error = settled.error
  return { ok: false, error: { code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) } }
}
