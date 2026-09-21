# Where task automation fits: 60 public use cases

Research date: 2026-09-20. Assessment target: the proposed [task automation design](../plans/2026-09-20-001-task-automation-design.md), not a claim of shipped Claxedo capability.

## Finding

**Keep Task → Run → Session. Add durable continuation and context before claiming general assistant coverage.** One-time versus recurring is a useful distinction about the work's objective. It must not prohibit a one-time task from waking repeatedly before it finishes.

The examples expose three different operations: **start a new occurrence**, **resume existing work**, and **create related work**. A schedule that always creates a fresh run cannot represent all three correctly.

The agreed statuses can stay: recurring tasks are Active/Paused; one-time tasks advance toward Done. Individual runs own Running/Needs you/Completed/Failed. Extend the proposed run model with explicit waiting metadata for timers, external replies, and dependencies; reserve Needs you for an actual user action.

## Evidence and limitations

- Grok means **Grok Bot**, Muse means **Meta Muse**, and “instict” is provisionally resolved to **Instinct at instinct.com**. Squad means **squad.so**, not the similarly named crypto product.
- **User report:** firsthand text on Reddit or App Store, read directly. Self-reported success is not independently reproduced reliability evidence.
- **User experiment:** the author is testing a workflow; specific success may be incomplete. Mixed results are retained.
- **Reproduced user post:** an X post read through Messaging Agents, which includes the author, date, text, and original URL. Direct X retrieval failed for sampled posts. The matrix includes both the accessible evidence page and original post where available. This is weaker than a directly retrieved primary post.
- **Vendor-hosted testimonial:** a named customer's account selected and hosted by the vendor. **Vendor example/scenario:** an advertised workflow, not independent proof that a customer completed it.
- The Muse referral post has an incentive; the passport post is reported in a vendor campaign context. Neither is treated as neutral validation.
- Independent detailed Squad usage accounts were sparse in this search. Its rows deliberately contain mostly vendor examples, with one specific named customer testimonial. Generic praise is excluded.
- Dates shown by Reddit/search caches were inconsistent in places. This document records the retrieval date rather than inventing exact post dates. This is a purposive use-case sample, not a market-share or reliability benchmark.
- Lifecycle mappings, requirements, and UI text below are **our design analysis**, not statements about competitor internals. A “Fits” row still needs actual tools, permissions, execution infrastructure, and verification. An “Extend” row can retain the Task/Run vocabulary but needs additional semantics or state.

## How to read the matrix

**Fits:** the proposed lifecycle can express the job; fill in execution/delivery capabilities. **Extend:** add durable context, waits, triggers, related-work ownership, or reusable artifacts. Requirements use gap IDs defined after the matrix. A Fits row can still need an execution-layer gap such as browser takeover or action receipts.

Each table includes the reported workflow, person/evidence, proposed Claxedo shape, lifecycle verdict, implementation requirements, and what the user would see. The [CSV](2026-09-20-task-automation-usecase-matrix.csv) contains separate columns and original source URLs for sorting/filtering.

## Grok Bot

