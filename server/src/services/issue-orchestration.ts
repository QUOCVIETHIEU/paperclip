import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import type { IssueBenchmarkStatus, IssueOrchestrationPolicy, IssueOrchestrationState } from "@paperclipai/shared";

const ACTIVE_WORKLOAD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const BENCHMARK_FAIL_STATUSES = new Set(["blocked", "cancelled"]);

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export interface DelegationCandidate {
  id: string;
  createdAt: Date;
  openIssueCount: number;
}

export interface BenchmarkCreationPlan {
  kind: "create_benchmark";
  evaluatorAgentId: string;
  attempt: number;
  maxRetries: number;
  instructions: string | null;
}

export interface BenchmarkResolutionPlan {
  kind: "resolve_benchmark";
  sourceIssueId: string;
  attempt: number;
  maxRetries: number;
  outcome: "pass" | "retry" | "blocked";
}

export type IssueStatusOrchestrationPlan = BenchmarkCreationPlan | BenchmarkResolutionPlan | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseIssueOrchestrationPolicy(value: unknown): IssueOrchestrationPolicy | null {
  const record = asRecord(value);
  if (!record) return null;
  const benchmarkRecord = asRecord(record.benchmark);
  return {
    delegationMode: record.delegationMode === "auto_direct_reports" ? "auto_direct_reports" : "manual",
    benchmark: benchmarkRecord
      ? {
        enabled: benchmarkRecord.enabled === true,
        assigneeMode: benchmarkRecord.assigneeMode === "creator_agent" ? "creator_agent" : "parent_assignee",
        maxRetries: asNonNegativeInt(benchmarkRecord.maxRetries, 1),
        instructions: asNullableString(benchmarkRecord.instructions),
      }
      : null,
  };
}

export function parseIssueOrchestrationState(value: unknown): IssueOrchestrationState {
  const record = asRecord(value);
  if (!record) return {};

  const benchmarkStatus = record.benchmarkStatus;
  const normalizedStatus: IssueBenchmarkStatus =
    benchmarkStatus === "pending" || benchmarkStatus === "passed" || benchmarkStatus === "failed"
      ? benchmarkStatus
      : "idle";

  return {
    benchmarkStatus: normalizedStatus,
    benchmarkAttempts: asNonNegativeInt(record.benchmarkAttempts, 0),
    lastBenchmarkIssueId: asNullableString(record.lastBenchmarkIssueId),
    benchmarkSourceIssueId: asNullableString(record.benchmarkSourceIssueId),
    benchmarkAttempt: record.benchmarkAttempt == null ? null : asNonNegativeInt(record.benchmarkAttempt, 0),
    benchmarkMaxRetries: record.benchmarkMaxRetries == null ? null : asNonNegativeInt(record.benchmarkMaxRetries, 0),
  };
}

export function pickAutoDelegationCandidate<T extends DelegationCandidate>(candidates: T[]): T | null {
  return [...candidates]
    .sort((left, right) => {
      if (left.openIssueCount !== right.openIssueCount) return left.openIssueCount - right.openIssueCount;
      const createdAtDiff = left.createdAt.getTime() - right.createdAt.getTime();
      if (createdAtDiff !== 0) return createdAtDiff;
      return left.id.localeCompare(right.id);
    })[0] ?? null;
}

export async function findAutoDelegationAssignee(
  db: Db,
  companyId: string,
  managerAgentId: string,
): Promise<AgentRow | null> {
  const directReports = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      icon: agents.icon,
      status: agents.status,
      reportsTo: agents.reportsTo,
      capabilities: agents.capabilities,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      budgetMonthlyCents: agents.budgetMonthlyCents,
      spentMonthlyCents: agents.spentMonthlyCents,
      pauseReason: agents.pauseReason,
      pausedAt: agents.pausedAt,
      permissions: agents.permissions,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      metadata: agents.metadata,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.reportsTo, managerAgentId),
        inArray(agents.status, ["active", "idle", "running", "error"]),
      ),
    );

  if (directReports.length === 0) return null;

  const loadRows = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      openIssueCount: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(
          issues.assigneeAgentId,
          directReports.map((row) => row.id),
        ),
        inArray(issues.status, [...ACTIVE_WORKLOAD_STATUSES]),
      ),
    )
    .groupBy(issues.assigneeAgentId);

  const loadByAgentId = new Map(loadRows.map((row) => [row.assigneeAgentId ?? "", Number(row.openIssueCount ?? 0)]));
  const candidate = pickAutoDelegationCandidate(
    directReports.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      openIssueCount: loadByAgentId.get(row.id) ?? 0,
    })),
  );

  if (!candidate) return null;
  return directReports.find((row) => row.id === candidate.id) ?? null;
}

export function buildBenchmarkIssueTitle(title: string): string {
  return `Benchmark: ${title}`;
}

export function planIssueStatusOrchestration(input: {
  previousStatus: string;
  currentIssue: Pick<IssueRow, "id" | "parentId" | "status" | "assigneeAgentId" | "createdByAgentId" | "orchestrationState">;
  parentIssue: Pick<IssueRow, "assigneeAgentId" | "orchestrationPolicy"> | null;
}): IssueStatusOrchestrationPlan {
  if (input.previousStatus === input.currentIssue.status) return null;

  const currentState = parseIssueOrchestrationState(input.currentIssue.orchestrationState);
  if (currentState.benchmarkSourceIssueId) {
    if (input.currentIssue.status === "done") {
      return {
        kind: "resolve_benchmark",
        sourceIssueId: currentState.benchmarkSourceIssueId,
        attempt: Math.max(1, currentState.benchmarkAttempt ?? 1),
        maxRetries: Math.max(0, currentState.benchmarkMaxRetries ?? 1),
        outcome: "pass",
      };
    }
    if (BENCHMARK_FAIL_STATUSES.has(input.currentIssue.status)) {
      const attempt = Math.max(1, currentState.benchmarkAttempt ?? 1);
      const maxRetries = Math.max(0, currentState.benchmarkMaxRetries ?? 1);
      return {
        kind: "resolve_benchmark",
        sourceIssueId: currentState.benchmarkSourceIssueId,
        attempt,
        maxRetries,
        outcome: attempt <= maxRetries ? "retry" : "blocked",
      };
    }
    return null;
  }

  if (input.currentIssue.status !== "done" || !input.parentIssue) return null;

  const parentPolicy = parseIssueOrchestrationPolicy(input.parentIssue.orchestrationPolicy);
  const benchmark = parentPolicy?.benchmark;
  if (!benchmark?.enabled) return null;

  const evaluatorAgentId =
    benchmark.assigneeMode === "creator_agent"
      ? input.currentIssue.createdByAgentId
      : input.parentIssue.assigneeAgentId;

  if (!evaluatorAgentId) return null;
  if (evaluatorAgentId === input.currentIssue.assigneeAgentId) return null;

  return {
    kind: "create_benchmark",
    evaluatorAgentId,
    attempt: (currentState.benchmarkAttempts ?? 0) + 1,
    maxRetries: Math.max(0, benchmark.maxRetries ?? 1),
    instructions: benchmark.instructions ?? null,
  };
}
