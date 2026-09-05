# Chat, tools, and coding environments

**Draft user guide.** This describes the [reviewed proposal](../plans/2026-09-05-002-pi-worker-runtime-and-gateway-plan.md), not features already available in a release.

## Choose where your agent runs

In the existing composer, **Cloud** has two placements: **Worker** or **Sandbox**.

| Placement | Where the agent runs | When a machine is needed |
|---|---|---|
| Worker | Pi in workerd | When you authorize delegated machine work |
| Sandbox | The full agent in a cloud sandbox | Before the agent can respond |

Worker means workerd. You can chat without a repository, workspace or coding-machine startup. A full machine is an available tool: when the task needs native programs, the Worker agent can delegate to a child agent on that machine.

Both placements run in the cloud. A Worker session with a Sandbox child is still Worker; there is no Hybrid option.

## Use your preferred defaults

Choose Pi or OpenCode and a model, then choose Worker or Sandbox within Cloud. Save **Default cloud placement** separately for each harness. You can override placement for a draft without changing future chats; use **Use as default for Pi** or **Use as default for OpenCode** to save it.

The default action identifies whether it applies to the current workspace or workspace-less chats. Changing defaults never moves existing sessions. If a saved choice is unavailable, the composer explains why and blocks send until you select a supported placement.

This delivery proposes Pi in Worker and Sandbox, with OpenCode in Sandbox. OpenCode Worker support remains unavailable until its embedded integration is verified. Local and user-hosted destinations retain their existing flows where supported.

## Start with a conversation

With Worker selected, ask a question, work with an attachment, or use a connected service:

> Compare these proposals and draft a response.

No repository or coding machine is required. Tools use only granted resources and actions.

## Work with a repository without a machine

Attach a repository and branch. Claxedo resolves a specific revision so the agent reads a consistent snapshot.

> Explain how authentication works.

Repository tools read and search that revision. If a repository exceeds supported search limits, the result explains its coverage; it does not silently search a different branch.

For supported text changes, the agent can prepare a change proposal and, with write permission, open a pull request through GitHub without starting a machine. That does not mean it ran the project's tests. The report distinguishes proposed changes, published changes and observed test results.

## Ask for machine work

> Fix the authentication bug and run the tests.

The Worker agent calls its machine tool. Saved compute and history-sharing policy may already allow it; otherwise Claxedo shows the missing approval before starting anything.

A **child session** opens in a Sandbox and runs the full Pi coding agent. It receives the authorized parent history up to a completed boundary plus the task brief. The parent stays in Worker placement.

You can open the child beside the parent to see edits, commands and tests. When it finishes, a report returns as one tool result in the parent conversation, including the child link, summary, changed files, test evidence and any pull request link. The parent's turn continues from that report.

While waiting, the parent shows the child's status. This initial design waits for the child rather than offering simultaneous independent conversation in the same parent turn.

Sharing history matters: code and extensions in the child can read the exported history, including older entries omitted from the model's compacted context. Claxedo checks that the selected environment is authorized for that data.

## Where files live

Repository inspection uses the attached revision. Worker scratch files and proposed GitHub edits are saved separately. Neither automatically becomes a sandbox checkout.

Machine edits live in the child's checkout. A later child may reuse that checkout if it is still authorized, compatible and preserved by supported storage or a verified checkpoint. Dirty files are not silently reset when you request another branch.

There is no background merge between the parent's files and the child's checkout. A follow-up child reads the actual retained files, not merely the previous report. Claxedo displays whether the environment is saved and resumable.

## Extend Pi

Worker sessions can use skills, prompt templates, context files, approved remote MCP tools and Claxedo connectors. These add instructions or call authorized services; Worker does not load Pi code extension packages.

For a Pi package that registers code-based tools or hooks, select **Sandbox**. Use the existing Extensions flow to review its source, version, compatibility and requested access. Native packages run within the sandbox's permissions; terminal-only interfaces may not work in the app's RPC interface.

Enabling an incompatible package shows **Requires Sandbox** and offers an explicit placement action. It never silently starts a machine or changes your defaults.

Upstream provider credentials stay behind the gateway in the proposed setup. Sandbox code receives scoped, short-lived access and can use whatever files and permissions that environment grants. Disabling access prevents subsequent protected calls; it does not undo completed actions.

## Move an existing Worker session to Sandbox

Choose **Move to Sandbox** when you want the entire agent and its native extensions to run there. This is an explicit one-way action, separate from requesting an ordinary machine task.

Claxedo waits for a safe boundary, validates the target and transfers the supported conversation/configuration/files before switching placement. Your app session ID, URL and history stay the same. Afterward the sandbox must be available for the agent to respond.

If preparation fails before the switch, the Worker session remains recoverable. After the switch, recovery belongs to the sandbox; Claxedo does not silently move it back.

## When work is interrupted

- **Startup fails:** the conversation remains visible; retry refers to the existing preparation.
- **A child loses its connection:** its result may be unknown. Claxedo reconciles that child instead of starting another copy.
- **You cancel:** the child receives a cancellation request. An unreachable child stays cancellation-pending until stopped or fenced.
- **Worker restarts:** continuation depends on saved native context, configuration, scratch and operation state. Old messages alone do not prove recovery.
- **Access is revoked:** further protected calls are denied; the conversation explains which access is missing.
- **Files cannot be retained:** the environment must say so; it cannot claim the work is saved.

Start with Worker for bootless chat and supported service/repository work. Request a Sandbox child for native execution. Choose Sandbox placement when you want the full harness and native extensions available from the start.
