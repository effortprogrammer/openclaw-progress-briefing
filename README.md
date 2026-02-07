# Progress Briefing (OpenClaw plugin)

An OpenClaw utility plugin that keeps a tiny “job status board” and periodically publishes a human-readable briefing.

By default it:

- exposes 2 tools for agents to report/query progress
- runs a background service inside the Gateway
- logs briefings to Gateway logs
- **optionally posts the briefing to Discord** (recommended; works with OpenClaw’s existing Discord bot token)
- optionally **auto-observes Gateway health signals** by scanning the Gateway log (useful for quickly surfacing errors without manual reporting)

---

## Setup / Install

### Automatic install (recommended)

This repo includes a small installer script that safely patches `openclaw.json` for you (with a backup + JSON validation).

From the plugin repo directory:

```bash
# 1) Install deps (this repo is tiny)
npm install

# 2) Patch ~/.openclaw/openclaw.json (creates a timestamped .bak.* backup)
npm run install:openclaw -- \
  --config ~/.openclaw/openclaw.json \
  --pluginPath "$(pwd)" \
  --discordChannelId "<DISCORD_CHANNEL_ID>" \
  --mention "@here"

# 3) Restart Gateway to apply
openclaw gateway restart
```

If you want the installer to restart the Gateway for you, add `--restart`:

```bash
npm run install:openclaw -- \
  --config ~/.openclaw/openclaw.json \
  --pluginPath "$(pwd)" \
  --discordChannelId "<DISCORD_CHANNEL_ID>" \
  --restart
```

If you also want it to verify the plugin loaded (by running `openclaw plugins list`), add `--verify`.

If you’ve just cloned the repo, also add `--installDeps` so the Gateway can import dependencies when loading the plugin.

```bash
npm run install:openclaw -- \
  --config ~/.openclaw/openclaw.json \
  --pluginPath "$(pwd)" \
  --discordChannelId "<DISCORD_CHANNEL_ID>" \
  --restart \
  --installDeps \
  --verify
```

What it changes:

- Adds `--pluginPath` to `plugins.load.paths`
- Ensures `plugins.entries["progress-briefing"]` exists and is enabled
- Writes a safe backup before modifying your config

### Manual install (if you prefer)

1) Add the repo path to `plugins.load.paths` in `~/.openclaw/openclaw.json`
2) Enable/configure `plugins.entries["progress-briefing"]`
3) `openclaw gateway restart`

Notes:

- Discord posting requires:
  - `discord.channelId`
  - `channels.discord.token` present in OpenClaw config (i.e. Discord channel is configured in OpenClaw)
- If the token is missing, the plugin falls back to logging-only.

### Verify it loaded

```bash
openclaw plugins list
```

You should see `Progress Briefing (progress-briefing)`.

---

## How it works

### Data model
The plugin tracks “jobs” keyed by `jobId`.

Each update is appended to a JSONL file, and the “current state” is computed by reading the file and keeping only the latest record per `jobId`.

**Job fields** (current MVP):

- `jobId` (string, required)
- `title` (string, optional)
- `owner` (string, optional; e.g. agent name)
- `state` (enum): `registered | running | waiting | blocked | completed | failed`
- `progress` (number 0–100, optional)
- `detail` (string, optional)

### Storage
Backend: `jsonl` (append-only).

Files are stored under:

- `<agents.defaults.workspace>/<store.dataDir>/jobs.jsonl`
- `<agents.defaults.workspace>/<store.dataDir>/state.json`

By default `store.dataDir = ".progress-briefing"`.

### Briefing rendering
On each tick, the plugin groups jobs by state and renders sections like:

- RUNNING
- WAITING
- BLOCKED
- COMPLETED
- FAILED

(“completed” jobs are filtered out by default in the tool output, but the background service currently includes all jobs it reads.)

### Background service publishing
The plugin registers a Gateway service (`id: "progress-briefing"`) that runs every `pollEveryMs`.

Publishing logic:

- It posts at least every `pollEveryMs`.
- It can also “idle escalate” if there has been no job activity for `idleEscalateMs`.
- It always logs to the Gateway log.
- If Discord is enabled and configured, it sends the same text to Discord.

### Auto-observing Gateway log health signals (optional)

If you enable `observe.enabled`, the plugin scans the Gateway log file each tick (incrementally) and auto-creates/updates a synthetic health job.

Observation scope:

- `scope: "gateway"` (recommended): scans for **conservative** Gateway/OpenClaw health signals (HTTP 5xx, HTTP 401/invalid token, and common network errors).

Escalation note: escalation mentions are **latched** (persisted) until the next scheduled Discord post, so you won’t miss a tag just because the error spike happened between posting intervals.

Threshold note: the escalation threshold is now **cumulative from the first observed error** (per agent), not “3 errors in a single tick.” This makes the alert timing much more predictable.

Synthetic jobs:

- `jobId: "gateway:health"` (overall health signal)
- (optional) `jobId: "gateway:agent:<agentId>"` (per-agent offender isolation)

What it looks for (current MVP):

