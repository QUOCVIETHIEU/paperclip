import type { IssueBenchmarkAssigneeMode, IssueDelegationMode, IssueOrchestrationPolicy } from "@paperclipai/shared";

interface ManagerAutonomyParseOptions {
  hasDirectReports?: boolean;
}

export interface ManagerAutonomyConfig {
  enabled: boolean;
  injectPrompt: boolean;
  delegationMode: IssueDelegationMode | null;
  benchmarkEnabled: boolean;
  benchmarkAssigneeMode: IssueBenchmarkAssigneeMode;
  benchmarkMaxRetries: number;
}

interface BuildManagerAutonomyPromptInput {
  agent: { name: string; role: string; title: string | null };
  directReports: Array<{ name: string; role: string; title: string | null; capabilities: string | null }>;
  config: ManagerAutonomyConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min = 0, max = 10) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readDelegationMode(value: unknown, fallback: IssueDelegationMode | null): IssueDelegationMode | null {
  return value === "auto_direct_reports" ? value : fallback;
}

function readBenchmarkAssigneeMode(
  value: unknown,
  fallback: IssueBenchmarkAssigneeMode,
): IssueBenchmarkAssigneeMode {
  return value === "parent_assignee" ? value : fallback;
}

export function parseManagerAutonomyConfig(
  runtimeConfig: unknown,
  options: ManagerAutonomyParseOptions = {},
): ManagerAutonomyConfig {
  const hasDirectReports = options.hasDirectReports === true;
  const runtime = isRecord(runtimeConfig) ? runtimeConfig : {};
  const raw = isRecord(runtime.managerAutonomy) ? runtime.managerAutonomy : {};

  const enabled = readBoolean(raw.enabled, hasDirectReports);
  const delegationMode = enabled
    ? readDelegationMode(raw.delegationMode, hasDirectReports ? "auto_direct_reports" : null)
    : null;
  const benchmarkEnabled = enabled && readBoolean(raw.benchmarkEnabled, hasDirectReports);
  const benchmarkAssigneeMode = readBenchmarkAssigneeMode(raw.benchmarkAssigneeMode, "parent_assignee");
  const benchmarkMaxRetries = benchmarkEnabled
    ? readInteger(raw.benchmarkMaxRetries, 1, 0, 10)
    : 0;

  return {
    enabled,
    injectPrompt: enabled && readBoolean(raw.injectPrompt, hasDirectReports),
    delegationMode,
    benchmarkEnabled,
    benchmarkAssigneeMode,
    benchmarkMaxRetries,
  };
}

export function buildDefaultManagerIssueOrchestrationPolicy(
  config: ManagerAutonomyConfig,
): IssueOrchestrationPolicy | null {
  if (!config.enabled) return null;

  const policy: IssueOrchestrationPolicy = {};
  if (config.delegationMode) {
    policy.delegationMode = config.delegationMode;
  }
  if (config.benchmarkEnabled) {
    policy.benchmark = {
      enabled: true,
      assigneeMode: config.benchmarkAssigneeMode,
      maxRetries: config.benchmarkMaxRetries,
    };
  }

  return Object.keys(policy).length > 0 ? policy : null;
}

export function buildManagerAutonomyPrompt(input: BuildManagerAutonomyPromptInput): string | null {
  const { agent, directReports, config } = input;
  if (!config.enabled || !config.injectPrompt || directReports.length === 0) return null;

  const managerLabel = agent.title?.trim() || agent.role || agent.name;
  const reportLines = directReports
    .map((report) => {
      const parts = [report.name];
      if (report.title?.trim()) parts.push(report.title.trim());
      else if (report.role.trim()) parts.push(report.role.trim());
      if (report.capabilities?.trim()) parts.push(report.capabilities.trim());
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");

  const benchmarkLine = config.benchmarkEnabled
    ? `When a child issue is marked done, Paperclip will queue a benchmark review and reopen the source issue if the benchmark fails, up to ${config.benchmarkMaxRetries} retry cycles.`
    : "Benchmark automation is disabled for this manager run.";

  return [
    `Manager autonomy is active for ${managerLabel}.`,
    "You have direct reports available for delegation:",
    reportLines,
    "",
    "Operating rules:",
    "- If the current issue spans multiple domains or would block on parallel work, break it into child issues instead of doing every leaf task yourself.",
    "- Create child issues under the current issue for delegable work. If you know the right subordinate, assign them explicitly; otherwise create the child issue without an assignee and Paperclip will route it to a direct report.",
    "- Keep parent issues focused on coordination, acceptance criteria, integration, and decision making.",
    `- ${benchmarkLine}`,
    "- Only keep work on yourself when it is strategic, ambiguous, or requires cross-team synthesis.",
  ].join("\n");
}
