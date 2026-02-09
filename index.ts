import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";

type ProgressBriefingConfig = {
  enabled: boolean;
  pollEveryMs?: number;
  idleEscalateMs?: number;
  store?: { dataDir?: string; backend?: "jsonl" };
  discord?: { enabled?: boolean; channelId?: string; mention?: string };
  
  /** Auto-track agent tool calls via hooks (no manual reporting needed). */
  activity?: {
    enabled?: boolean;
    /** Max recent tool calls to keep in memory (default: 10). */
    maxRecent?: number;
    /** Tool names to exclude from tracking (e.g. ["progress_briefing_status"]). */
    excludeTools?: string[];
  };

  observe?: {
    enabled?: boolean;

    /**
     * Observation scope:
     * - "flock": only scan flock-related log lines (back-compat default)
     * - "gateway": scan generic OpenClaw/Gateway error signals (recommended if you don't use Flock)
     */
    scope?: "flock" | "gateway";

    /** Path to the gateway log file to scan (newline-delimited). */
    logPath?: string;

    /** Cap how many bytes we read per tick (safety). */
    maxBytesPerTick?: number;

    /** Optional override filters (regex strings). If provided, they take precedence over scope defaults. */
    includeRegexes?: string[];
    excludeRegexes?: string[];

    /** Optional: create/update per-agent health jobs (e.g. flock:agent:pm). */
    perAgentJobs?: {
      enabled?: boolean;
      /** Minimum per-tick count for an agent to get its own job update. */
      minCount?: number;
    };

    /** If error counts exceed threshold, force a Discord mention prefix for the briefing. */
    escalate?: {
      enabled?: boolean;
      threshold?: number;
      cooldownMs?: number;
      mention?: string;
    };
  };
};

type JobState =
  | "registered"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed";

/** Tracks an active (in-progress) tool call. */
type ActiveToolCall = {
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
};

/** Tracks a recently completed tool call. */
type RecentToolCall = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  sessionKey?: string;
  agentId?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

type JobRecord = {
  jobId: string;
  title?: string;
  owner?: string; // agent/session/etc
  state: JobState;
  progress?: number; // 0..100
  detail?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
};

function now() {
  return Date.now();
}

