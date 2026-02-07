# Task Assignment Template (Progress Briefing)

Use this template when assigning work to any OpenClaw agent. It makes the agent keep an always-up-to-date “what I’m doing” line via `progress_briefing_report`, so you can view it in the Gateway (`progress_briefing_agents`) and in Discord/Gateway logs (via the progress-briefing scheduled posts).

## Single-agent (copy/paste)

Replace `<...>` placeholders.

```
[TASK]
Agent: <agentId>
Goal: <one sentence>

Deliverables / Definition of Done (DoD):
- <bullet>
- <bullet>

Constraints:
- <deadline/timebox>
- <repo/path/branch>
- <do not do X>

Context / References:
- <links, files, prior decisions>

[STATUS REPORTING — REQUIRED]
You MUST maintain a single current-status job for yourself:
- tool: progress_briefing_report
- jobId: agent:<agentId>:current
- owner: <agentId>

Update cadence:
- immediately when you start
- whenever your phase changes (plan → implement → test → review)
- immediately if blocked (state=blocked + blocker in detail)
- at least once every 5 minutes (heartbeat is fine)

State rules:
- running: actively working now
- blocked: cannot proceed without external input
- waiting: idle / no active task

Detail format (ONE LINE):
"<what you are doing now> → next: <next single step> (blocker: <if any>)"

When you finish:
- set state=waiting
- detail="idle (completed: <short result>)"

End your reply with: HEARTBEAT_OK
```

## Multi-agent (common rule)

Paste this at the top of a broadcast message:

```
Common rule (required): each agent must keep agent:<id>:current updated via progress_briefing_report.
Update at start, on phase change, on block, and at least every 5 minutes.
Detail must be a one-liner: "now → next (blocker)".
```

## How to view

- Gateway tool (live): `progress_briefing_agents`
- Gateway logs / Discord: progress-briefing periodic posts (controlled by `plugins.entries["progress-briefing"].config.pollEveryMs`)
