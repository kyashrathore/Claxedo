# Claxedo App Vocabulary

This file defines product terms independently of their UI placement.

## App and workbench

- **App**: the top-level composition root that installs platform services, feature contracts, routes, and global providers.
- **Workbench**: the persistent pane-and-surface environment under `app/workbench`. It owns panes, tabs, rail navigation, titlebar state, drag/drop, restoration, and route projection.
- **Pane**: one leaf in the workbench layout tree. A pane selects one content surface at a time and may retain previously activated surfaces.
- **Surface**: a user-visible content instance hosted by a pane, such as a session, terminal, document, review, browser, or workspace panel. A surface has a stable content ID and feature-owned payload.

## Project, workspace, and directory

- **Project**: a repository-level grouping presented to the user. A project may have several workspaces.
- **Workspace**: an execution and collaboration placement associated with a project. Its nominal identity is a workspace ID.
- **Directory**: a filesystem path used for local SDK and file operations. A directory is not a workspace identity.
- **Worktree**: a filesystem checkout associated with a project or workspace.
- **Workspace placement**: the runtime authority describing where and with what role a workspace executes. Placement is resolved by platform runtime services.
- **Workspace scope**: the mounted data/provider boundary for a particular workspace-backed surface.

## Sessions and execution

- **Session**: a durable conversation identified by a session ID and represented across query caches and feature state.
- **SessionRef**: the canonical typed identity that combines a session ID with its host/backing information. It determines whether a session is local, central, or workspace-backed.
- **Harness**: the selected agent execution integration, such as OpenCode or an ACP-backed runner.
- **Agent**: the behavioral profile selected within a harness.
- **Model**: the provider/model selection used for a provider turn.
- **Prompt admission**: accepting a user input into the durable session pipeline.
- **Provider turn**: one model execution step after admitted input and context have been assembled.

## Terminal and process

- **Terminal**: the interactive PTY feature and its rendered xterm surface.
- **PTY**: the server-side pseudo-terminal resource identified by a terminal ID.
- **Process**: a managed long-running command or agent task. A process may expose logs or a terminal but is not itself a pane or session.

## Platform and feature

- **Feature**: an independently owned user capability under `features/<name>`, including its domain logic, state, UI, and tests.
- **Platform capability**: shared headless infrastructure under `platform/<name>`, such as auth, query, files, identity, persistence, runtime placement, or synchronization.
- **Feature port**: a typed contract implemented by app composition so a feature can request app-owned behavior without a runtime feature-to-feature dependency.
- **Integration**: app-owned assembly connecting feature ports, commands, events, and lazy surfaces.

## State and identity contracts

- **Content ID**: stable identity for a workbench surface instance.
- **Pane ID**: stable identity for a workbench layout leaf.
- **Query key**: the durable cache namespace for server-derived data; each family has a declared writer.
- **Route projection**: synchronization between the selected workbench surface and the browser URL.
- **Nominal identity**: the authoritative ID of an entity, such as workspace ID or session ID, rather than a path, label, or transient UI key.

## Package scope

Claxedo-owned product packages use the `@claxedo/*` scope. `@claxedo/app` is the public app package. Within `claxedo-app`, `@/` resolves to its `src` root; cross-package imports use real package names.
