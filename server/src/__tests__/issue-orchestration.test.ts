import { describe, expect, it } from "vitest";
import {
  parseIssueOrchestrationPolicy,
  parseIssueOrchestrationState,
  pickAutoDelegationCandidate,
  planIssueStatusOrchestration,
} from "../services/issue-orchestration.js";

describe("issue orchestration helpers", () => {
  it("normalizes orchestration policy with defaults", () => {
    expect(
      parseIssueOrchestrationPolicy({
        delegationMode: "auto_direct_reports",
        benchmark: {
          enabled: true,
          maxRetries: 3,
        },
      }),
    ).toEqual({
      delegationMode: "auto_direct_reports",
      benchmark: {
        enabled: true,
        assigneeMode: "parent_assignee",
        maxRetries: 3,
        instructions: null,
      },
    });
  });

  it("picks the least-loaded direct report", () => {
    const candidate = pickAutoDelegationCandidate([
      { id: "agent-b", createdAt: new Date("2026-03-01T00:00:00.000Z"), openIssueCount: 2 },
      { id: "agent-a", createdAt: new Date("2026-02-01T00:00:00.000Z"), openIssueCount: 2 },
      { id: "agent-c", createdAt: new Date("2026-01-01T00:00:00.000Z"), openIssueCount: 1 },
    ]);
    expect(candidate?.id).toBe("agent-c");
  });

  it("creates a benchmark plan when a child issue is completed", () => {
    const plan = planIssueStatusOrchestration({
      previousStatus: "in_progress",
      currentIssue: {
        id: "issue-1",
        parentId: "parent-1",
        status: "done",
        assigneeAgentId: "engineer-1",
        createdByAgentId: "manager-1",
        orchestrationState: null,
      },
      parentIssue: {
        assigneeAgentId: "manager-1",
        orchestrationPolicy: {
          benchmark: {
            enabled: true,
            assigneeMode: "parent_assignee",
            maxRetries: 2,
          },
        },
      },
    });

    expect(plan).toEqual({
      kind: "create_benchmark",
      evaluatorAgentId: "manager-1",
      attempt: 1,
      maxRetries: 2,
      instructions: null,
    });
  });

  it("marks a benchmark pass when the benchmark issue is done", () => {
    const plan = planIssueStatusOrchestration({
      previousStatus: "in_progress",
      currentIssue: {
        id: "benchmark-1",
        parentId: "issue-1",
        status: "done",
        assigneeAgentId: "manager-1",
        createdByAgentId: "manager-1",
        orchestrationState: {
          benchmarkSourceIssueId: "issue-1",
          benchmarkAttempt: 1,
          benchmarkMaxRetries: 2,
        },
      },
      parentIssue: null,
    });

    expect(plan).toEqual({
      kind: "resolve_benchmark",
      sourceIssueId: "issue-1",
      attempt: 1,
      maxRetries: 2,
      outcome: "pass",
    });
  });

  it("retries source work while retries remain after benchmark failure", () => {
    const plan = planIssueStatusOrchestration({
      previousStatus: "in_progress",
      currentIssue: {
        id: "benchmark-1",
        parentId: "issue-1",
        status: "blocked",
        assigneeAgentId: "manager-1",
        createdByAgentId: "manager-1",
        orchestrationState: {
          benchmarkSourceIssueId: "issue-1",
          benchmarkAttempt: 2,
          benchmarkMaxRetries: 3,
        },
      },
      parentIssue: null,
    });

    expect(plan).toEqual({
      kind: "resolve_benchmark",
      sourceIssueId: "issue-1",
      attempt: 2,
      maxRetries: 3,
      outcome: "retry",
    });
  });

  it("blocks source work when benchmark retries are exhausted", () => {
    const state = parseIssueOrchestrationState({
      benchmarkSourceIssueId: "issue-1",
      benchmarkAttempt: 3,
      benchmarkMaxRetries: 2,
    });

    const plan = planIssueStatusOrchestration({
      previousStatus: "in_review",
      currentIssue: {
        id: "benchmark-1",
        parentId: "issue-1",
        status: "cancelled",
        assigneeAgentId: "manager-1",
        createdByAgentId: "manager-1",
        orchestrationState: state,
      },
      parentIssue: null,
    });

    expect(plan).toEqual({
      kind: "resolve_benchmark",
      sourceIssueId: "issue-1",
      attempt: 3,
      maxRetries: 2,
      outcome: "blocked",
    });
  });
});
