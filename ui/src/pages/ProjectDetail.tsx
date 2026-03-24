import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike, type BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { MetricCard } from "../components/MetricCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { projectRouteRef, cn, formatDate } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { Activity, AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "configuration" | "budget";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  return null;
}

/* ── Overview tab content ── */

function resolveIssueRecipientAgentId(issue: {
  assigneeAgentId: string | null;
  lastAssignedAgentId?: string | null;
}) {
  return issue.assigneeAgentId ?? issue.lastAssignedAgentId ?? null;
}

function resolveIssueRecipientUserId(issue: {
  assigneeUserId: string | null;
  lastAssignedUserId?: string | null;
}) {
  return issue.assigneeUserId ?? issue.lastAssignedUserId ?? null;
}

function actorLabel(agentId: string | null, userId: string | null, agentNameById: Map<string, string>) {
  if (agentId) return agentNameById.get(agentId) ?? agentId.slice(0, 8);
  if (userId) return "Board";
  return "—";
}

function inferStageAndGate(
  issue: { status: string },
  assigneeName: string | null,
) {
  const role = assigneeName?.toUpperCase() ?? "";
  if (role.includes("CTO")) return { stage: "Inquiry / Intake", gate: "—" };
  if (role.includes("BA")) return { stage: "Requirement Definition", gate: "Requirement Approval" };
  if (role.includes("TECH LEAD")) return { stage: "Solutioning", gate: "—" };
  if (role.includes("DESIGNER")) return { stage: "UX/UI Design", gate: "UX/UI Approval" };
  if (role.includes("QA")) return { stage: "QA Validation", gate: "QA Exit Approval" };
  if (role.includes("SD")) return { stage: "Service Desk", gate: "—" };
  if (
    role.includes("FE") ||
    role.includes("BE") ||
    role.includes("INTEGRATION") ||
    role.includes("DEVOPS")
  ) {
    return { stage: "Development", gate: "—" };
  }
  if (role.includes("PM")) return { stage: "Delivery Coordination", gate: "—" };
  return { stage: issue.status === "done" ? "Completed" : "Execution", gate: "—" };
}

function stageBadgeClass(stage: string) {
  if (stage === "Inquiry / Intake") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (stage === "Requirement Definition") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (stage === "Solutioning") return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (stage === "UX/UI Design") return "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300";
  if (stage === "Development") return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
  if (stage === "QA Validation") return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  if (stage === "Service Desk") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (stage === "Delivery Coordination") return "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
  if (stage === "Completed") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return "border-border bg-muted text-muted-foreground";
}

function gateBadgeClass(gate: string) {
  if (gate === "Requirement Approval") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (gate === "UX/UI Approval") return "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300";
  if (gate === "QA Exit Approval") return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  return "border-border bg-muted text-muted-foreground";
}

function approvalTypeLabel(type: string) {
  if (type === "approve_requirement_package") return "Requirement Approval";
  if (type === "approve_design_package") return "UX/UI Approval";
  if (type === "approve_qa_exit") return "QA Exit Approval";
  return type.replace(/_/g, " ");
}

function gateApproverLabel(stageKey: TimelineStageDef["key"]) {
  if (stageKey === "requirement") return "PM";
  if (stageKey === "design") return "PM + TECH LEAD";
  if (stageKey === "qa") return "TECH LEAD + PM";
  return "Reviewer";
}

function activeGateLabelForIssue(
  issueId: string | null,
  pendingApprovals: Array<{ issueId: string; approval: { type: string } }>,
) {
  if (!issueId) return null;
  const match = pendingApprovals.find((item) => item.issueId === issueId);
  return match ? approvalTypeLabel(match.approval.type) : null;
}

