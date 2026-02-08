#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_PATH = path.resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = path.join(process.env.HOME || "~", ".openclaw", "openclaw.json");

function usage(msg) {
  if (msg) console.error(`\nERROR: ${msg}\n`);
  console.error(`Usage:
  npm run install:openclaw -- [options]

Options:
  --config <path>            Path to openclaw.json (default: ~/.openclaw/openclaw.json)
  --pluginPath <path>        Path to plugin directory (default: auto-detected from script location)
  --discordChannelId <id>    Discord channel ID for briefing posts (optional)
  --pollEveryMs <ms>         Polling interval in ms (default: 30000)
  --idleEscalateMs <ms>      Idle escalation interval in ms (default: 300000)
  --mention <string>         Discord mention string (default: "@here")
  --restart                  Restart Gateway after patching config
  --verify                   Verify plugin loaded after restart
  --installDeps              Run 'npm install' in the plugin directory

Session Briefing Cron (Option B - agent-based):
  --setupBriefing            Set up a cron job for periodic session briefing
  --briefingChannelId <id>   Discord channel ID for briefing (required if --setupBriefing)
  --briefingIntervalMs <ms>  Briefing interval in ms (default: 1800000 = 30 min)
  --briefingModel <model>    Model for briefing agent (default: uses Gateway default)

Notes:
- This script edits openclaw.json in-place but will write a timestamped backup first.
- It validates JSON before writing.
- It enables the plugin and configures it under plugins.entries["progress-briefing"].
- Session briefing cron uses an isolated agent session to check all OpenClaw sessions
  and post a summary to Discord. This is independent of the plugin's own background service.
`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`Unexpected arg: ${a}`);
    const key = a.slice(2);
    if (key === "help" || key === "h") usage();
    const next = argv[i + 1];
    const isBool = key === "restart" || key === "verify" || key === "installDeps" || key === "setupBriefing";
    if (isBool) {
      args[key] = true;
      continue;
    }
    if (!next || next.startsWith("--")) usage(`Missing value for --${key}`);
    args[key] = next;
    i++;
  }
  return args;
}

// --- Session Briefing Cron Setup ---

const BRIEFING_CRON_NAME = "session-briefing";

const BRIEFING_PROMPT = `Time for OpenClaw session briefing.

1. Use sessions_list(messageLimit: 1) to check all active sessions
   - main, subagents, Flock agents, cron sessions, etc.
2. If Flock plugin is active:
   - flock_status for agent states (IDLE/ACTIVE/LEASED etc.)
   - flock_tasks for in-progress tasks

Send the result to Discord channel {{CHANNEL_ID}}.

Format:
\`\`\`
📊 OpenClaw Briefing (HH:MM)

Active Sessions: N
- session-name: brief activity summary (1 line)
...

Flock Status: (if Flock is active)
- Active: agent1, agent2
- Idle: agent3, agent4
- Tasks in progress: N
\`\`\`

If no active sessions, just say 'All quiet 💤' briefly.`;

function setupBriefingCron(args) {
  const channelId = args.briefingChannelId;
  if (!channelId) {
    console.error("ERROR: --briefingChannelId is required when using --setupBriefing");
    process.exit(1);
  }
  
  const intervalMs = args.briefingIntervalMs ? Number(args.briefingIntervalMs) : 1800000;
  const model = args.briefingModel || undefined;
  
  // Convert ms to duration string (e.g. 1800000 -> "30m")
  const msToDuration = (ms) => {
    if (ms >= 3600000 && ms % 3600000 === 0) return `${ms / 3600000}h`;
    if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
    return `${ms / 1000}s`;
  };
  
  const durationStr = msToDuration(intervalMs);
  const prompt = BRIEFING_PROMPT.replace("{{CHANNEL_ID}}", channelId);
  
  // Print setup instructions (CLI is too slow for scripted execution)
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SESSION BRIEFING CRON SETUP`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\nTo enable periodic session briefing, run this command:\n`);
  
  const cliCmd = [
    `openclaw cron add`,
    `  --name "${BRIEFING_CRON_NAME}"`,
    `  --every "${durationStr}"`,
    `  --session isolated`,
    `  --timeout-seconds 120`,
    `  --no-deliver`,
    model ? `  --model "${model}"` : null,
    `  --message "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  ].filter(Boolean).join(" \\\n");
  
  console.log(cliCmd);
  
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Or simply ask your OpenClaw assistant:`);
  console.log(`\n  "Set up a session-briefing cron job that runs every ${durationStr}`);
  console.log(`   and posts to Discord channel ${channelId}"`);
  console.log(`\n${"=".repeat(60)}\n`);
  
  return true;
}

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function writeJsonAtomic(p, obj) {
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.openclaw.json.tmp.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  // validate
  JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.renameSync(tmp, p);
}

function ensureArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  return [x];
}

