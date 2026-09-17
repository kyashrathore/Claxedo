# Using Pi in Claxedo

Choose Pi in the session composer, then choose the machine where the session
will run. **Local** uses a directory on your computer. **Cloud** uses a sandbox.
Pi and its tools run together on that machine. A Cloud session needs its sandbox
to start before Pi can run.

Claxedo starts Pi 0.85.1 in RPC mode. For Local, install that version and make
`pi` available on PATH, or set `PI_EXECUTABLE` to its executable. The sandbox
images install the same version. The model picker reads the models available to
that Pi process; connect a provider before selecting its model.

Claxedo keeps the visible conversation and controls starting, stopping and
answering questions. Pi keeps its native conversation file, chooses the context
sent to the model and performs automatic compaction. Restarting an idle process
resumes that same file. If the file is missing, Claxedo reports an error rather
than silently starting another conversation. Repository memory files and other
files written by the agent live on the selected machine.

## Extending Pi

Use Pi's native extensions, skills and project configuration in the machine
where the session runs. Put project extensions in `.pi/extensions/`. Pi loads
project extensions only after that project is trusted. Claxedo does not grant
trust automatically. A host-controlled Pi profile can contain trusted global
extensions and explicit trust decisions.

Extensions execute code with Pi's machine permissions. For extensions you do not
want running on your computer, choose Cloud and an isolated sandbox. Do not give
an extension secrets or filesystem access you would not give another program on
that machine. Extension input, selection and confirmation requests appear as
Claxedo questions. Stopping a session cancels its pending question and turn.

Claxedo uses a separate Pi profile for managed credentials. It does not rewrite
your personal Pi configuration. Connected credentials are projected to that
profile; registry-managed OAuth refresh tokens stay with the credential owner.
Deleting or disconnecting a provider must be applied to the runtime before Pi
can use the updated model catalog.

By default, a workspace runtime keeps its managed profile under
`<runtime-store>/pi/agent`. To configure a host-owned profile, set
`PI_CODING_AGENT_DIR` before starting the host, or pass `agentDir` when embedding
the Pi adapter. Use a dedicated directory: Claxedo manages and clears its
`auth.json`; the profile's settings, models and extensions remain native Pi
configuration. Adapters in one host process can share the override: closing one
keeps credentials available to the others, and closing the final adapter clears
them. Independent host processes and different credential identities must use
separate profiles.

## What this release supports

All harness sessions have a machine and workspace directory. There is no
central, virtual or hybrid Pi execution mode. Worker agents and workspace-less
chat remain a separate planned feature; they are not another placement option
in this release.

Pi supplies its native file, search and shell tools. Inline image attachments
are supported. Refer to other workspace files by path. Pi does not provide
Claxedo permission prompts or native subagents. MCP support requires a Pi
extension; configuring a Claxedo MCP server alone does not add it to upstream Pi.