function buildWorkflowChain(issue: {
  ancestors?: Array<{
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    lastAssignedAgentId: string | null;
    lastAssignedUserId: string | null;
  }>;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  lastAssignedAgentId?: string | null;
  lastAssignedUserId?: string | null;
}, agentNameById: Map<string, string>) {
  const steps: string[] = [];
  for (const ancestor of issue.ancestors ?? []) {
    const label = actorLabel(
      ancestor.assigneeAgentId ?? ancestor.lastAssignedAgentId ?? null,
      ancestor.assigneeUserId ?? ancestor.lastAssignedUserId ?? null,
      agentNameById,
    );
    if (label !== "—" && steps[steps.length - 1] !== label) steps.push(label);
  }
  const current = actorLabel(
    resolveIssueRecipientAgentId(issue),
    resolveIssueRecipientUserId(issue),
    agentNameById,
  );
  if (current !== "—" && steps[steps.length - 1] !== current) steps.push(current);
  return steps.length > 0 ? steps.join(" -> ") : "—";
}

type TimelineStageDef = {
  key:
    | "intake"
    | "requirement"
    | "solutioning"
    | "design"
    | "development"
    | "qa"
    | "uat"
    | "handover";
  title: string;
  owner: string;
  gate?: string | null;
};

const DELIVERY_TIMELINE: TimelineStageDef[] = [
  { key: "intake", title: "1. Inquiry / Opportunity Intake", owner: "CTO" },
  { key: "requirement", title: "2. Planning & Requirement Definition", owner: "PM + BA", gate: "Requirement Approval" },
  { key: "solutioning", title: "3. Solutioning & Technical Planning", owner: "TECH LEAD" },
  { key: "design", title: "4. UX/UI Design", owner: "DESIGNER", gate: "UX/UI Approval" },
  { key: "development", title: "5. Development", owner: "TECH LEAD + FE/BE/INTEGRATION/DEVOPS" },
  { key: "qa", title: "6. QA / Internal Validation", owner: "QA", gate: "QA Exit Approval" },
  { key: "uat", title: "7. UAT / Go-Live", owner: "PM" },
  { key: "handover", title: "8. Hypercare / Handover / Service Desk", owner: "PM -> SD" },
];

function inferTimelineStageKey(
  issue: { title: string; description: string | null; status: string },
  assigneeName: string | null,
): TimelineStageDef["key"] | null {
  const role = assigneeName?.toUpperCase() ?? "";
  const text = `${issue.title} ${issue.description ?? ""}`.toLowerCase();

  if (role.includes("CTO")) return "intake";
  if (role.includes("BA")) return "requirement";
  if (role.includes("DESIGNER")) return "design";
  if (role.includes("QA")) return "qa";
  if (role.includes("SD")) return "handover";
  if (role.includes("FE") || role.includes("BE") || role.includes("INTEGRATION") || role.includes("DEVOPS")) return "development";
  if (role.includes("TECH LEAD")) {
    if (/(build|develop|implementation|module|integration|deploy|security|fix)/.test(text)) return "development";
    return "solutioning";
  }
  if (role.includes("PM")) {
    if (/(hypercare|handover|service desk|takeover)/.test(text)) return "handover";
    if (/(uat|go-live|golive|go live|release readiness)/.test(text)) return "uat";
    return "requirement";
  }
  return issue.status === "done" ? "handover" : null;
}

function timelineStateBadgeClass(state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming") {
  if (state === "completed") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (state === "in_progress") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (state === "pending_approval") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (state === "operator_action") return "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300";
  if (state === "blocked") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  return "border-border bg-muted text-muted-foreground";
}

function timelineNodeClass(state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming") {
  if (state === "completed") return "border-emerald-500/40 bg-emerald-500/20 text-emerald-300";
  if (state === "in_progress") return "border-sky-500/40 bg-sky-500/20 text-sky-300";
  if (state === "pending_approval") return "border-amber-500/40 bg-amber-500/20 text-amber-300";
  if (state === "operator_action") return "border-fuchsia-500/40 bg-fuchsia-500/20 text-fuchsia-300";
  if (state === "blocked") return "border-red-500/40 bg-red-500/20 text-red-300";
  return "border-border bg-muted text-muted-foreground";
}

function timelineDotClass(state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming") {
  if (state === "completed") return "border-emerald-400";
  if (state === "in_progress") return "border-sky-400";
  if (state === "pending_approval") return "border-amber-400";
  if (state === "operator_action") return "border-fuchsia-400";
  if (state === "blocked") return "border-red-400";
  return "border-muted-foreground/40";
}