- auth errors / invalid tokens (`HTTP 401`, `authentication_error`, `Invalid bearer token`)
- server errors (`HTTP 5xx` / `Gateway HTTP 5xx`)
- common network failures (`ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`)

You can override matching entirely via `includeRegexes` / `excludeRegexes`.

When it detects these, it marks the job(s) as `blocked` with a short error count summary.

It also tries to attribute errors to specific agents by parsing log lines like:

- `session:agent:pm` (agent-tagged sessions)
- `HTTP 401` / `Invalid bearer token` (best-effort attribution when agent id is present)

So the detail can look like:

- `401=7 [pm(4), dev-prod(3)]`
- `executorFailed=2 [dev-prod(2)]`

Config:

```json5
{
  plugins: {
    entries: {
      "progress-briefing": {
        enabled: true,
        config: {
          observe: {
            enabled: true,

            // Observe Gateway/OpenClaw health signals
            scope: "gateway",

            // optional override:
            // logPath: "/tmp/openclaw/openclaw-2026-02-05.log",
            maxBytesPerTick: 1048576,

            // Optional: override match filters (regex strings)
            // RECOMMENDED: keep includeRegexes conservative to avoid noisy false positives.
            // includeRegexes: ["\\bHTTP\\s+5\\d\\d\\b", "\\bHTTP\\s+401\\b", "Invalid bearer token"],
            // excludeRegexes: ["Doctor warnings"],

            // Optional: create per-agent health jobs (helps isolate the offender quickly)
            perAgentJobs: {
              enabled: true,
              minCount: 1
            },

            // Optional escalation: if errors repeat for the same agent, force a mention.
            escalate: {
              enabled: true,
              threshold: 3,
              cooldownMs: 300000,
              mention: "@here"
            }
          }
        }
      }
    }
  }
}
```

Notes:

- This is **heuristic** log scanning (MVP). It’s meant to answer “is anything obviously broken?” at a glance.
- It does not rely on any swarm/orchestration APIs; it works even if parts of the system are degraded.
- Future improvement: improve pattern coverage + add richer attribution (the current default patterns are intentionally conservative).

### Discord delivery
Discord delivery uses the Discord REST API:

- `POST https://discord.com/api/v10/channels/<channelId>/messages`

The bot token is sourced from your OpenClaw config:

- `channels.discord.token`

No token is stored in this repo. Treat the plugin as trusted code: it is capable of sending messages as your bot.

---

## Tools exposed to agents

### 1) `progress_briefing_report`
Register or update a job.

Parameters:

- `jobId` (required)
- `title`, `owner`, `state`, `progress`, `detail` (optional)

Example call (conceptual):

```json
{
  "jobId": "plugin-mvp",
  "title": "Ship progress briefing MVP",
  "owner": "dev-code",
  "state": "running",
  "progress": 40,
  "detail": "Discord send + JSONL store wired up"
}
```

### 2) `progress_briefing_status`
Render the current briefing text.

Parameters:

- `includeCompleted` (boolean, default false)

---

### 3) `progress_briefing_agents`
Show what each agent is currently doing (manual agent-reported status).

This tool expects each agent to maintain a single “current status” job with:

- `jobId`: `agent:<agentId>:current`
- `owner`: `<agentId>`
- `state`: `running | waiting | blocked`
- `detail`: one-line description of what the agent is doing right now

Parameters: none

Output: plain text list of per-agent statuses.

Example report (from an agent):

```json
{
  "jobId": "agent:dev-code:current",
  "owner": "dev-code",
  "state": "running",
  "progress": 40,
  "detail": "Implement progress_briefing_agents tool + README docs"
}
```

---

### 4) `progress_briefing_reset`
Reset progress-briefing state by clearing stored jobs + state (**DANGEROUS**).

Use this when you want to wipe stale jobs (including synthetic observe jobs) and start fresh.

Parameters:

- `confirm` (boolean, required): must be `true` to proceed.

---

## Task assignment template (recommended)

If your goal is to always know what each agent is doing, use the copy/paste template:

- `docs/TASK_ASSIGNMENT_TEMPLATE.md`

This forces a consistent, per-agent “current work” line using `jobId=agent:<id>:current`, which you can view via the `progress_briefing_agents` tool.

## Operating it (recommended workflow)

1) When you kick off a chunk of work (a task, a migration, a parallel agent run, etc.), create a job:

- `state: running`
- `progress: 0`

2) Periodically update `progress` and `detail`.

3) When done, mark `state: completed` (or `failed`).

The briefing service will keep a rolling “what’s happening” summary in both:

- Gateway logs
- Discord (if enabled)

---

## Known limitations (MVP)

- JSONL store is simple and append-only; there’s no compaction yet.
- “What each agent is doing” is only as good as what agents report in `agent:<id>:current` (manual, or via your heartbeat convention).
- Auto-observe is heuristic log scanning; keep patterns conservative to avoid false positives.
- Discord sends are plain text (no embeds/threads yet).

---

## Security

- The plugin uses `channels.discord.token` to send messages to Discord.
- Treat plugins as trusted code.
- Avoid committing secrets into this repo.