| # | Reported use case | Person and evidence | Proposed shape / fit | Requirements beyond a scheduled prompt | UI outcome |
| --- | --- | --- | --- | --- | --- |
| 1 | Morning personal briefing | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring; one briefing per day · **Fits** | Calendar/mail connectors; result delivery | Active; latest run Completed; read brief |
| 2 | Background inbox classification and urgent alerts | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring scan; cases for actionable messages · **Extend** | G1 events/cursors; G6 per-message cases; notification policy | Active; 3 messages need review |
| 3 | Budget review and upcoming-payment alerts | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring financial check · **Extend** | G2 durable account context; change-only alerts; read-only connector | Active; latest findings and next check |
| 4 | Cancel subscription and negotiate its fee | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | One-time objective · **Extend** | G3 wait/resume; support browser; bounded approval | In progress: waiting for support; Done on confirmation |
| 5 | Weekday job discovery | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring search · **Extend** | G2 seen-job ledger and preferences; notifications | Active; new matches only |
| 6 | Tailor a CV interactively | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | One-time objective · **Fits** | Document tools; explicit user review; scoped writing context | Needs you: review CV; Done after accepted result |
| 7 | Watch deals and buy selected products | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring discovery; one-time purchase per selection · **Extend** | G2 preferences; G6 child work; G7 purchase ledger and limits | Active watch; selected purchase Needs you |
| 8 | Watch CI and service health | steve228uk — User report; [G1](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/) | Recurring checks; incident work when needed · **Extend** | G1 event/cursor support; G6 incident identity; alerts | Active; current incident linked separately |
| 9 | Morning expired-property listings | Wkuhank — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring digest · **Extend** | G2 seen-listing state; MLS access; text delivery | Active; latest new listings |
| 10 | Travel deals matched to family availability | Wkuhank — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring search · **Extend** | G2 preferences/calendar context; deduplicated alerts | Active; matching offers and source dates |
| 11 | Build a website | Wkuhank — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | One-time objective · **Fits** | Coding runtime; preview/artifact; outcome validation | In progress then Done; open website |
| 12 | Meal planning, groceries and ordering | CommitteeDry5570 — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring plan; purchase work per cycle · **Extend** | G2 pantry/budget state; G7 authorized checkout; Notion/store tools | Active; plan ready; order approval |
| 13 | School data pulled into a dashboard | mrsooner — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | One-time dashboard; recurring refresh · **Extend** | G2 data cursor; G8 durable artifact; authenticated portal | Dashboard link with latest refresh result |
| 14 | Book business travel and share itinerary | sporksnkives — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | One-time objective · **Fits** | Travel/browser tools; authorized purchase/send; confirmation receipts | Needs you at decision; Done with itinerary |
| 15 | Process expense receipts | sporksnkives — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Incoming receipt creates one-time work · **Extend** | G1 attachment events; G2 processed-receipt ledger; accounting access | One task per expense; receipt and filing result |
| 16 | Draft follow-ups for overdue deliverables | sporksnkives — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring scan; follow-up per commitment · **Extend** | G2 commitments; G3 response waits; G6 case-level handling | Active; drafts needing review, not one blocked scan |
| 17 | POS data converted to accounting CSV | tbone985 — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring export · **Fits** | POS access; transformation validation; artifact output | Active; latest CSV and reporting period |
| 18 | Daily store KPI email | tbone985 — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring report · **Fits** | Data connectors; goal configuration; authorized email delivery | Active; latest report and delivery result |
| 19 | Production errors turned into draft PRs | FedRCivP11 — User report; [G2](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/) | Recurring detector; one-time fix per issue · **Extend** | G2 issue deduplication; G6 linked fix tasks; code/review tools | Active monitor; fix tasks with independent review |
| 20 | Game feedback to specs, issues and gameplay QA | cumbiaowl — Experiment; mixed results; [G3](https://www.reddit.com/r/aigamedev/comments/1wd110k/grok_bot_claude_routines_updates_after_user/) | Parent objective with dependent work · **Extend** | G5 dependencies and handoff; human gameplay evaluation | Task progress plus reviewer-owned QA; no auto-pass |

## Muse

| # | Reported use case | Person and evidence | Proposed shape / fit | Requirements beyond a scheduled prompt | UI outcome |
| --- | --- | --- | --- | --- | --- |
| 21 | Find and download a product manual | _n8tr — User report; [M1](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch&see-all=reviews) | One-time objective · **Fits** | Web access; durable downloaded artifact | Done; open manual with source |
| 22 | Book a rental car | grade e — User report; [M1](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch&see-all=reviews) | One-time objective · **Fits** | Booking tools; purchase authority; confirmation | Needs you for selection; Done with booking |
| 23 | Daily interests and calendar reminder | grade e — User report; [M1](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch&see-all=reviews) | Recurring digest · **Fits** | Calendar/context access; notification destination | Active; latest briefing |
| 24 | Check giveaway results daily | Carmen — User report; later lost access; [M1](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch&see-all=reviews) | Recurring check or bounded one-time watch · **Extend** | G2 seen results; G4 expiry; explicit account-access failure | Next check or watch expired; visible access problem |
| 25 | Road-trip planning with a later road-closure recheck | Derderberber — User report; [M2](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch) | One-time objective with future wake-up · **Extend** | G3 wake same task; G4 departure deadline | In progress: checking again before departure |
| 26 | Track internship applications and deadlines | Durairaj Avasi — User report; [M2](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch) | Recurring check; application cases · **Extend** | G2 application ledger; G6 independent application progress | Active; approaching deadlines and application links |
| 27 | Local events calendar from social accounts | Yo-b-rad — User report; [M2](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch) | One-time calendar build; optional refresh · **Fits** | Authorized social/calendar access; provenance | Done; open calendar; recurrence only if requested |
| 28 | Clear a large unread-email backlog | Acceptable-Brain1592 — User report; referral incentive; [M3](https://www.reddit.com/r/AiBuilders/comments/1wkxt11/my_daily_driver_now_muse_ai_assistant_with_its/) | One-time batch objective · **Extend** | G2 processed-message checkpoint; G7 replay-safe mutations | Progress by message count; unresolved items separate |
| 29 | Watch bills | Acceptable-Brain1592 — User report; sparse detail; [M3](https://www.reddit.com/r/AiBuilders/comments/1wkxt11/my_daily_driver_now_muse_ai_assistant_with_its/) | Recurring check · **Extend** | G2 bill state; connector and alert rules; exact behavior unspecified | Active; changes and upcoming due dates |
| 30 | Passport form with browser handoff | Cyrus / @cy_zanfar — Reproduced user post; campaign context; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/cy_zanfar/status/2099684668391969009) | One-time objective · **Fits** | G9 browser takeover request; identity-document handling | Needs you: complete form step; resume same task |
| 31 | Freezer purchase through delivery and registration | @v01dp1r4t3 — Reproduced user post; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/v01dp1r4t3/status/2099210555303076147) | One-time objective spanning external events · **Extend** | G3 delivery wait; G7 order identity; browser/payment tools | In progress: waiting for delivery; Done after registration |
| 32 | Medication purchase and future replenishment | Sina / @SinaHartung — Reproduced user post; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/SinaHartung/status/2099528867119497228) | One-time setup; state-based repeat work · **Extend** | G2 remaining-supply state; G3 future wake; authorized provider actions | Next refill date; explicit confirmation at applicable steps |
| 33 | Nudge user to finish booking a doctor | Vasanth / @vasanthroughput — Reproduced user post; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/vasanthroughput/status/2100038958596153575) | One-time objective waiting on user · **Extend** | G3 durable reminders and completion acknowledgement | Needs you: make booking; next reminder visible |
| 34 | Photo shopping list fulfilled across stores | Dylan Heagy — Reproduced user post; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/dylan_heagy/status/2097721746094698775) | One-time objective with clarification · **Fits** | Image input; store tools; G7 separate order receipts | Needs you: clarify items; Done with orders |
| 35 | Clinic voicemail, reply and calendar booking | Jamal Hinton / @MalGsx — Reproduced user post; [M4](https://messagingagents.com/agents/muse) · [original](https://x.com/MalGsx/status/2099504838522380421) | One-time objective spanning a reply · **Extend** | G1 reply correlation; G3 wait; telephony/email/calendar | In progress: awaiting clinic; Done on confirmation |

## Instinct, including a cross-product experiment

| # | Reported use case | Person and evidence | Proposed shape / fit | Requirements beyond a scheduled prompt | UI outcome |
| --- | --- | --- | --- | --- | --- |
| 36 | Order snacks across apps | Sad-Locksmith5980 — User experiment; [I1](https://www.reddit.com/r/AI_Agents/comments/1wak4is/ive_been_stresstesting_instinct_with_reallife/) | One-time objective · **Fits** | Store access; purchase permission; confirmed orders | Needs you if checkout blocked; Done with receipt |
| 37 | Check flight prices several times daily | Sad-Locksmith5980 — User experiment; [I1](https://www.reddit.com/r/AI_Agents/comments/1wak4is/ive_been_stresstesting_instinct_with_reallife/) | Bounded watch for one trip · **Extend** | G2 price history; G4 travel deadline and stop condition | In progress: next price check; stop after trip/booking |
| 38 | Check whether parents took their walk | Sad-Locksmith5980 — User experiment; outcome not separately detailed; [I1](https://www.reddit.com/r/AI_Agents/comments/1wak4is/ive_been_stresstesting_instinct_with_reallife/) | Recurring check-in · **Extend** | G1 replies; G3 wait; authorized contact channel | Active; response pending, distinct from Needs you |
| 39 | Research startups into concise notes | Sad-Locksmith5980 — User experiment; [I1](https://www.reddit.com/r/AI_Agents/comments/1wak4is/ive_been_stresstesting_instinct_with_reallife/) | One-time objective · **Fits** | Research tools; citations and result artifact | Done; read notes |
| 40 | Twice-weekly missing-assignment checks | Deirdre Bosa — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/dee_bosa/status/2098608285347950802) | Recurring report · **Fits** | Authenticated school portal; report delivery | Active; latest report and next check |
| 41 | Warranty claim and repair scheduling | Eli Weiss — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/eliweisss/status/2098918455957189107) | One-time objective · **Extend** | G3 external wait; receipt lookup; support access | In progress: waiting on manufacturer; evidence at Done |
| 42 | Obtain airline-delay compensation | Gil / @gilgNYC — Reproduced user post; process unspecified; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/gilgNYC/status/2098192568584400986) | One-time objective · **Extend** | G3 claim wait; outcome verification; submission channel audit | Submitted is progress; Done requires defined claim outcome |
| 43 | Cancel subscriptions tied to inaccessible email | Zain / @NotZainAgain — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/NotZainAgain/status/2097150500038725895) | One-time objective · **Extend** | G3 support follow-up; account verification handoff | Needs you for identity; wait for cancellation confirmation |
| 44 | Find unclaimed property and submit claims | Matt Van Horn — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/mvanhorn/status/2097502118789984688) | One-time batch objective · **Extend** | G6 claim-level progress; document/signature authorization; evidence | Per-claim receipts; Done scoped to submission, not payout |
| 45 | Apartment search over several days | Tamara Winter — Reproduced user post; mechanics unspecified; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/tamarawinter/status/2099859471237361962) | One-time objective with repeated checks · **Extend** | G2 shortlist; G3 wake; G4 end condition | In progress; next check; Done when chosen objective met |
| 46 | Recover a personal event video via outreach | Olivia / @oliviaalevine — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/oliviaalevine/status/2095705075633000815) | One-time objective spanning replies · **Extend** | G1 response correlation; G3 wait; evidence/artifact | Waiting for producer; Done with retrieved video |
| 47 | Book gym class using calendar and preferences | Caroline Clark — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/carolinedclark/status/2101315974058406272) | Standing responsibility producing bookings · **Extend** | G2 preferences; G1 calendar changes; explicit action policy | Active responsibility; booking result and next opportunity |
| 48 | Delivery email prompts parcel follow-up | Advait Marathe — Reproduced user post; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/AdvaitMarathe/status/2097347707971293357) | Delivery event advances an existing order task · **Extend** | G1 email/order correlation; G3 follow-up; messaging permission | Order timeline; ask before contacting another person |
| 49 | Shared-sheet lead research and app QA handoff | Zev / @ZevLapin — Reproduced user experiment; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/ZevLapin/status/2100774170783309977) | Parent objective with coordinated workers · **Extend** | G5 claims/dependencies; shared artifact; external-agent boundaries | Who owns each work item; linked outputs and review |
| 50 | Restaurant availability polling caused account restriction | JC Bahr-de Stefano — Reproduced failure report; [I2](https://messagingagents.com/agents/instinct) · [original](https://x.com/jbahrdestefano/status/2096676801204404604) | Bounded reservation watch · **Extend** | G4 stop/deadline; G7 request budget/backoff and action limits | Show checks/cost; stop on restriction; never endless retry |

## Squad

| # | Reported use case | Person and evidence | Proposed shape / fit | Requirements beyond a scheduled prompt | UI outcome |
| --- | --- | --- | --- | --- | --- |
| 51 | Team task tracker with twice-daily nudges | Ankush Gupta — Vendor-hosted customer testimonial; [S1](https://squad.so/) | One-time setup; recurring reminders · **Extend** | G2 team commitments; G6 assignees/cases; Sheets/Chat tools | Active reminder task; individual overdue commitments |
| 52 | Chase overdue invoices | Squad example — Vendor example; [S1](https://squad.so/) | Recurring scan; one-time invoice cases · **Extend** | G2 invoice state; G3 replies; G6 cases; send authority | Active; invoice-level follow-ups and approvals |
| 53 | Triage inbox and answer routine messages | Squad example — Vendor example; [S1](https://squad.so/) | Recurring/event intake; message cases · **Extend** | G1 intake; G6 independent cases; G7 send policy | Active; review queue separate from routine replies |
| 54 | Weekly revenue/refunds/ad-spend report | Squad example — Vendor example; [S1](https://squad.so/) | Recurring report · **Fits** | Finance/ad connectors; report artifact | Active; latest report and next run |
| 55 | Prospect research, outreach and follow-up | Squad example — Vendor example; [S1](https://squad.so/) | Recurring discovery; one-time prospect cases · **Extend** | G2 contact history; G3 replies; G6 cases; outreach limits | Active; prospect pipeline and approvals |
| 56 | Check stuck orders and resolve exceptions | Squad example — Vendor example; [S1](https://squad.so/) | Recurring detector; order-resolution cases · **Extend** | G2 order ledger; G6 cases; G7 refund authority/idempotency | Active; unresolved orders with individual decisions |
| 57 | Find Slack decision history and write Notion summary | Squad demo — Vendor example; [S1](https://squad.so/) | One-time objective · **Fits** | Slack/Notion connectors; source-linked document | Done with document; Needs you for unresolved decision |
| 58 | Teach a support procedure for reuse | Squad demo — Vendor example; [S1](https://squad.so/) | One-time procedure creation; reuse in later tasks · **Extend** | G8 versioned skill/SOP owner; review and permissions | Review procedure; later runs show version used |
| 59 | Weekday social publishing queue | Squad demo — Vendor example; [S1](https://squad.so/) | Recurring content work · **Extend** | G2 publishing ledger; G7 approval/send-once; destination tools | Active; drafts and publication receipts |
| 60 | Research findings handed to a content worker | Squad article — Vendor scenario; [S2](https://squad.so/resources/mission-control-for-claude-code) | Recurring discovery; dependent writing tasks · **Extend** | G5 dependency dispatch; G6 child tasks; shared artifacts | Active research; linked writing tasks and ownership |

## Gap matrix: what actually needs to change

These are proposed additions, not findings that every underlying Claxedo subsystem lacks the capability. The earlier document leaves them unspecified; an implementation audit must establish which existing owner to extend.

| Gap | Why task + schedule + fresh session is insufficient | Smallest useful addition | First-release position |
| --- | --- | --- | --- |
| G1. Events and correlation | Email replies, new receipts, CI failures, and calendar changes arrive between ticks. A timer cannot identify which existing case they belong to. | Trigger envelope with source, external ID, correlation key, deduplication key, and either start-new or resume-existing intent. Polling can supply the same envelope initially. | Start with scoped polling; do not prevent later event adapters. |
| G2. Durable context and work ledger | Fresh runs otherwise rediscover jobs, resend reminders, or forget changed preferences. Transcripts alone are an unreliable processing ledger. | Explicit context references plus typed cursors/processed-item records at the appropriate task or connector owner. Preserve receipts independently of prompt memory. | Needed for any mutating recurring workflow. Stateless reports may come first. |
| G3. Waiting and continuation | Waiting for a vendor reply is neither Running nor Needs you. Restarting from scratch risks repeating completed actions. | A persisted wait reason, wake time or event key, checkpoint, timeout behavior, and resume command on the existing run. | Needed before claiming multi-day errands. |
| G4. Bounded watches | A trip-price watch or apartment search has one finish line even when it checks repeatedly. It must stop on completion, expiry, or cancellation. | One-time task with repeated wake-ups, an explicit deadline/stop condition, and the next check visible. | Keep one-time/recurring types; separate wake cadence from type. |
| G5. Dependencies and handoff | Research, implementation, and review can have different owners and prerequisites. Several unrelated schedules cannot guarantee order. | Related task references, completion dependencies, claim/ownership rules, and explicit artifact handoff. | Defer general graphs; support a narrow create-related-task path first. |
| G6. Independent cases inside a standing responsibility | One invoice needing approval must not stop every future invoice scan. A single unresolved-run lock is too coarse for inboxes and support queues. | Short detector runs create/deduplicate one-time cases by external identity. Approval belongs to the case; detector keeps its schedule. | Necessary for business queues; initially show linked one-time tasks. |
| G7. Action authority, receipts, and limits | Restarting a session must not send, purchase, or refund twice. A task budget must also bound connector traffic, not just model tokens. | Runtime-enforced action scope/approval, external action IDs/receipts, reconciliation before retries, per-task budgets, backoff, and stop controls. | Required before autonomous external writes. Reuse existing authorization owners. |
| G8. Durable outputs and reusable procedures | A useful result can be a dashboard, file, calendar, or SOP used by later work. A completed transcript is not that artifact's lifecycle. | First-class artifact references and existing skill/document owners with version/provenance. | Results and file links first; learned procedures later. |
| G9. Human takeover and delivery | A question dialog cannot fill a CAPTCHA, handle a live call, or accept a file upload. Finishing work silently is also insufficient. | Typed input requests with an action target, plus notification/delivery preference and receipts. Browser/phone capabilities remain separate runtime integrations. | Existing question/permission UI first; add takeover only with a working target. |

## Three flows that change the current proposal

### 1. A daily report: already a good fit

User creates **Daily sales report**, chooses a schedule and authorized sources. A due occurrence creates a run. The session reads data, produces an artifact, and records a completed outcome. The recurring task stays Active and displays its next run. Failure affects that run, not Active/Paused. The report's delivery result is visible separately from generation success.

### 2. A single objective that wakes repeatedly

User asks **Find an apartment by October 1**. Create one one-time task with explicit criteria and deadline. Its run searches and saves candidates, then waits for the next check. A timer resumes the same work; it does not create another apartment-search objective. The UI says **In progress · Next check tomorrow**, or **Needs you · Review these options** if a decision is required. Completion or expiry removes future wake-ups.

This is a design inference from the apartment-search and deferred-check reports, not a claim about their internal implementations. The distinction belongs in our model even if the initial release only supports manually configured checks.

### 3. A recurring responsibility with independent cases

User creates **Chase overdue invoices**. The scheduled detector finishes after checking and creating/updating invoice cases. Each unpaid invoice has its own linked one-time task, request, reply correlation, and next follow-up. Tomorrow's detector still runs if one invoice needs approval.

The recurring header stays **Active**. Its detail can say **3 related tasks need you** and link to them. Do not label these as the latest detector run's Needs you state if that run already completed. This refines the earlier “Latest run: Needs you” presentation rather than changing Active/Paused.

## UI consequences

| Situation | Primary status | Supporting information / action |
| --- | --- | --- |
| One-time work is computing | In progress | Agent working; open session |
| One-time work is waiting for a reply | In progress | Waiting for supplier; next follow-up Thursday |
| One-time watch is sleeping | In progress | Next check at 9 AM; ends October 1 |
| User must choose or approve | Needs you | Concrete request and action target |
| Recurring report is healthy | Active | Next run; latest result |
| A recurring run itself needs input | Active | Run from September 20: Needs you |
| Recurring detector has unresolved child cases | Active | 3 related tasks need you; detector's latest result shown separately |
| Recurring schedule is paused during an external wait | Paused | Current run waiting for supplier; Resume schedule does not resolve the wait |
| Run generated output but delivery failed | Task/run outcome as appropriate | Report ready; delivery failed; retry delivery without rerunning analysis |

Use “current run” only when there is one. When independent cases or parallel runs exist, show a count and dated entries. Prefer precise dates and wait reasons over another ambiguous global badge.

## What we should build

### First: useful scheduled work

Keep the signed-in account gate and Cloudflare scheduling constraint. Ship one-time/recurring tasks, readable timezone-aware schedules, Run now, Active/Paused, canonical execution history, explicit completion outcomes, structured Needs you requests, durable result links, and notifications. Validate a report, an authenticated read-only portal check, and a draft-producing code task end to end.

Examples to use as acceptance targets: daily brief (1), accounting export (17), KPI report (18), startup notes (39), school check (40), weekly business report (54). These exercise different tools without requiring a new agent persona product.

### Next: reliable stateful automation

Add the task-owned context contract, processed-item ledger, durable waits/wake-ups, deadlines, and explicit action receipts. Exercise job discovery (5), trip recheck (25), flight watch (37), and vendor-response work (41 or 46). Before external writes, implement the applicable permission and replay protections; a prompt saying “do not repeat” is not the enforcement mechanism.

### Then: standing operational responsibilities

Add related cases, event adapters, dependencies, and richer request destinations. Validate error-to-fix (19), invoice chasing (52), inbox handling (53), and order exceptions (56). A detector should be cheap and bounded; do not keep an expensive reasoning session busy while waiting for a clock tick.

Named bots, persistent personalities, telephony, payments, and a bot marketplace are not prerequisites for the task primitive. They are optional distribution, configuration, or runtime capabilities. Users can start with tasks and presets. Add a persistent identity only when a concrete capability, such as a dedicated inbox with reply routing, needs that owner.

## Cloudflare implementation direction

Cloudflare documents Cron Triggers as invoking a Worker's scheduled handler and using UTC. Keep user timezone and schedule interpretation in the task backend; use Cron to dispatch due work rather than encoding the entire task lifecycle in a cron string. [Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

Durable waits are compatible with that constraint. Cloudflare Workflows provides sleeping and external-event waiting, including human approval examples. Evaluate it against the existing execution owner before choosing it; do not make Cloudflare workflow state a second contradictory task-status owner. [Sleeping](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) · [Events](https://developers.cloudflare.com/workflows/build/events-and-parameters/) · [Approval example](https://developers.cloudflare.com/workflows/examples/wait-for-event/)

Proposed dispatch contract:

- **New occurrence:** create one new run for a due recurring occurrence, deduplicated by task and occurrence.
- **Resume:** wake a specific existing run using its timer/event correlation and revision; never recreate completed side effects.
- **Related case:** find-or-create an authorized one-time task for an external issue/invoice/message identity, preserving the parent responsibility link.

These are operations on the same Task/Run model. They do not require three new top-level product types. A session is the active execution surface; durable waiting must survive the session and desktop being offline.

## Changes proposed to the design document

1. Clarify that **one-time does not mean one execution or one wake-up**.
2. Add run waiting metadata; Needs you means only a user request, not every kind of blocked work.
3. Distinguish recurring occurrences, retries, and continuations. A retry after failure and a scheduled new occurrence are different records/relationships.
4. Replace a universal “one unresolved run blocks recurrence” rule with a scoped overlap policy. Keep serial execution for a single shared target where necessary; allow detector runs to finish and spawn independent cases.
5. Add explicit context, deduplication, notification/delivery, and outcome contracts.
6. Audit existing task/subtask constraints before representing cases as children. A recurring responsibility's completion rules differ from a one-time parent; a generic related-task link may be the safer initial representation.

These recommendations are not silently applied to the accepted status model. They are the decisions this research puts up for review.

## Evidence register

- **G1:** [Grok personal workflows](https://www.reddit.com/r/GrokBot/comments/1vwkzf1/heres_how_grok_bot_is_doing_all_the_stuff_i_hate/).
- **G2:** [Grok community use cases](https://www.reddit.com/r/GrokBot/comments/1wiuwmw/whats_the_most_useful_grokbot_automation_youve/).
- **G3:** [Grok game-development experiment](https://www.reddit.com/r/aigamedev/comments/1wd110k/grok_bot_claude_routines_updates_after_user/).
- **M1:** [Muse App Store reviews](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch&see-all=reviews).
- **M2:** [Muse additional App Store reviews](https://apps.apple.com/us/app/muse-from-meta/id6760173601?platform=watch).
- **M3:** [Muse user report with referral incentive](https://www.reddit.com/r/AiBuilders/comments/1wkxt11/my_daily_driver_now_muse_ai_assistant_with_its/).
- **M4:** [Reproduced Muse user posts](https://messagingagents.com/agents/muse).
- **I1:** [Instinct user experiments and limitations](https://www.reddit.com/r/AI_Agents/comments/1wak4is/ive_been_stresstesting_instinct_with_reallife/).
- **I2:** [Reproduced Instinct user posts](https://messagingagents.com/agents/instinct).
- **S1:** [Squad product examples and hosted testimonials](https://squad.so/).
- **S2:** [Squad research-to-content workflow](https://squad.so/resources/mission-control-for-claude-code).

Additional framing read: [xAI's Grok Bot design](https://x.ai/news/designing-grok-bot) and [Meta's Muse design](https://introducing.muse.ai/). Official positioning was not counted as independent user evidence. Paywalled comparisons and generic praise were not used to fill the matrix.

No success-rate or percentage-coverage claim is made. Repeated use cases from a single person are intentionally separated when they exercise different lifecycle requirements, but do not count as independent customer validations.