function timelineCardClass(state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming") {
  if (state === "completed") return "border-emerald-500/20 bg-emerald-500/5";
  if (state === "in_progress") return "border-sky-500/20 bg-sky-500/5";
  if (state === "pending_approval") return "border-amber-500/20 bg-amber-500/5";
  if (state === "operator_action") return "border-fuchsia-500/20 bg-fuchsia-500/5";
  if (state === "blocked") return "border-red-500/20 bg-red-500/5";
  return "border-border/70 bg-card";
}

function timelineStageAccent(stageKey: TimelineStageDef["key"]) {
  if (stageKey === "intake") return "from-slate-900 to-blue-950 border-blue-900/50";
  if (stageKey === "requirement") return "from-blue-700 to-blue-900 border-blue-500/30";
  if (stageKey === "solutioning") return "from-teal-700 to-cyan-900 border-teal-500/30";
  if (stageKey === "design") return "from-violet-700 to-purple-900 border-violet-500/30";
  if (stageKey === "development") return "from-orange-600 to-orange-800 border-orange-500/30";
  if (stageKey === "qa") return "from-red-700 to-rose-900 border-red-500/30";
  if (stageKey === "uat") return "from-green-700 to-emerald-900 border-green-500/30";
  return "from-amber-800 to-stone-900 border-amber-600/30";
}

function timelineStateLabel(state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming") {
  if (state === "completed") return "Completed";
  if (state === "in_progress") return "In Progress";
  if (state === "pending_approval") return "Pending";
  if (state === "operator_action") return "Operator Action";
  if (state === "blocked") return "Blocked / On Hold";
  return "Upcoming";
}

