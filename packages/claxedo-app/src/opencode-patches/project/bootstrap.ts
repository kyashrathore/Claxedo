/**
 * Instance Bootstrap (Claxedo Patched)
 *
 * This is a patched version of packages/opencode/src/project/bootstrap.ts
 * that adds process manager initialization on top of upstream bootstrap.
 *
 * CHANGES FROM UPSTREAM:
 * - Import and call Process loadConfig + watchConfig + initExitHandler + startAll
 */

import { Plugin } from "@/plugin"
import { Format } from "@/format"
import { LSP } from "@/lsp"
import { FileWatcher } from "@/file/watcher"
import { File } from "@/file"
import { Project } from "@/project/project"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Instance } from "@/project/instance"
import { Vcs } from "@/project/vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "@/snapshot"
import { Truncate } from "@/tool/truncation"
// CLAXEDO PATCH: Process manager
import * as ProcessManager from "../process/index"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  // CLAXEDO PATCH: Initialize process manager
  // Load config, watch for changes, set up exit handler, and auto-start processes
  try {
    await ProcessManager.loadConfig()
    ProcessManager.watchConfig()
    ProcessManager.initExitHandler()
    await ProcessManager.startAll()
  } catch (err) {
    Log.Default.warn("process manager init failed (non-fatal)", { err: String(err) })
  }
}
