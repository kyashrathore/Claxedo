/**
 * VCS Diff Routes
 *
 * HTTP adapter for workspace diff operations.
 */

import { Hono } from "hono"
import { lazy } from "../lazy"
import { errorBody } from "./http"
import { assertTarget, hasWorkspaceTarget, WorkspaceTargetError } from "../target"
import {
  GitTimeoutError,
  createDiffRuntime,
  diffBaseTargets,
  diffRefs,
  diffSummary,
  filePatchDiff,
  isRangeMode,
  refsExist,
  relativeDiffFile,
  stagedDiff,
  toFromDiff,
  uncommittedDiff,
  unstagedDiff,
  validRefSyntax,
  type DiffRoutesDeps,
  type DiffRuntime,
  type FileDiff,
} from "../workspace-files/diff"

function directoryRequired() {
  return errorBody("diff_directory_required", "Missing required query param: directory")
}

type DiffRouteContext = {
  req: {
    query: (key: string) => string | undefined
    header: (key: string) => string | undefined
  }
}

function diffTargetDirectory(c: DiffRouteContext) {
  const requested = c.req.query("directory") || c.req.header("x-opencode-directory")
  if (requested) return assertTarget(requested)
  if (hasWorkspaceTarget()) return assertTarget(undefined)
}

function diffDirectory(c: DiffRouteContext) {
  try {
    return { directory: diffTargetDirectory(c) }
  } catch (err) {
    if (err instanceof WorkspaceTargetError) {
      return {
        error: errorBody("diff_invalid_directory", "Diff directory must match configured workspace"),
      }
    }
    throw err
  }
}

function fileRequired() {
  return errorBody("diff_file_required", "Missing required query param: file")
}

function invalidFilePath() {
  return errorBody("diff_invalid_file_path", "Invalid relative diff file path")
}

function invalidRef() {
  return errorBody("diff_invalid_ref", "Invalid git ref")
}

function gitTimeoutBody() {
  return errorBody("diff_git_timeout", "Git command timed out")
}

async function validateRangeRefs(runtime: DiffRuntime, directory: string, fromRef: string | undefined, toRef: string | undefined) {
  if (!fromRef || !toRef) {
    return errorBody("diff_refs_required", "to-from mode requires fromRef and toRef")
  }
  if (!validRefSyntax(fromRef) || !validRefSyntax(toRef)) return invalidRef()
  if (!await refsExist(runtime, directory, fromRef, toRef)) return invalidRef()
}

function routeFailure(err: unknown) {
  if (err instanceof GitTimeoutError) {
    return { body: gitTimeoutBody(), status: 504 as const }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { message: msg, status: 500 as const }
}

export function createDiffRoutes(deps: DiffRoutesDeps = {}) {
  const runtime = createDiffRuntime(deps)
  return new Hono()
    .get("/targets", async (c) => {
      const result = diffDirectory(c)
      if (result.error) return c.json(result.error, 400)
      const directory = result.directory
      if (!directory) return c.json(directoryRequired(), 400)
      try {
        return c.json(await diffBaseTargets(runtime, directory))
      } catch (err) {
        const failure = routeFailure(err)
        if ("body" in failure) return c.json(failure.body, failure.status)
        return c.json(errorBody("diff_targets_failed", failure.message), failure.status)
      }
    })
    .get("/vcs", async (c) => {
      const result = diffDirectory(c)
      if (result.error) return c.json(result.error, 400)
      const directory = result.directory
      if (!directory) return c.json(directoryRequired(), 400)

      const mode = c.req.query("mode") ?? "uncommitted"
      const fromRef = c.req.query("fromRef")
      const toRef = c.req.query("toRef")
      const content = c.req.query("content") ?? "full"

      try {
        if (isRangeMode(mode)) {
          const refsError = await validateRangeRefs(runtime, directory, fromRef, toRef)
          if (refsError) return c.json(refsError, 400)
        }

        const diffs: FileDiff[] = content === "summary"
          ? await diffSummary(runtime, directory, mode, fromRef, toRef)
          : mode === "staged"
            ? await stagedDiff(runtime, directory)
            : mode === "unstaged"
              ? await unstagedDiff(runtime, directory)
              : isRangeMode(mode)
                ? await toFromDiff(runtime, directory, fromRef!, toRef!)
                : await uncommittedDiff(runtime, directory)
        return c.json(diffs)
      } catch (err) {
        const failure = routeFailure(err)
        if ("body" in failure) return c.json(failure.body, failure.status)
        return c.json(errorBody("diff_vcs_failed", failure.message), failure.status)
      }
    })
    .get("/vcs/file", async (c) => {
      const result = diffDirectory(c)
      if (result.error) return c.json(result.error, 400)
      const directory = result.directory
      if (!directory) return c.json(directoryRequired(), 400)

      const file = c.req.query("file")
      if (!file) return c.json(fileRequired(), 400)
      if (!relativeDiffFile(file)) return c.json(invalidFilePath(), 400)

      const mode = c.req.query("mode") ?? "uncommitted"
      const fromRef = c.req.query("fromRef")
      const toRef = c.req.query("toRef")

      if (isRangeMode(mode)) {
        const refsError = await validateRangeRefs(runtime, directory, fromRef, toRef)
        if (refsError) return c.json(refsError, 400)
      }

      try {
        return c.json(await filePatchDiff({ runtime, directory, mode, fromRef, toRef, file }))
      } catch (err) {
        const failure = routeFailure(err)
        if ("body" in failure) return c.json(failure.body, failure.status)
        return c.json(errorBody("diff_vcs_file_failed", failure.message), failure.status)
      }
    })
    .get("/refs", async (c) => {
      const result = diffDirectory(c)
      if (result.error) return c.json(result.error, 400)
      const directory = result.directory
      if (!directory) return c.json(directoryRequired(), 400)

      try {
        return c.json(await diffRefs(runtime, directory))
      } catch (err) {
        const failure = routeFailure(err)
        if ("body" in failure) return c.json(failure.body, failure.status)
        return c.json(errorBody("diff_refs_failed", failure.message), failure.status)
      }
    })
}

export const DiffRoutes = lazy(() => createDiffRoutes())