function OverviewContent({
  project,
  companyId,
  projectId,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null; leadAgentId?: string | null; updatedAt?: Date | string | null };
  companyId: string;
  projectId: string;
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: projectIssues } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId && !!projectId,
  });

  const issueApprovalQueries = useQueries({
    queries: (projectIssues ?? []).map((issue) => ({
      queryKey: queryKeys.issues.approvals(issue.id),
      queryFn: () => issuesApi.listApprovals(issue.id),
      enabled: !!companyId,
    })),
  });

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const openIssues = useMemo(
    () => (projectIssues ?? []).filter((issue) => !["done", "cancelled"].includes(issue.status)),
    [projectIssues],
  );
  const blockedCount = useMemo(
    () => (projectIssues ?? []).filter((issue) => issue.status === "blocked").length,
    [projectIssues],
  );
  const doneCount = useMemo(
    () => (projectIssues ?? []).filter((issue) => issue.status === "done").length,
    [projectIssues],
  );

  const approvalsByIssue = useMemo(() => {
    const rows: Array<{ issueId: string; issueTitle: string; approval: { id: string; type: string; status: string; updatedAt: Date | string } }> = [];
    for (let index = 0; index < (projectIssues ?? []).length; index += 1) {
      const issue = projectIssues![index]!;
      for (const approval of issueApprovalQueries[index]?.data ?? []) {
        rows.push({
          issueId: issue.id,
          issueTitle: issue.title,
          approval,
        });
      }
    }
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.approval.id)) return false;
      seen.add(row.approval.id);
      return true;
    });
  }, [issueApprovalQueries, projectIssues]);

  const pendingApprovals = useMemo(
    () => approvalsByIssue.filter((row) => row.approval.status === "pending" || row.approval.status === "revision_requested"),
    [approvalsByIssue],
  );

  const currentIssue = useMemo(() => {
    const issues = openIssues.length > 0 ? openIssues : (projectIssues ?? []);
    return [...issues].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
  }, [openIssues, projectIssues]);

  const currentAssigneeName = currentIssue
    ? actorLabel(resolveIssueRecipientAgentId(currentIssue), resolveIssueRecipientUserId(currentIssue), agentNameById)
    : null;
  const inferredStage = currentIssue ? inferStageAndGate(currentIssue, currentAssigneeName) : { stage: "Execution", gate: "—" };
  const activeGate = activeGateLabelForIssue(currentIssue?.id ?? null, pendingApprovals);

  const deliveryOwner = useMemo(() => {
    if (project.leadAgentId) return agentNameById.get(project.leadAgentId) ?? project.leadAgentId.slice(0, 8);
    const pmIssue = (projectIssues ?? []).find((issue) => {
      const assigneeName = actorLabel(resolveIssueRecipientAgentId(issue), resolveIssueRecipientUserId(issue), agentNameById);
      return assigneeName.toUpperCase().includes("PM");
    });
    if (pmIssue) return actorLabel(resolveIssueRecipientAgentId(pmIssue), resolveIssueRecipientUserId(pmIssue), agentNameById);
    const rootIssue = [...(projectIssues ?? [])].sort((a, b) => a.requestDepth - b.requestDepth || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    if (rootIssue) return actorLabel(resolveIssueRecipientAgentId(rootIssue), resolveIssueRecipientUserId(rootIssue), agentNameById);
    return "—";
  }, [agentNameById, project.leadAgentId, projectIssues]);

  const nextAction = useMemo(() => {
    const pending = [...pendingApprovals].sort(
      (a, b) => new Date(b.approval.updatedAt).getTime() - new Date(a.approval.updatedAt).getTime(),
    )[0];
    if (pending) {
      return `${approvalTypeLabel(pending.approval.type)} pending on ${pending.issueTitle}`;
    }
    if (currentIssue && currentAssigneeName) {
      return `Continue ${inferredStage.stage} with ${currentAssigneeName}`;
    }
    return "No open workflow step";
  }, [currentAssigneeName, currentIssue, inferredStage.stage, pendingApprovals]);

  const recentWorkflow = useMemo(
    () => (currentIssue ? buildWorkflowChain(currentIssue, agentNameById) : "—"),
    [agentNameById, currentIssue],
  );

  const timelineStages = useMemo(() => {
    const stageMap = new Map(
      DELIVERY_TIMELINE.map((stage) => [
        stage.key,
        {
          ...stage,
          issues: [] as typeof openIssues,
          pendingApprovals: [] as typeof pendingApprovals,
        },
      ]),
    );

    for (const issue of projectIssues ?? []) {
      const assigneeName = actorLabel(resolveIssueRecipientAgentId(issue), resolveIssueRecipientUserId(issue), agentNameById);
      const stageKey = inferTimelineStageKey(issue, assigneeName);
      if (!stageKey) continue;
      stageMap.get(stageKey)?.issues.push(issue);
    }

    for (const item of pendingApprovals) {
      const stageKey =
        item.approval.type === "approve_requirement_package"
          ? "requirement"
          : item.approval.type === "approve_design_package"
            ? "design"
            : item.approval.type === "approve_qa_exit"
              ? "qa"
              : null;
      if (!stageKey) continue;
      stageMap.get(stageKey)?.pendingApprovals.push(item);
    }

    const startedIndexes = DELIVERY_TIMELINE
      .map((stage, index) => ((stageMap.get(stage.key)?.issues.length ?? 0) > 0 ? index : -1))
      .filter((index) => index >= 0);
    const furthestStartedIndex = startedIndexes.length > 0 ? Math.max(...startedIndexes) : -1;
    const earliestPendingIndex = DELIVERY_TIMELINE.findIndex((stage) => (stageMap.get(stage.key)?.pendingApprovals.length ?? 0) > 0);
    const earliestBlockedIndex = DELIVERY_TIMELINE.findIndex((stage) =>
      (stageMap.get(stage.key)?.issues ?? []).some((issue) => issue.status === "blocked"),
    );
    const focusIndex =
      earliestPendingIndex >= 0
        ? earliestPendingIndex
        : earliestBlockedIndex >= 0
          ? earliestBlockedIndex
          : furthestStartedIndex;

    return DELIVERY_TIMELINE.map((stage, index) => {
      const bucket = stageMap.get(stage.key)!;
      const openStageIssues = bucket.issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
      const latestIssue = [...bucket.issues].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0] ?? null;
      const latestAssignee = latestIssue
        ? actorLabel(resolveIssueRecipientAgentId(latestIssue), resolveIssueRecipientUserId(latestIssue), agentNameById)
        : null;
      const pending = bucket.pendingApprovals[0] ?? null;

      const waitingForOperatorApprovalRequest =
        Boolean(stage.gate) &&
        !pending &&
        openStageIssues.length > 0 &&
        openStageIssues.every(
          (issue) =>
            issue.status === "todo" &&
            !issue.assigneeAgentId &&
            !issue.assigneeUserId &&
            Boolean(issue.lastAssignedAgentId ?? issue.lastAssignedUserId),
        );

      let state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming" = "upcoming";
      if (pending) {
        state = "pending_approval";
      } else if (waitingForOperatorApprovalRequest) {
        state = "operator_action";
      } else if (bucket.issues.some((issue) => issue.status === "blocked")) {
        state = "blocked";
      } else if (index < focusIndex && focusIndex >= 0) {
        state = "completed";
      } else if (index === focusIndex && focusIndex >= 0 && (openStageIssues.length > 0 || bucket.issues.length > 0)) {
        state = "in_progress";
      } else if (furthestStartedIndex >= index && bucket.issues.length > 0 && openStageIssues.length === 0) {
        state = "completed";
      }

      let detail = "Chưa bắt đầu.";
      if (state === "pending_approval" && pending) {
        detail = `Đang chờ ${approvalTypeLabel(pending.approval.type)} cho issue "${pending.issueTitle}".`;
      } else if (state === "operator_action" && latestIssue) {
        detail = `Waiting operator to send ${stage.gate} to ${gateApproverLabel(stage.key)} for issue "${latestIssue.title}".`;
      } else if (state === "blocked") {
        const blockedIssue = bucket.issues.find((issue) => issue.status === "blocked");
        detail = blockedIssue ? `Đang bị blocked ở issue "${blockedIssue.title}".` : "Có issue blocked trong giai đoạn này.";
      } else if (state === "in_progress" && latestIssue) {
        detail = latestAssignee
          ? `${latestAssignee} đang xử lý "${latestIssue.title}".`
          : `Đang xử lý "${latestIssue.title}".`;
      } else if (state === "completed") {
        detail = latestIssue ? `Hoàn tất qua issue "${latestIssue.title}".` : "";
      }

      return {
        ...stage,
        state,
        latestIssue,
        latestAssignee,
        pendingApproval: pending,
        waitingForOperatorApprovalRequest,
        detail,
      };
    });
  }, [agentNameById, pendingApprovals, projectIssues]);

  const currentTimelineStage =
    timelineStages.find(
      (stage) =>
        stage.state === "pending_approval" ||
        stage.state === "operator_action" ||
        stage.state === "blocked" ||
        stage.state === "in_progress",
    ) ?? null;
  const completedStages = timelineStages.filter((stage) => stage.state === "completed").length;
  const progressPercent = Math.max(
    0,
    Math.min(
      100,
      Math.round(((completedStages + (currentTimelineStage ? 0.5 : 0)) / Math.max(timelineStages.length, 1)) * 100),
    ),
  );

  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-border/70 bg-card">
          <MetricCard
            icon={Activity}
            value={openIssues.length}
            label="Open Issues"
            description={`${projectIssues?.length ?? 0} total issues`}
          />
        </div>
        <div className="rounded-lg border border-border/70 bg-card">
          <MetricCard
            icon={CheckCircle2}
            value={doneCount}
            label="Done"
            description="Completed delivery outputs"
          />
        </div>
        <div className="rounded-lg border border-border/70 bg-card">
          <MetricCard
            icon={AlertTriangle}
            value={blockedCount}
            label="Blocked"
            description="Issues needing intervention"
          />
        </div>
        <div className="rounded-lg border border-border/70 bg-card">
          <MetricCard
            icon={ShieldCheck}
            value={pendingApprovals.length}
            label="Pending Approvals"
            description="Approval gates awaiting action"
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium">Project Progress</p>
            <p className="text-sm text-muted-foreground">
              {completedStages}/{timelineStages.length} stages completed
              {currentTimelineStage ? `, current stage: ${currentTimelineStage.title.replace(/^\d+\.\s*/, "")}` : ""}
            </p>
            {currentTimelineStage?.state === "operator_action" ? (
              <p className="mt-1 text-sm text-fuchsia-600 dark:text-fuchsia-300">
                Waiting operator to send {currentTimelineStage.gate} to {gateApproverLabel(currentTimelineStage.key)}.
              </p>
            ) : currentTimelineStage?.state === "pending_approval" ? (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-300">
                Waiting approval before the project can move to the next stage.
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums">{progressPercent}%</p>
            {project.targetDate ? (
              <p className="text-xs text-muted-foreground">Target: {formatDate(project.targetDate)}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-500 to-emerald-500 transition-[width] duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-base font-semibold">Delivery Timeline</h3>
            <p className="text-sm text-muted-foreground">
              Theo doi 8 giai doan delivery, biet ngay du an dang o dau va co dang ket gate hay khong.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {currentTimelineStage ? (
              <>
                <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold", timelineStateBadgeClass(currentTimelineStage.state))}>
                  {timelineStateLabel(currentTimelineStage.state)}
                </span>
                <span className="inline-flex rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  {currentTimelineStage.title.replace(/^\d+\.\s*/, "")}
                </span>
              </>
            ) : (
              <span className="inline-flex rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                No active stage
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] sm:text-xs">
          {[
            { state: "completed" as const, label: "Completed" },
            { state: "in_progress" as const, label: "In Progress" },
            { state: "pending_approval" as const, label: "Pending" },
            { state: "operator_action" as const, label: "Operator Action" },
            { state: "blocked" as const, label: "Blocked" },
            { state: "upcoming" as const, label: "Upcoming" },
          ].map((item) => (
            <span key={item.state} className="inline-flex items-center gap-2 text-muted-foreground">
              <span className={cn("h-2.5 w-2.5 rounded-full border", timelineStateBadgeClass(item.state).replace("px-2.5 py-1 text-[11px] font-semibold", ""))} />
              <span>{item.label}</span>
            </span>
          ))}
        </div>

        <div className="mt-5 relative">
          <div className="absolute left-[116px] top-0 bottom-0 w-px -translate-x-1/2 bg-border/80" />
          {timelineStages.map((stage, index) => (
            <div key={stage.key} className="relative grid grid-cols-[88px_24px_minmax(0,1fr)] gap-4 pb-6 last:pb-0">
              <div className="text-right">
                <div className="text-lg font-semibold leading-none text-foreground">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{stage.owner}</div>
              </div>

              <div className="relative flex justify-center">
                <div className={cn("mt-1 h-5 w-5 rounded-full border-[4px] bg-card", timelineDotClass(stage.state))} />
              </div>

              <div className="min-w-0 pb-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold leading-tight text-foreground">{stage.title.replace(/^\d+\.\s*/, "")}</p>
                  <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold", timelineStateBadgeClass(stage.state))}>
                    {timelineStateLabel(stage.state)}
                  </span>
                </div>
                <div className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                  <p>{stage.detail}</p>
                  {stage.gate ? <p>- Gate: {stage.gate}</p> : null}
                  {stage.pendingApproval ? (
                    <p>- Pending: {approvalTypeLabel(stage.pendingApproval.approval.type)}</p>
                  ) : null}
                  {stage.latestAssignee ? <p>- Actor: {stage.latestAssignee}</p> : null}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {stage.pendingApproval
                    ? `Updated ${timeAgo(stage.pendingApproval.approval.updatedAt)}`
                    : stage.latestIssue
                      ? `Updated ${timeAgo(stage.latestIssue.updatedAt)}`
                      : "Chua co activity"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive project" : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Project",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={[
            { value: "list", label: "Issues" },
            { value: "overview", label: "Overview" },
            { value: "configuration", label: "Configuration" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          companyId={resolvedCompanyId!}
          projectId={project.id}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