function unique(arr) {
  return [...new Set(arr)];
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || process.env.OPENCLAW_CONFIG || DEFAULT_CONFIG_PATH;
  const pluginPath = args.pluginPath || process.env.OPENCLAW_PLUGIN_PATH || DEFAULT_PLUGIN_PATH;

  const absConfig = path.resolve(configPath);
  const absPlugin = path.resolve(pluginPath);

  if (!fs.existsSync(absConfig)) usage(`Config not found: ${absConfig}`);
  if (!fs.existsSync(absPlugin)) usage(`Plugin path not found: ${absPlugin}`);

  const cfg = readJson(absConfig);

  cfg.plugins ??= {};
  cfg.plugins.load ??= {};
  cfg.plugins.load.paths = unique([
    ...ensureArray(cfg.plugins.load.paths),
    absPlugin,
  ]);

  cfg.plugins.entries ??= {};
  cfg.plugins.entries["progress-briefing"] ??= { enabled: true, config: {} };

  cfg.plugins.entries["progress-briefing"].enabled = true;
  cfg.plugins.entries["progress-briefing"].config ??= {};

  const entryCfg = cfg.plugins.entries["progress-briefing"].config;
  entryCfg.enabled = true;
  entryCfg.pollEveryMs = args.pollEveryMs ? Number(args.pollEveryMs) : (entryCfg.pollEveryMs ?? 30000);
  entryCfg.idleEscalateMs = args.idleEscalateMs ? Number(args.idleEscalateMs) : (entryCfg.idleEscalateMs ?? 300000);
  entryCfg.store ??= { backend: "jsonl", dataDir: ".progress-briefing" };
  entryCfg.store.backend ??= "jsonl";
  entryCfg.store.dataDir ??= ".progress-briefing";

  // Discord is optional, but default to enabled if a channel id is provided.
  entryCfg.discord ??= {};
  if (args.discordChannelId) {
    entryCfg.discord.enabled = true;
    entryCfg.discord.channelId = String(args.discordChannelId);
  } else {
    // Don’t force enable without a channelId.
    entryCfg.discord.enabled = entryCfg.discord.enabled ?? true;
  }
  if (args.mention) entryCfg.discord.mention = String(args.mention);

  // backup
  const backupPath = `${absConfig}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(absConfig, backupPath);

  writeJsonAtomic(absConfig, cfg);

  console.log("OK: Updated OpenClaw config:");
  console.log(" -", absConfig);
  console.log("Backup:");
  console.log(" -", backupPath);
  console.log("Plugin path added:");
  console.log(" -", absPlugin);

  const { spawnSync } = await import("node:child_process");

  const runCmd = (cmd, cmdArgs, opts = {}) => {
    const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
    if (res.error) throw res.error;
    return res.status ?? 1;
  };

  // Optional: install dependencies (so the Gateway can import them when loading the plugin).
  // This repo is intentionally unbundled; dependencies should be installed in-place.
  if (args.installDeps) {
    const code = runCmd("npm", ["install"], { cwd: absPlugin });
    if (code !== 0) {
      console.error("WARN: `npm install` failed. You may need to run it manually.");
      process.exit(code);
    }
  }

  if (args.restart) {
    const code = runCmd("openclaw", ["gateway", "restart"]);
    if (code !== 0) {
      console.error("WARN: openclaw gateway restart failed. Please restart manually.");
      process.exit(code);
    }
  } else {
    console.log("Next: run `openclaw gateway restart` to apply.");
  }

  if (args.verify) {
    // Use --json so we can reliably parse status (the interactive table output can be hard to capture).
    const res = spawnSync("openclaw", ["plugins", "list", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const out = (res.stdout || "") + (res.stderr || "");

    if (res.error) {
      console.error(out.trim());
      console.error(
        "WARN: openclaw plugins list --json errored or timed out during --verify. Run `openclaw plugins list` manually.",
      );
      throw res.error;
    }
    if ((res.status ?? 1) !== 0) {
      console.error(out.trim());
      console.error("WARN: openclaw plugins list failed. Verify manually.");
      process.exit(res.status ?? 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(res.stdout || "{}");
    } catch {
      console.error(res.stdout || "");
      console.error("WARN: Could not parse JSON from `openclaw plugins list --json`. Verify manually.");
      process.exit(1);
    }

    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    const entry = plugins.find((p) => p?.id === "progress-briefing");

    if (!entry) {
      console.error(
        "VERIFY FAIL: progress-briefing not found in plugin list. Check plugins.load.paths + plugins.entries.",
      );
      process.exit(1);
    }

    const status = String(entry.status || "");
    if (status === "loaded") {
      console.log("VERIFY OK: progress-briefing is loaded.");
    } else {
      console.error(`VERIFY FAIL: progress-briefing status=${status || "(unknown)"}`);
      if (entry?.error) console.error(String(entry.error));
      process.exit(1);
    }
  }

  // --- Setup Session Briefing Cron (Option B) ---
  if (args.setupBriefing) {
    setupBriefingCron(args);
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
