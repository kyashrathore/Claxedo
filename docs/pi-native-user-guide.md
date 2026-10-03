# Using Pi in Claxedo

Choose Pi in the session composer, then choose the machine where the session
will run. **Local** uses a directory on your computer. **Cloud** uses a sandbox.

Pi runs inside Claxedo; there is nothing to install. Claxedo embeds Pi's own
agent library (`@earendil-works/pi-durable`) and runs one Pi agent per session
in the workspace runtime's process. The `pi` command line, its profile in
`~/.pi` and its extensions are not used: Claxedo never reads or writes that
folder.

## Models and accounts

The model picker lists Pi's models for the providers you have connected in
Claxedo: OpenAI (a key, or a ChatGPT plan through `openai-codex`), Anthropic (a
key or a Claude plan), OpenRouter, Google, Groq, xAI, and the custom providers
you added. Pi calls the provider directly with the account you selected; no
other account and no environment variable is ever used. A model whose provider
has no connected account is refused before the turn starts. When Claxedo renews
an account's token, Pi uses the new one on its next request without restarting
anything.

On a machine you own, your sessions spend your own accounts. A person you
share a session with spends your accounts on it too, as with every harness. A
session another person owns on your machine cannot run Pi, because Pi needs its
owner's account delivered to this machine and Claxedo delivers only yours.

## Conversations

Pi keeps each session's conversation in its own SQLite file under the runtime's
harness folder (`<harness state>/pi/sessions/<session id>.sqlite`). Pi chooses
the context sent to the model, compacts older context when it nears the model's
window, and retries a failed model request on its own; Claxedo shows both as
the session compacting and retrying.

If the computer or the runtime stops in the middle of a turn, the turn shows as
interrupted, and when the runtime starts again Pi picks the work up where it
stopped and answers in a new reply. A tool call that was running when it
stopped is not run twice: Pi tells the model it was interrupted.

Stopping a turn cancels the model request and kills any command Pi is running.

## Tools, permissions and questions

Pi has its own `read`, `write`, `edit` and `bash` tools, working in the
session's directory. Each command runs as a process Claxedo owns, and it ends
with its command: a background job a command starts does not outlive it.
Inline image attachments are supported; refer to other files by path.

The permission mode decides whether Pi asks first. **Full access** (the
default) runs every tool call. **Ask** asks before each write, edit, command
and MCP tool call; "Always allow" remembers the answer for that tool in the
session.

Pi can ask you a question while it works; the turn waits for your answer.

## MCP servers and plugins

The MCP servers you configure in Claxedo, Claxedo's own server (local sessions
only) and the MCP servers and skills of the agent plugins you enable reach Pi
per session: one session never sees another's servers, accounts or tools.
HTTP and stdio servers work; SSE servers are not supported. A stdio server
starts with the environment you configured for it plus the usual `PATH`,
`HOME`, `USER`, `SHELL` and `TERM`, never the runtime's own environment. Plugin
skills are listed to Pi with their descriptions, and Pi reads a skill's
`SKILL.md` when a task matches it.

Pi has no subagents and no slash commands in Claxedo.
