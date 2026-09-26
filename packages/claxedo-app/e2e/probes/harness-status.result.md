# P0.7 probe: harness status on the stream the app reads

Recorded 2026-09-24T07:41:29.391Z against the real self-hosted daemon (app=v2), reading `/api/wr/events?directory=…`, the stream today's app subscribes to. Each row is one turn; a cell says whether that event type arrived on the stream for that session during the turn, and how many times.

| Harness | Turn | Outcome | session.status | session.idle | session.error | permission.asked | question.asked | agent.lifecycle | session.status types |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acp | text | turn completed | yes (2) | yes (1) | no | no | no | none | busy, idle |
| acp | permission | permission answered once through the API | yes (2) | yes (1) | no | yes (1) | no | none | busy, idle |
| acp | question | question answered through the API | yes (2) | yes (1) | no | no | yes (1) | none | busy, idle |
| acp | error | turn completed | yes (1) | no | yes (1) | no | no | none | busy |
| pi | text | turn completed | yes (1) | yes (1) | no | no | no | none | busy |
| pi | error (model answers 401) | turn completed | yes (1) | no | yes (1) | no | no | none | busy |
| claude | text | turn completed | yes (2) | yes (1) | no | no | no | none | busy, idle |
| claude | error (model answers 401) | turn completed | yes (1) | no | yes (1) | no | no | none | busy |
| codex | text | turn completed | yes (5) | yes (1) | no | no | no | none | busy, busy, busy, idle, idle |
| codex | error (model answers 401) | turn completed | yes (3) | no | yes (2) | no | no | none | busy, busy, busy |

## Findings

- 10 of 10 turns ended with `session.idle` or `session.error` on the stream.
- 5 turns never sent `session.status: idle`; their last status stayed `busy` or absent: acp error; pi text; pi error (model answers 401); claude error (model answers 401); codex error (model answers 401). Only `session.idle` or `session.error` ends those turns.

## Every frame type seen per turn

- acp / text: session.status, message.updated, message.part.updated, message.updated, message.part.updated, message.part.delta, message.part.updated, message.part.delta, runtime.diagnostic, session.status, message.completed, session.idle
- acp / permission: session.status, message.updated, message.part.updated, message.updated, message.part.updated, message.part.updated, message.part.updated, permission.asked, permission.replied, message.part.updated, message.part.updated, message.part.updated, message.part.delta, runtime.diagnostic, session.status, message.completed, session.idle
- acp / question: session.status, message.updated, message.part.updated, message.updated, question.asked, question.replied, question.replied, message.part.updated, message.part.delta, runtime.diagnostic, session.status, message.completed, session.idle
- acp / error: session.status, message.updated, message.part.updated, message.updated, message.part.updated, message.part.delta, message.updated, message.updated, session.error
- pi / text: session.status, message.updated, message.part.updated, message.updated, message.part.updated, message.part.delta, session.usage, message.completed, session.idle
- pi / error (model answers 401): session.status, message.updated, message.part.updated, message.updated, session.usage, message.updated, message.updated, session.error
- claude / text: session.status, message.updated, message.part.updated, message.updated, session.commands, runtime.diagnostic, session.usage, message.part.updated, message.part.delta, session.usage, session.status, message.completed, session.idle
- claude / error (model answers 401): session.status, message.updated, message.part.updated, message.updated, session.commands, runtime.diagnostic, runtime.diagnostic, message.updated, message.updated, session.error
- codex / text: session.status, message.updated, message.part.updated, message.updated, runtime.diagnostic, runtime.diagnostic, session.status, session.status, message.part.updated, message.part.delta, session.usage, runtime.diagnostic, session.status, session.status, message.completed, session.idle
- codex / error (model answers 401): session.status, message.updated, message.part.updated, message.updated, runtime.diagnostic, runtime.diagnostic, runtime.diagnostic, session.status, session.status, runtime.diagnostic, runtime.diagnostic, runtime.diagnostic, runtime.diagnostic, runtime.diagnostic, session.error, message.updated, session.error

## Skipped

- none