function todayLogPath() {
  // Matches OpenClaw gateway default: /tmp/openclaw/openclaw-YYYY-MM-DD.log
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `/tmp/openclaw/openclaw-${yyyy}-${mm}-${dd}.log`;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function formatBrief(
  jobs: JobRecord[], 
  opts?: { 
    header?: string;
    activeTools?: Array<{ toolName: string; params: Record<string, unknown>; startedAt: number; sessionKey?: string }>;
    recentTools?: Array<{ toolName: string; params: Record<string, unknown>; durationMs: number; error?: string; result?: unknown }>;
    formatParamsSummary?: (params: Record<string, unknown>, maxLen?: number) => string;
    formatResultSummary?: (result: unknown, error?: string) => string;
    formatDuration?: (ms: number) => string;
  }
) {
  const by = {
    running: [] as JobRecord[],
    waiting: [] as JobRecord[],
    blocked: [] as JobRecord[],
    completed: [] as JobRecord[],
    failed: [] as JobRecord[],
    registered: [] as JobRecord[],
  };
  for (const j of jobs) {
    (by[j.state] ?? by.registered).push(j);
  }

  const fmt = (j: JobRecord) => {
    const pct = typeof j.progress === "number" ? ` (${j.progress}%)` : "";
    const detail = j.detail ? ` — ${j.detail}` : "";
    return `- [${j.state}] ${j.title ?? j.jobId}${pct}${detail}`;
  };

  const lines: string[] = [];
  if (opts?.header) lines.push(opts.header);

  // Helper for duration formatting (fallback)
  const fmtDur = opts?.formatDuration ?? ((ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const fmtParams = opts?.formatParamsSummary ?? (() => "");
  const fmtResult = opts?.formatResultSummary ?? (() => "✓");

  // Active tool calls section
  if (opts?.activeTools && opts.activeTools.length > 0) {
    lines.push(`🔄 ACTIVE (${opts.activeTools.length})`);
    const now = Date.now();
    for (const t of opts.activeTools) {
      const elapsed = fmtDur(now - t.startedAt);
      const params = fmtParams(t.params);
      const session = t.sessionKey ? `[${t.sessionKey.split(":").pop()}]` : "";
      lines.push(`- ${session} ${t.toolName}: ${params} (${elapsed}...)`);
    }
    lines.push("");
  }

  // Recent tool calls section
  if (opts?.recentTools && opts.recentTools.length > 0) {
    lines.push(`✅ RECENT (${opts.recentTools.length})`);
    for (const t of opts.recentTools) {
      const dur = fmtDur(t.durationMs);
      const params = fmtParams(t.params);
      const result = fmtResult(t.result, t.error);
      lines.push(`- ${t.toolName}: ${params} ${result} (${dur})`);
    }
    lines.push("");
  }

  const section = (name: string, arr: JobRecord[]) => {
    if (!arr.length) return;
    lines.push(`${name} (${arr.length})`);
    for (const j of arr) lines.push(fmt(j));
    lines.push("");
  };

  section("📋 RUNNING", by.running);
  section("⏳ WAITING", by.waiting);
  section("🚫 BLOCKED", by.blocked);
  section("✔️ COMPLETED", by.completed);
  section("❌ FAILED", by.failed);

  // If we have header but nothing else, show "(no activity)"
  const hasContent = (opts?.activeTools?.length ?? 0) > 0 
    || (opts?.recentTools?.length ?? 0) > 0 
    || by.running.length > 0 
    || by.waiting.length > 0 
    || by.blocked.length > 0;
  
  if (opts?.header && !hasContent) {
    lines.push("(no activity)");
  }

  if (!lines.length) return "(no jobs)";
  return lines.join("\n").trim();
}

async function discordSendText(params: {
  token: string;
  channelId: string;
  content: string;
}) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${params.channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: params.content }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord send failed: ${res.status} ${res.statusText} ${text}`);
  }
}

export default function register(api: any) {
  const cfg: ProgressBriefingConfig = (api.config?.plugins?.entries?.["progress-briefing"]
    ?.config ?? { enabled: true }) as any;

  const enabled = cfg.enabled !== false;
  const dataDir = path.resolve(
    api.config?.agents?.defaults?.workspace ?? process.cwd(),
    cfg.store?.dataDir ?? ".progress-briefing",
  );
  const jobsPath = path.join(dataDir, "jobs.jsonl");
  const statePath = path.join(dataDir, "state.json");

  ensureDir(dataDir);

  // ============================================================
  // Activity tracking (tool calls via hooks)
  // ============================================================
  const activityEnabled = cfg.activity?.enabled !== false;
  const maxRecentTools = cfg.activity?.maxRecent ?? 10;
  const excludeTools = new Set(cfg.activity?.excludeTools ?? [
    "progress_briefing_report",
    "progress_briefing_status",
    "progress_briefing_agents",
    "progress_briefing_reset",
  ]);

  // In-memory tracking (not persisted)
  const activeTools = new Map<string, ActiveToolCall>(); // key = toolCallId (or generated)
  const recentTools: RecentToolCall[] = [];

  type AgentActivity = {
    lastToolAt: number;
    lastToolName: string;
    lastParamsSummary: string;
    recentTools: Array<{name: string; paramsSummary: string; timestamp: number}>;
  };
  const agentActivity = new Map<string, AgentActivity>();

  const formatParamsSummary = (params: Record<string, unknown>, maxLen = 60): string => {
    // Extract the most useful param for common tools
    if (params.reason && typeof params.reason === "string") {
      const reason = params.reason.length > maxLen
        ? params.reason.slice(0, maxLen) + "…"
        : params.reason;
      return `reason: ${reason}`;
    }
    if (params.command && typeof params.command === "string") {
      const cmd = params.command.length > maxLen
        ? params.command.slice(0, maxLen) + "…"
        : params.command;
      return `\`${cmd}\``;
    }
    if (params.path && typeof params.path === "string") {
      return `\`${params.path}\``;
    }
    if (params.file_path && typeof params.file_path === "string") {
      return `\`${params.file_path}\``;
    }
    if (params.query && typeof params.query === "string") {
      return `"${params.query.slice(0, maxLen)}"`;
    }
    if (params.url && typeof params.url === "string") {
      return `\`${params.url.slice(0, maxLen)}\``;
    }
    // Fallback: show first string param
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string" && v.length > 0) {
        const val = v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
        return `${k}=\`${val}\``;
      }
    }
    return "";
  };

  const formatResultSummary = (result: unknown, error?: string): string => {
    if (error) return `❌ ${error.slice(0, 50)}`;
    if (result === undefined || result === null) return "✓";
    if (typeof result === "string") {
      if (result.length < 20) return `→ ${result}`;
      return `→ ${result.length} chars`;
    }
    if (typeof result === "object") {
      const str = JSON.stringify(result);
      if (str.length < 30) return `→ ${str}`;
      return `→ ${str.length} bytes`;
    }
    return "✓";
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  let state = {
    lastBriefAt: 0,
    lastNoMsgEscalationAt: 0,
    lastBriefContent: "", // Track last posted content to avoid duplicate posts

    // Observation cursor (for scanning gateway logs incrementally)
    observe: {
      logPath: "",
      pos: 0,
      lastSize: 0,
      lastEscalateAt: 0,
      lastEscalateReason: "",

      // Persistent per-agent escalation counters (across ticks)
      // Shape: { [scope]: { [agentId]: number } }
      counters: {} as Record<string, Record<string, number>>,
    },

    // Escalation state: computed by observe(), consumed by the next Discord post.
    // Persisted so we don't miss escalation if it triggers between posting intervals.
    observeEscalation: {
      pending: false,
      forcedMention: "",
      reason: "",
      setAt: 0,
    },

    // Back-compat placeholder (no longer used)
    observeLast: {
      escalated: false,
      forcedMention: "",
      reason: "",
    },
  };

  const loadState = () => {
    if (!fs.existsSync(statePath)) return;
    const parsed = safeJsonParse<any>(fs.readFileSync(statePath, "utf8"));
    if (!parsed) return;

    // Shallow merge is dangerous for nested objects (it would overwrite defaults
    // like observe.counters). Do a small targeted deep merge for known keys.
    state = { ...state, ...parsed };
    if (parsed.observe) state.observe = { ...state.observe, ...parsed.observe };
    if (parsed.observeEscalation)
      state.observeEscalation = {
        ...state.observeEscalation,
        ...parsed.observeEscalation,
      };
  };

  const saveState = () => {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  };

  const observeFromGatewayLogs = () => {
    const obsEnabled = cfg.observe?.enabled === true;
    if (!obsEnabled) return;

    const scope = cfg.observe?.scope ?? "gateway";

    // Ensure persistent structures exist even if an older state.json overwrote them.
    state.observe.counters ??= {};
    const logPath = cfg.observe?.logPath ?? todayLogPath();
    const maxBytes = cfg.observe?.maxBytesPerTick ?? 1024 * 1024; // 1MB

    const compileRegexes = (arr?: string[]) => {
      const out: RegExp[] = [];
      for (const s of arr ?? []) {
        try {
          out.push(new RegExp(s));
        } catch {
          // ignore invalid regex
        }
      }
      return out;
    };

    const include = compileRegexes(cfg.observe?.includeRegexes);
    const exclude = compileRegexes(cfg.observe?.excludeRegexes);

    const defaultIncludeGateway = [
      // Keep this list conservative: prefer real HTTP/auth/network signals.
      /\bGateway HTTP\b/i,
      /\bHTTP\s+4\d\d\b/i,
      /\bHTTP\s+5\d\d\b/i,
      /authentication_error/i,
      /Invalid bearer token/i,
      /ETIMEDOUT/i,
      /ECONNRESET/i,
      /ENOTFOUND/i,
      /EAI_AGAIN/i,
    ];

    const matches = (line: string) => {
      if (exclude.some((r) => r.test(line))) return false;

      if (include.length) {
        return include.some((r) => r.test(line));
      }

      if (scope === "flock") return line.includes("[flock");
      // gateway
      return defaultIncludeGateway.some((r) => r.test(line));
    };

    const baseJobId = scope === "gateway" ? "gateway:health" : "flock:health";
    const baseTitle =
      scope === "gateway" ? "Gateway health (auto)" : "Flock health (auto)";

    try {
      if (!fs.existsSync(logPath)) {
        upsertJob({
          jobId: baseJobId,
          title: baseTitle,
          owner: "observe",
          state: "waiting",
          detail: `gateway log not found: ${logPath}`,
        });
        return;
      }

      const st = fs.statSync(logPath);
      const size = st.size;

      // Reset cursor if log rotated/truncated or path changed.
      if (state.observe.logPath !== logPath || size < (state.observe.pos ?? 0)) {
        state.observe.logPath = logPath;
        state.observe.pos = Math.max(0, size - maxBytes);
      }

      const start = Math.max(0, state.observe.pos ?? 0);
      const end = size;
      const bytesToRead = Math.min(maxBytes, Math.max(0, end - start));
      const readStart = Math.max(0, end - bytesToRead);

      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, readStart);
      fs.closeSync(fd);

      state.observe.pos = end;
      state.observe.lastSize = size;

      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);

      // Very lightweight heuristics; we can get fancy later.
      let count401 = 0;
      let count405 = 0;
      let count429 = 0;
      let count5xx = 0;
      let countExecutorFailed = 0;
      let countExecFailed = 0;
      let countPluginLoadFailed = 0;

      const agents401 = new Map<string, number>();
      const agentsExecutorFailed = new Map<string, number>();
      const agents405 = new Map<string, number>();
      const agents429 = new Map<string, number>();
      const agents5xx = new Map<string, number>();

      const bump = (m: Map<string, number>, k: string) =>
        m.set(k, (m.get(k) ?? 0) + 1);

      const extractAgent = (line: string) => {
        // Flock-style (log line may contain JSON-escaped quotes: \"pm\")
        const m1 = line.match(/Agent\s+(?:\\"|")([^\\\"]+)(?:\\"|")\s+responded:/);
        if (m1?.[1]) return m1[1];

        // Flock executor
        const m2 = line.match(/\bfor\s+([a-zA-Z0-9_-]+)@/);
        if (m2?.[1]) return m2[1];

        // Generic OpenClaw lane/session tags
        const m3 = line.match(/session:agent:([a-zA-Z0-9_-]+)/);
        if (m3?.[1]) return m3[1];

        return "";
      };

      for (const l of lines) {
        if (!matches(l)) continue;

        const agent = extractAgent(l);

        const is401 =
          l.includes("HTTP 401") ||
          l.includes("authentication_error") ||
          l.includes("Invalid bearer token");
        const is405 = l.includes("Gateway HTTP 405") || /\bHTTP\s+405\b/.test(l);
        const is429 = /\bHTTP\s+429\b/.test(l) || l.includes("rate_limit");
        const is5xx = /\bHTTP\s+5\d\d\b/.test(l) || /\bGateway HTTP\s+5\d\d\b/.test(l);
        // NOTE: Keep gateway-scope observation focused on gateway/network/auth.
        // Tool execution failures ("[tools] exec failed") are often benign during development
        // and were causing noisy false-positives. We only count executor/tool failures in
        // flock scope.
        const isExecFail =
          scope === "flock" && l.includes("[flock:executor]") && l.includes(" failed:");
        const isExecToolFail =
          scope === "flock" && (l.includes("Exec failed") || l.includes("ExecFailed"));
        const isPluginLoadFail = scope === "flock" && l.includes("failed to load");

        if (is401) {
          count401++;
          if (agent) bump(agents401, agent);
        }

        if (is405) {
          count405++;
          if (agent) bump(agents405, agent);
        }

        if (is429) {
          count429++;
          if (agent) bump(agents429, agent);
        }

        if (is5xx) {
          count5xx++;
          if (agent) bump(agents5xx, agent);
        }

        if (isExecFail) {
          countExecutorFailed++;
          if (agent) bump(agentsExecutorFailed, agent);
        }

        if (isExecToolFail) countExecFailed++;
        if (isPluginLoadFail) countPluginLoadFailed++;
      }

      // Do NOT clear observeEscalation here; it's consumed on post().
      // (Previously we reset observeLast each tick, which could drop escalation
      // before the next scheduled post.)
      state.observeLast = {
        escalated: false,
        forcedMention: "",
        reason: "",
      };

      if (
        count401 === 0 &&
        count405 === 0 &&
        count429 === 0 &&
        count5xx === 0 &&
        countExecutorFailed === 0 &&
        countExecFailed === 0 &&
        countPluginLoadFailed === 0
      )
        return;

      const fmtMap = (m: Map<string, number>) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}(${v})`)
          .join(", ");

      const detailParts = [] as string[];
      if (count401) {
        const a = fmtMap(agents401);
        detailParts.push(`401=${count401}${a ? ` [${a}]` : ""}`);
      }
      if (count405) {
        const a = fmtMap(agents405);
        detailParts.push(`405=${count405}${a ? ` [${a}]` : ""}`);
      }
      if (count429) {
        const a = fmtMap(agents429);
        detailParts.push(`429=${count429}${a ? ` [${a}]` : ""}`);
      }
      if (count5xx) {
        const a = fmtMap(agents5xx);
        detailParts.push(`5xx=${count5xx}${a ? ` [${a}]` : ""}`);
      }
      if (countExecutorFailed) {
        const a = fmtMap(agentsExecutorFailed);
        detailParts.push(
          `executorFailed=${countExecutorFailed}${a ? ` [${a}]` : ""}`,
        );
      }
      if (countExecFailed) detailParts.push(`execFailed=${countExecFailed}`);
      if (countPluginLoadFailed)
        detailParts.push(`pluginLoadFailed=${countPluginLoadFailed}`);

      const stateStr: JobState =
        count401 ||
        count405 ||
        count429 ||
        count5xx ||
        countExecutorFailed ||
        countExecFailed ||
        countPluginLoadFailed
          ? "blocked"
          : "running";

      // Optional: per-agent jobs (helps isolate the offender quickly)
      const perAgentEnabled = cfg.observe?.perAgentJobs?.enabled === true;
      const minCount = cfg.observe?.perAgentJobs?.minCount ?? 1;
      if (perAgentEnabled) {
        const agents = new Set([
          ...agents401.keys(),
          ...agentsExecutorFailed.keys(),
          ...agents405.keys(),
          ...agents429.keys(),
          ...agents5xx.keys(),
        ]);
        for (const agent of agents) {
          const c401 = agents401.get(agent) ?? 0;
          const cExec = agentsExecutorFailed.get(agent) ?? 0;
          const c405 = agents405.get(agent) ?? 0;
          const c429 = agents429.get(agent) ?? 0;
          const c5xx = agents5xx.get(agent) ?? 0;
          const total = c401 + cExec + c405 + c429 + c5xx;
          if (total < minCount) continue;

          const parts: string[] = [];
          if (c401) parts.push(`401=${c401}`);
          if (c429) parts.push(`429=${c429}`);
          if (c5xx) parts.push(`5xx=${c5xx}`);
          if (cExec) parts.push(`executorFailed=${cExec}`);
          if (c405) parts.push(`405=${c405}`);

          upsertJob({
            jobId: `${baseJobId.replace(/:health$/, ":agent")}:${agent}`,
            title: `${baseTitle.replace(" health (auto)", " agent health")}: ${agent} (auto)`,
            owner: "observe",
            state: "blocked",
            detail: parts.join(", "),
          });
        }
      }

      // Escalation (Discord forced mention) if threshold exceeded.
      // NOTE: This is *cumulative* across ticks from the first observed error.
      // We persist counters in state.observe.counters so escalation is predictable.
      const esc = cfg.observe?.escalate;
      const escEnabled = esc?.enabled === true;
      const threshold = esc?.threshold ?? 3;
      const cooldownMs = esc?.cooldownMs ?? 5 * 60_000;
      const mention = esc?.mention ?? "@here";

      if (escEnabled) {
        const scopeCounters = (state.observe.counters[scope] ??= {});

        const bumpN = (agentId: string, n: number) => {
          if (!agentId || n <= 0) return;
          scopeCounters[agentId] = (scopeCounters[agentId] ?? 0) + n;
        };

        // Aggregate error counts per agent for this tick and add them to cumulative counters.
        const agents = new Set([
          ...agents401.keys(),
          ...agents405.keys(),
          ...agents429.keys(),
          ...agents5xx.keys(),
          ...agentsExecutorFailed.keys(),
        ]);

        for (const agentId of agents) {
          bumpN(agentId, agents401.get(agentId) ?? 0);
          bumpN(agentId, agents405.get(agentId) ?? 0);
          bumpN(agentId, agents429.get(agentId) ?? 0);
          bumpN(agentId, agents5xx.get(agentId) ?? 0);
          bumpN(agentId, agentsExecutorFailed.get(agentId) ?? 0);
        }

        // Determine offender: max cumulative count.
        let offender = "";
        let offenderCount = 0;
        for (const [agentId, c] of Object.entries(scopeCounters)) {
          if (c > offenderCount) {
            offender = agentId;
            offenderCount = c;
          }
        }

        const shouldEscalate = offenderCount >= threshold;
        const cooledDown =
          now() - (state.observe.lastEscalateAt ?? 0) >= cooldownMs;

        if (shouldEscalate && cooledDown) {
          const reason = `error threshold hit: >=${threshold} (offender=${offender}, cumulative=${offenderCount})`;
          state.observe.lastEscalateAt = now();
          state.observe.lastEscalateReason = reason;

          state.observeEscalation = {
            pending: true,
            forcedMention: mention,
            reason,
            setAt: now(),
          };

          // Avoid unbounded growth: cap counters at threshold once escalation fires.
          // (Keeps state.json small and prevents immediate re-trigger after cooldown.)
          if (offender) scopeCounters[offender] = threshold;
        }
      }

      upsertJob({
        jobId: baseJobId,
        title: baseTitle,
        owner: "observe",
        state: stateStr,
        detail: `Detected ${scope} errors in gateway logs: ${detailParts.join(", ")}`,
      });

      saveState();
    } catch (err) {
      api.logger.error(
        `[progress-briefing][observe] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const readJobs = (): JobRecord[] => {
    if (!fs.existsSync(jobsPath)) return [];
    const lines = fs
      .readFileSync(jobsPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const jobs: JobRecord[] = [];
    for (const l of lines) {
      const j = safeJsonParse<JobRecord>(l);
      if (j?.jobId) jobs.push(j);
    }
    // Keep only latest per jobId.
    const map = new Map<string, JobRecord>();
    for (const j of jobs) map.set(j.jobId, j);
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  };

  const upsertJob = (patch: Partial<JobRecord> & { jobId: string }) => {
    const jobs = readJobs();
    const prev = jobs.find((j) => j.jobId === patch.jobId);
    const base: JobRecord =
      prev ??
      ({
        jobId: patch.jobId,
        state: "registered",
        createdAt: now(),
        updatedAt: now(),
        lastActivityAt: now(),
      } as JobRecord);

    const next: JobRecord = {
      ...base,
      ...patch,
      updatedAt: now(),
      lastActivityAt: now(),
    };

    fs.appendFileSync(jobsPath, JSON.stringify(next) + "\n");
    return next;
  };

  api.registerTool({
    name: "progress_briefing_report",
    description:
      "Register/update a job's progress for the Progress Briefing plugin.",
    parameters: Type.Object({
      jobId: Type.String(),
      title: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      state: Type.Optional(
        Type.Union([
          Type.Literal("registered"),
          Type.Literal("running"),
          Type.Literal("waiting"),
          Type.Literal("blocked"),
          Type.Literal("completed"),
          Type.Literal("failed"),
        ]),
      ),
      progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      detail: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: any) {
      if (!enabled) {
        return {
          content: [
            { type: "text", text: "progress-briefing plugin disabled" },
          ],
        };
      }
      const next = upsertJob(params);
      return {
        content: [
          {
            type: "text",
            text: `ok: ${next.jobId} → ${next.state}`,
          },
        ],
      };
    },
  });

  api.registerTool({
    name: "progress_briefing_status",
    description: "Get the current briefing text.",
    parameters: Type.Object({
      includeCompleted: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id: string, params: any) {
      if (!enabled) {
        return {
          content: [
            { type: "text", text: "progress-briefing plugin disabled" },
          ],
        };
      }
      const jobs = readJobs();
      const filtered = params?.includeCompleted
        ? jobs
        : jobs.filter((j) => j.state !== "completed");
      const text = formatBrief(filtered, {
        header: `[progress-briefing] ${new Date().toISOString()}`,
      });
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "progress_briefing_agents",
    description:
      "Show what each agent is currently doing (manual + auto-tracked).",
    parameters: Type.Object({}),
    async execute(_id: string, _params: any) {
      if (!enabled) {
        return {
          content: [
            { type: "text", text: "progress-briefing plugin disabled" },
          ],
        };
      }

      const jobs = readJobs();
      const agentJobs = jobs
        .filter((j) => typeof j.jobId === "string" && j.jobId.startsWith("agent:") && j.jobId.endsWith(":current"))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

      const fmtAge = (ms: number) => {
        if (!ms || ms <= 0) return "";
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        return `${h}h`;
      };

      const extractAgentId = (jobId: string) => {
        const parts = jobId.split(":");
        return parts.length >= 3 ? parts[1] : "";
      };

      const byAgent = new Map<string, JobRecord>();
      for (const j of agentJobs) {
        const agentId = extractAgentId(j.jobId);
        if (!agentId) continue;
        byAgent.set(agentId, j);
      }

      const lines: string[] = [];
      lines.push(`[progress-briefing] agent status — ${new Date().toLocaleString()}`);

      const allAgentIds = new Set([...byAgent.keys(), ...agentActivity.keys()]);
      const sortedAgentIds = [...allAgentIds].sort((a, b) => a.localeCompare(b));

      if (!sortedAgentIds.length) {
        lines.push("(no agent activity yet — waiting for tool calls)");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      for (const agentId of sortedAgentIds) {
        const manualJob = byAgent.get(agentId);
        const autoTrack = agentActivity.get(agentId);

        if (manualJob) {
          const pct = typeof manualJob.progress === "number" ? ` (${manualJob.progress}%)` : "";
          const detail = manualJob.detail ? ` — ${manualJob.detail}` : "";
          const age = manualJob.updatedAt ? ` · updated ${fmtAge(now() - manualJob.updatedAt)} ago` : "";
          lines.push(`- ${agentId}: [${manualJob.state}]${pct}${detail}${age}`);
        } else if (autoTrack) {
          const age = autoTrack.lastToolAt ? ` · ${fmtAge(now() - autoTrack.lastToolAt)} ago` : "";
          const recentCount = autoTrack.recentTools.length;
          const recentInfo = recentCount > 0 ? ` (${recentCount} recent)` : "";

          const isIdle = autoTrack.lastToolName === "flock_sleep";
          const statusIcon = isIdle ? "💤" : "🔄";
          const statusLabel = isIdle ? "Idle" : "Working";

          lines.push(`${statusIcon} ${agentId}: [${statusLabel}] — ${autoTrack.lastToolName} ${autoTrack.lastParamsSummary}${recentInfo}${age}`);
        } else {
          lines.push(`💤 ${agentId}: [idle] — No recent tool calls`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  api.registerTool({
    name: "progress_briefing_reset",
    description:
      "Reset progress-briefing state by clearing stored jobs + state (DANGEROUS).",
    parameters: Type.Object({
      confirm: Type.Boolean({
        description: "Set true to confirm reset (this will delete stored briefing state).",
      }),
    }),
    async execute(_id: string, params: any) {
      if (!enabled) {
        return {
          content: [
            { type: "text", text: "progress-briefing plugin disabled" },
          ],
        };
      }
      if (params?.confirm !== true) {
        return {
          content: [
            {
              type: "text",
              text:
                "Refusing to reset without confirm=true. This will delete stored jobs/state.",
            },
          ],
        };
      }

      // Clear job log + state. (Append-only store; truncating is simplest.)
      try {
        if (fs.existsSync(jobsPath)) fs.writeFileSync(jobsPath, "");
        state = {
          lastBriefAt: 0,
          lastNoMsgEscalationAt: 0,
          observe: {
            logPath: "",
            pos: 0,
            lastSize: 0,
            lastEscalateAt: 0,
            lastEscalateReason: "",
            counters: {},
          },
          observeEscalation: {
            pending: false,
            forcedMention: "",
            reason: "",
            setAt: 0,
          },
          observeLast: {
            escalated: false,
            forcedMention: "",
            reason: "",
          },
        } as any;
        saveState();
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `reset failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: "ok: cleared progress-briefing jobs + state" },
        ],
      };
    },
  });

  api.registerService({
    id: "progress-briefing",
    start: async () => {
      if (!enabled) {
        api.logger.info("[progress-briefing] disabled");
        return;
      }

      loadState();

      const pollEveryMs = cfg.pollEveryMs ?? 30_000;
      const idleEscalateMs = cfg.idleEscalateMs ?? 5 * 60_000;

      api.logger.info(
        `[progress-briefing] started (pollEveryMs=${pollEveryMs}, idleEscalateMs=${idleEscalateMs})`,
      );

      const tick = async () => {
        // Optional: auto-observe flock health from gateway logs.
        observeFromGatewayLogs();

        const jobs = readJobs();
        const text = formatBrief(jobs, {
          header: `[progress-briefing] ${new Date().toLocaleString()}`,
          activeTools: activityEnabled ? [...activeTools.values()] : undefined,
          recentTools: activityEnabled ? recentTools.slice(0, maxRecentTools) : undefined,
          formatParamsSummary,
          formatResultSummary,
          formatDuration,
        });

        const discordEnabled = cfg.discord?.enabled !== false;
        const channelId = cfg.discord?.channelId;
        const discordToken = api.config?.channels?.discord?.token;

        // Idle escalation: if no job updates recently, still post a short status.
        const lastActivity = Math.max(
          0,
          ...jobs.map((j) => j.lastActivityAt ?? 0),
        );
        const idleFor = lastActivity ? now() - lastActivity : now();

        // Check if content has changed (ignore timestamp in header for comparison)
        const textWithoutHeader = text.replace(/^\[progress-briefing\] [^\n]+\n?/, "");
        const lastWithoutHeader = (state.lastBriefContent ?? "").replace(/^\[progress-briefing\] [^\n]+\n?/, "");
        const contentChanged = textWithoutHeader !== lastWithoutHeader;

        // Only post if: (1) enough time passed AND content changed, OR (2) error escalation pending
        // Note: idle escalation disabled — no need to post "no activity" repeatedly
        const timePassed = now() - (state.lastBriefAt ?? 0) >= pollEveryMs;
        const hasEscalation = state.observeEscalation?.pending;

        const shouldPost =
          (timePassed && contentChanged) || hasEscalation;

        if (!shouldPost) return;

        let content = text;

        // Forced mention escalation from observation (e.g. repeated errors)
        const forcedMention = state.observeEscalation?.pending
          ? state.observeEscalation.forcedMention
          : "";
        const mention = forcedMention || cfg.discord?.mention;

        if (mention) content = `${mention}\n${content}`;
        if (state.observeEscalation?.pending && state.observeEscalation?.reason) {
          content = `${content}\n\n[escalation] ${state.observeEscalation.reason}`;
        }

        try {
          if (discordEnabled && channelId && discordToken) {
            await discordSendText({
              token: discordToken,
              channelId,
              content,
            });
          }
          // Always log to gateway logs.
          api.logger.info(`\n${content}`);

          // Escalation consumed once we've posted.
          if (state.observeEscalation?.pending) {
            state.observeEscalation.pending = false;
          }

          state.lastBriefAt = now();
          state.lastBriefContent = text; // Track content to avoid duplicate posts
          saveState();
        } catch (err) {
          api.logger.error(
            `[progress-briefing] brief post failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      };

      const interval = setInterval(() => {
        tick().catch((err) =>
          api.logger.error(
            `[progress-briefing] tick failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }, pollEveryMs);

      // Save for stop()
      (api as any).__progressBriefingInterval = interval;
    },
    stop: async () => {
      const interval = (api as any).__progressBriefingInterval as
        | NodeJS.Timeout
        | undefined;
      if (interval) clearInterval(interval);
    },
  });

  // ============================================================
  // Tool call hooks for activity tracking
  // ============================================================
  if (activityEnabled && typeof api.on === "function") {
    // Simple sequential ID for tracking
    let callSeq = 0;
    
    api.on("before_tool_call", (event: any, ctx: any) => {
      if (!activityEnabled) return;
      const toolName = event?.toolName;
      if (!toolName || excludeTools.has(toolName)) return;

      const callId = `${++callSeq}`;

      const agentId = ctx?.agentId || ctx?.sessionKey || "unknown";
      const paramsSummary = formatParamsSummary(event?.params ?? {});

      const existing = agentActivity.get(agentId) || {
        lastToolAt: 0,
        lastToolName: "",
        lastParamsSummary: "",
        recentTools: []
      };

      agentActivity.set(agentId, {
        lastToolAt: now(),
        lastToolName: toolName,
        lastParamsSummary: paramsSummary,
        recentTools: [...existing.recentTools, {
          name: toolName,
          paramsSummary,
          timestamp: now()
        }].slice(-5)
      });

      activeTools.set(callId, {
        toolName,
        params: event?.params ?? {},
        sessionKey: ctx?.sessionKey,
        agentId: ctx?.agentId,
        startedAt: now(),
      });

      api.logger.debug(`[progress-briefing] before_tool_call: ${toolName} (id=${callId})`);

      upsertJob({
        jobId: `agent:${agentId}:current`,
        title: `${agentId} (auto)`,
        owner: agentId,
        state: "running",
        detail: `Last tool: ${toolName} ${paramsSummary}`,
        updatedAt: now()
      });
    });

    // Use tool_result_persist instead of after_tool_call (more reliable)
    api.on("tool_result_persist", (event: any, ctx: any) => {
      if (!activityEnabled) return;
      const toolName = event?.toolName ?? ctx?.toolName;
      if (!toolName || excludeTools.has(toolName)) return;

      api.logger.debug(`[progress-briefing] tool_result_persist: ${toolName}`);

      // Find and remove the oldest matching tool call
      let matchedId: string | undefined;
      let matchedCall: ActiveToolCall | undefined;
      
      for (const [id, call] of activeTools) {
        if (call.toolName === toolName) {
          matchedId = id;
          matchedCall = call;
          break; // Take the first (oldest) match
        }
      }
      
      if (matchedId) {
        activeTools.delete(matchedId);
        api.logger.debug(`[progress-briefing] removed active call: ${matchedId}`);
      }

      const startedAt = matchedCall?.startedAt ?? now();
      const endedAt = now();

      // Add to recent list
      recentTools.unshift({
        toolName,
        params: matchedCall?.params ?? {},
        result: undefined, // tool_result_persist doesn't give us the result easily
        error: undefined,
        sessionKey: ctx?.sessionKey ?? matchedCall?.sessionKey,
        agentId: ctx?.agentId ?? matchedCall?.agentId,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
      });

      // Keep only maxRecentTools
      while (recentTools.length > maxRecentTools) {
        recentTools.pop();
      }
      
      // Return undefined to not modify the message
      return undefined;
    });

    api.logger.info(
      `[progress-briefing] activity tracking enabled (maxRecent=${maxRecentTools}, excludeTools=${[...excludeTools].join(", ")})`,
    );
  }
}
