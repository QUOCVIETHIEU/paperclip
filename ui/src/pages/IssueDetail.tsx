import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { approvalsApi } from "../api/approvals";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import type { Agent, IssueAttachment } from "@paperclipai/shared";

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function compactUserLabel(userId: string | null | undefined, currentUserId?: string | null) {
  if (!userId) return null;
  return userId === currentUserId ? "Me" : "Board";
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

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ACTION_LABELS[action] ?? action} ${key}${title}`;
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function ActorIdentity({ evt, agentMap }: { evt: ActivityEvent; agentMap: Map<string, Agent> }) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  if (evt.actorType === "system") return <Identity name="System" size="sm" />;
  if (evt.actorType === "user") return <Identity name="Board" size="sm" />;
  return <Identity name={id || "Unknown"} size="sm" />;
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
    cost: false,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;
  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(location.state) ?? { label: "Issues", href: "/issues" },
    [location.state],
  );

  // Filter out runs already shown by the live widget to avoid duplication
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === detailTab) ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const childIssues = useMemo(() => {
    if (!allIssues || !issue) return [];
    return allIssues
      .filter((i) => i.parentId === issue.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [allIssues, issue]);

  const linkedRequirementApproval = useMemo(
    () => (linkedApprovals ?? []).find((approval) => approval.type === "approve_requirement_package") ?? null,
    [linkedApprovals],
  );

  const linkedDesignApproval = useMemo(
    () => (linkedApprovals ?? []).find((approval) => approval.type === "approve_design_package") ?? null,
    [linkedApprovals],
  );

  const linkedQaExitApproval = useMemo(
    () => (linkedApprovals ?? []).find((approval) => approval.type === "approve_qa_exit") ?? null,
    [linkedApprovals],
  );

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, currentUserId]);

  const currentAssigneeValue = useMemo(() => {
    if (issue?.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
    if (issue?.assigneeUserId) return `user:${issue.assigneeUserId}`;
    return "";
  }, [issue?.assigneeAgentId, issue?.assigneeUserId]);

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssue = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
    }
  };

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => {
      invalidateIssue();
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      }),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const requestStageApproval = useMutation({
    mutationFn: async ({
      type,
      stage,
      summary,
    }: {
      type: "approve_requirement_package" | "approve_design_package" | "approve_qa_exit";
      stage: string;
      summary: string;
    }) => {
      if (!issue || !resolvedCompanyId) throw new Error("Issue not loaded");
      const approval = await approvalsApi.create(resolvedCompanyId, {
        type,
        requestedByAgentId: issue.createdByAgentId ?? issue.assigneeAgentId ?? null,
        issueIds: [issue.id],
        payload: {
          issueId: issue.id,
          issueIdentifier: issue.identifier ?? issue.id,
          issueTitle: issue.title,
          stage,
          requestedFor:
            agentMap.get(issue.createdByAgentId ?? "")?.name ??
            agentMap.get(issue.assigneeAgentId ?? "")?.name ??
            "Approval",
          summary,
        },
      });
      await issuesApi.update(issue.id, {
        status: "in_review",
        comment: `Requested ${stage} approval in ${approval.id.slice(0, 8)}.`,
      });
      return approval;
    },
    onSuccess: () => {
      invalidateIssue();
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(resolvedCompanyId) });
      }
      pushToast({
        title: "Approval Requested",
        body: "Issue moved to in_review and linked approval has been created.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to request approval",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return issuesApi.uploadAttachment(selectedCompanyId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId, hasLiveRuns]);

  // Redirect to identifier-based URL if navigated via UUID
  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(`/issues/${issue.identifier}`, { replace: true, state: location.state });
    }
  }, [issue, issueId, navigate, location.state]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (issue) {
      openPanel(
        <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
      );
    }
    return () => closePanel();
  }, [issue]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyIssueToClipboard = async () => {
    if (!issue) return;
    const decodeEntities = (text: string) => {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    };
    const title = decodeEntities(issue.title);
    const body = decodeEntities(issue.description ?? "");
    const md = `# ${issue.identifier}: ${title}\n\n${body}`.trimEnd();
    await navigator.clipboard.writeText(md);
    setCopied(true);
    pushToast({ title: "Copied to clipboard", tone: "success" });
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  // Ancestors are returned oldest-first from the server (root at end, immediate parent at start)
  const ancestors = issue.ancestors ?? [];
  const createdByLabel = issue.createdByAgentId
    ? (agentMap.get(issue.createdByAgentId)?.name ?? "Agent")
    : (compactUserLabel(issue.createdByUserId, currentUserId) ?? "System");
  const displayAssigneeAgentId = issue.assigneeAgentId ?? issue.lastAssignedAgentId;
  const displayAssigneeUserId = issue.assigneeUserId ?? issue.lastAssignedUserId;
  const assigneeLabel = displayAssigneeAgentId
    ? (agentMap.get(displayAssigneeAgentId)?.name ?? "Agent")
    : displayAssigneeUserId
      ? (compactUserLabel(displayAssigneeUserId, currentUserId) ?? "User")
      : "Unassigned";
  const parentRef = issue.parentId
    ? (ancestors[0]?.identifier ?? issue.parentId.slice(0, 8))
    : "Root";
  const workflowChain = [...ancestors]
    .reverse()
    .map((ancestor) => {
      const ancestorAssigneeAgentId = ancestor.assigneeAgentId ?? ancestor.lastAssignedAgentId;
      const ancestorAssigneeUserId = ancestor.assigneeUserId ?? ancestor.lastAssignedUserId;
      if (ancestorAssigneeAgentId) return agentMap.get(ancestorAssigneeAgentId)?.name ?? "Agent";
      if (ancestorAssigneeUserId) return compactUserLabel(ancestorAssigneeUserId, currentUserId) ?? "Board";
      return "Unassigned";
    })
    .concat(assigneeLabel)
    .join(" -> ");
  const stageAndGate = inferStageAndGate(issue, assigneeLabel);
  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const hasAttachments = attachmentList.length > 0;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
      >
        <Paperclip className="h-3.5 w-3.5 mr-1.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : "Upload attachment"}
      </Button>
    </>
  );

  return (
    <div className="max-w-2xl space-y-6">
      {/* Parent chain breadcrumb */}
      {ancestors.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {[...ancestors].reverse().map((ancestor, i) => (
            <span key={ancestor.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
              <Link
                to={`/issues/${ancestor.identifier ?? ancestor.id}`}
                state={location.state}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={ancestor.title}
              >
                {ancestor.title}
              </Link>
            </span>
          ))}
          <ChevronRight className="h-3 w-3 shrink-0" />
          <span className="text-foreground/60 truncate max-w-[200px]">{issue.title}</span>
        </nav>
      )}

      <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">From</div>
          <div className="truncate text-sm">{createdByLabel}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">To</div>
          <div className="truncate text-sm">{assigneeLabel}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Parent</div>
          <div className="truncate text-sm">{parentRef}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Flow</div>
          <div className="truncate text-sm" title={workflowChain}>{workflowChain}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Stage / Gate</div>
          <div className="flex flex-wrap gap-1 pt-0.5">
            <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", stageBadgeClass(stageAndGate.stage))}>
              {stageAndGate.stage}
            </Badge>
            {stageAndGate.gate !== "—" && (
              <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", gateBadgeClass(stageAndGate.gate))}>
                {stageAndGate.gate}
              </Badge>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Updated</div>
          <div className="truncate text-sm">{relativeTime(issue.updatedAt)}</div>
        </div>
      </div>

      {issue.hiddenAt && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <EyeOff className="h-4 w-4 shrink-0" />
          This issue is hidden
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <StatusIcon
            status={issue.status}
            onChange={(status) => updateIssue.mutate({ status })}
          />
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => updateIssue.mutate({ priority })}
          />
          <span className="text-sm font-mono text-muted-foreground shrink-0">{issue.identifier ?? issue.id.slice(0, 8)}</span>

          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {issue.projectId ? (
            <Link
              to={`/projects/${issue.projectId}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded px-1 -mx-1 py-0.5 min-w-0"
            >
              <Hexagon className="h-3 w-3 shrink-0" />
              <span className="truncate">{(projects ?? []).find((p) => p.id === issue.projectId)?.name ?? issue.projectId.slice(0, 8)}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground opacity-50 px-1 -mx-1 py-0.5">
              <Hexagon className="h-3 w-3 shrink-0" />
              No project
            </span>
          )}

          {(issue.labels ?? []).length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {(issue.labels ?? []).slice(0, 4).map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    borderColor: label.color,
                    color: label.color,
                    backgroundColor: `${label.color}1f`,
                  }}
                >
                  {label.name}
                </span>
              ))}
              {(issue.labels ?? []).length > 4 && (
                <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 4}</span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          <div className="hidden md:flex items-center md:ml-auto shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueToClipboard}
              title="Copy issue as markdown"
            >
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "shrink-0 transition-opacity duration-200",
                panelVisible ? "opacity-0 pointer-events-none w-0 overflow-hidden" : "opacity-100",
              )}
              onClick={() => setPanelVisible(true)}
              title="Show properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>

            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  updateIssue.mutate(
                    { hiddenAt: new Date().toISOString() },
                    { onSuccess: () => navigate("/issues/all") },
                  );
                  setMoreOpen(false);
                }}
              >
                <EyeOff className="h-3 w-3" />
                Hide this Issue
              </button>
            </PopoverContent>
            </Popover>
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{
          companyId: issue.companyId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={Boolean(session?.user?.id)}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : undefined}
      />

      {hasAttachments ? (
        <div
        className={cn(
          "space-y-3 rounded-lg transition-colors",
        )}
        onDragEnter={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragOver={(evt) => {
          evt.preventDefault();
          setAttachmentDragActive(true);
        }}
        onDragLeave={(evt) => {
          if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
          setAttachmentDragActive(false);
        }}
        onDrop={(evt) => void handleAttachmentDrop(evt)}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          {attachmentUploadButton}
        </div>

        {attachmentError && (
          <p className="text-xs text-destructive">{attachmentError}</p>
        )}

        <div className="space-y-2">
          {attachmentList.map((attachment) => (
            <div key={attachment.id} className="border border-border rounded-md p-2">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={attachment.contentPath}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs hover:underline truncate"
                  title={attachment.originalFilename ?? attachment.id}
                >
                  {attachment.originalFilename ?? attachment.id}
                </a>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => deleteAttachment.mutate(attachment.id)}
                  disabled={deleteAttachment.isPending}
                  title="Delete attachment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
              </p>
              {isImageAttachment(attachment) && (
                <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                  <img
                    src={attachment.contentPath}
                    alt={attachment.originalFilename ?? "attachment"}
                    className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                    loading="lazy"
                  />
                </a>
              )}
            </div>
          ))}
        </div>
        </div>
      ) : null}

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="comments" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments
          </TabsTrigger>
          <TabsTrigger value="subissues" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Sub-issues
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          {issuePluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="comments">
          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={timelineRuns}
            companyId={issue.companyId}
            projectId={issue.projectId}
            issueStatus={issue.status}
            agentMap={agentMap}
            draftKey={`paperclip:issue-comment-draft:${issue.id}`}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={currentAssigneeValue}
            mentions={mentionOptions}
            onAdd={async (body, reopen, reassignment) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                return;
              }
              await addComment.mutateAsync({ body, reopen });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            liveRunSlot={<LiveRunWidget issueId={issueId!} companyId={issue.companyId} />}
          />
        </TabsContent>

        <TabsContent value="subissues">
          {childIssues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sub-issues.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {childIssues.map((child) => (
                <Link
                  key={child.id}
                  to={`/issues/${child.identifier ?? child.id}`}
                  state={location.state}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusIcon status={child.status} />
                    <PriorityIcon priority={child.priority} />
                    <span className="font-mono text-muted-foreground shrink-0">
                      {child.identifier ?? child.id.slice(0, 8)}
                    </span>
                    <span className="truncate">{child.title}</span>
                  </div>
                  {child.assigneeAgentId && (() => {
                    const name = agentMap.get(child.assigneeAgentId)?.name;
                    return name
                      ? <Identity name={name} size="sm" />
                      : <span className="text-muted-foreground font-mono">{child.assigneeAgentId.slice(0, 8)}</span>;
                  })()}
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {!activity || activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 20).map((evt) => (
                <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActorIdentity evt={evt} agentMap={agentMap} />
                  <span>{formatAction(evt.action, evt.details)}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                companyId: issue.companyId,
                projectId: issue.projectId ?? null,
                entityId: issue.id,
                entityType: "issue",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      {issue && (
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">UX/UI Approval Gate</div>
              <div className="text-xs text-muted-foreground">
                Request approval for the design package before moving to the next workflow stage.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                requestStageApproval.mutate({
                  type: "approve_requirement_package",
                  stage: "Requirement Package",
                  summary: "Review and approve the requirement package before technical solutioning starts.",
                })
              }
              disabled={
                requestStageApproval.isPending ||
                linkedRequirementApproval?.status === "pending" ||
                linkedRequirementApproval?.status === "revision_requested"
              }
            >
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              {linkedRequirementApproval ? "Requirement Requested" : "Request Requirement Approval"}
            </Button>
          </div>
          {linkedRequirementApproval && (
            <div className="mt-2 text-xs text-muted-foreground">
              Requirement approval: <span className="font-medium">{linkedRequirementApproval.status}</span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">UX/UI Design Gate</div>
              <div className="text-xs text-muted-foreground">
                Request approval for the design package before development starts.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                requestStageApproval.mutate({
                  type: "approve_design_package",
                  stage: "UX/UI Design",
                  summary: "Review and approve the UX/UI design package before development starts.",
                })
              }
              disabled={
                requestStageApproval.isPending ||
                linkedDesignApproval?.status === "pending" ||
                linkedDesignApproval?.status === "revision_requested"
              }
            >
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              {linkedDesignApproval ? "Design Requested" : "Request UX/UI Approval"}
            </Button>
          </div>
          {linkedDesignApproval && (
            <div className="mt-2 text-xs text-muted-foreground">
              Design approval: <span className="font-medium">{linkedDesignApproval.status}</span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">QA Exit Gate</div>
              <div className="text-xs text-muted-foreground">
                Request approval for QA internal validation before UAT or go-live readiness.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                requestStageApproval.mutate({
                  type: "approve_qa_exit",
                  stage: "QA Exit",
                  summary: "Review and approve QA exit readiness before UAT or go-live.",
                })
              }
              disabled={
                requestStageApproval.isPending ||
                linkedQaExitApproval?.status === "pending" ||
                linkedQaExitApproval?.status === "revision_requested"
              }
            >
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              {linkedQaExitApproval ? "QA Exit Requested" : "Request QA Exit Approval"}
            </Button>
          </div>
          {linkedQaExitApproval && (
            <div className="mt-2 text-xs text-muted-foreground">
              QA exit approval: <span className="font-medium">{linkedQaExitApproval.status}</span>
            </div>
          )}
        </div>
      )}

      {linkedApprovals && linkedApprovals.length > 0 && (
        <Collapsible
          open={secondaryOpen.approvals}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, approvals: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">
              Linked Approvals ({linkedApprovals.length})
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border divide-y divide-border">
              {linkedApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  to={`/approvals/${approval.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="font-medium">
                      {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                  </div>
                  <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {linkedRuns && linkedRuns.length > 0 && (
        <Collapsible
          open={secondaryOpen.cost}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, cost: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">Cost Summary</span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.cost && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border px-3 py-2">
              {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                <div className="text-xs text-muted-foreground">No cost data yet.</div>
              ) : (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
                  {issueCostSummary.hasCost && (
                    <span className="font-medium text-foreground">
                      ${issueCostSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {issueCostSummary.hasTokens && (
                    <span>
                      Tokens {formatTokens(issueCostSummary.totalTokens)}
                      {issueCostSummary.cached > 0
                        ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                        : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Mobile properties drawer */}
      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
    </div>
  );
}
