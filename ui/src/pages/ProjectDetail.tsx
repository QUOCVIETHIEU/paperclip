import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike, type BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Hourglass, LoaderCircle, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { Approval } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "configuration" | "budget";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;
type ApprovalRow = { issueId: string; issueTitle: string; approval: Approval };
type StageSubstepStatus = "waiting" | "in_progress" | "done" | "pending" | "rejected";
type StageSubstep = {
  key: string;
  label: string;
  status: StageSubstepStatus;
  meta?: string | null;
  previewIssueId?: string | null;
};

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

function latestBy<T>(items: T[], getUpdatedAt: (item: T) => Date | string): T | null {
  return [...items].sort((a, b) => new Date(getUpdatedAt(b)).getTime() - new Date(getUpdatedAt(a)).getTime())[0] ?? null;
}

function substepIcon(status: StageSubstepStatus) {
  if (status === "done") return CheckCircle2;
  if (status === "in_progress") return LoaderCircle;
  if (status === "pending") return Hourglass;
  if (status === "rejected") return XCircle;
  return CircleDashed;
}

function substepIconClass(status: StageSubstepStatus) {
  if (status === "done") return "text-emerald-500";
  if (status === "in_progress") return "text-sky-500";
  if (status === "pending") return "text-amber-500";
  if (status === "rejected") return "text-red-500";
  return "text-muted-foreground";
}

function IssuePreviewDialog({
  companyId,
  issueId,
  approvalRow,
  open,
  onOpenChange,
  onApprove,
  onReject,
}: {
  companyId: string;
  issueId: string | null;
  approvalRow: ApprovalRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
}) {
  const navigate = useNavigate();
  const [showSourceContext, setShowSourceContext] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const { data: previewIssue, isLoading: isPreviewIssueLoading } = useQuery({
    queryKey: issueId ? queryKeys.issues.detail(issueId) : ["issue-preview", "idle"],
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId && open,
  });

  const { data: previewParentIssue, isLoading: isPreviewParentIssueLoading } = useQuery({
    queryKey: previewIssue?.parentId ? queryKeys.issues.detail(previewIssue.parentId) : ["issue-preview-parent", "idle"],
    queryFn: () => issuesApi.get(previewIssue!.parentId!),
    enabled: !!previewIssue?.parentId && open,
  });

  const { data: previewComments, isLoading: isPreviewCommentsLoading } = useQuery({
    queryKey: issueId ? queryKeys.issues.comments(issueId) : ["issue-preview-comments", "idle"],
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId && open,
  });

  const latestMeaningfulComments = useMemo(() => {
    return (previewComments ?? [])
      .filter((comment) => comment.body.trim().length > 0)
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 3);
  }, [previewComments]);

  const previewApprovalRequesterLabel = useMemo(() => {
    if (!approvalRow) return null;
    if (approvalRow.approval.requestedByAgentId) {
      return agentNameById.get(approvalRow.approval.requestedByAgentId) ?? "Agent";
    }
    if (approvalRow.approval.requestedByUserId) {
      return "Board";
    }
    return null;
  }, [agentNameById, approvalRow]);

  const previewApprovalRecipientLabel = useMemo(() => {
    if (!approvalRow) return null;
    const requestedFor = approvalRow.approval.payload?.["requestedFor"];
    return typeof requestedFor === "string" && requestedFor.trim().length > 0
      ? requestedFor.trim()
      : null;
  }, [approvalRow]);

  const actionable =
    approvalRow &&
    (approvalRow.approval.status === "pending" || approvalRow.approval.status === "revision_requested");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setShowSourceContext(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="!w-[min(67vw,72rem)] !max-w-[min(67vw,72rem)] sm:!max-w-[min(67vw,72rem)]">
        <DialogHeader>
          <DialogTitle>{previewIssue?.title ?? "Issue Preview"}</DialogTitle>
          <DialogDescription>
            {approvalRow
              ? "Review kết quả của BA trước khi quyết định approval."
              : "Xem nhanh kết quả đầu ra của stage đã hoàn tất."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-2">
          <div className="grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-4 md:grid-cols-5">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Issue</div>
              <div className="mt-1 text-sm font-medium">{previewIssue?.identifier ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">From</div>
              <div className="mt-1 text-sm font-medium">
                {previewApprovalRequesterLabel ??
                  (previewIssue
                    ? actorLabel(previewIssue.createdByAgentId, previewIssue.createdByUserId, agentNameById)
                    : "—")}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">To</div>
              <div className="mt-1 text-sm font-medium">
                {previewApprovalRecipientLabel ??
                  (previewIssue
                    ? actorLabel(
                      resolveIssueRecipientAgentId(previewIssue),
                      resolveIssueRecipientUserId(previewIssue),
                      agentNameById,
                    )
                    : "—")}
              </div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Status</div>
              <div className="mt-1 text-sm font-medium">{previewIssue?.status ?? "—"}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Updated</div>
              <div className="mt-1 text-sm font-medium">
                {previewIssue ? `${formatDate(previewIssue.updatedAt)} • ${timeAgo(previewIssue.updatedAt)}` : "—"}
              </div>
            </div>
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">
                {approvalRow ? "Kết quả BA gửi để PM review" : "Kết quả đầu ra của giai đoạn"}
              </div>
              {issueId ? (
                <Button variant="outline" size="sm" onClick={() => navigate(`/issues/${issueId}`)}>
                  Open Full Issue
                </Button>
              ) : null}
            </div>
            <div className="space-y-3">
              {isPreviewCommentsLoading ? (
                <div className="rounded-lg border border-border/70 bg-background p-4 text-sm text-muted-foreground">
                  Đang tải comments...
                </div>
              ) : latestMeaningfulComments.length > 0 ? (
                latestMeaningfulComments.map((comment) => (
                  <div key={comment.id} className="rounded-lg border border-border/70 bg-background p-4">
                    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {comment.authorAgentId
                          ? (agentNameById.get(comment.authorAgentId) ?? "Agent")
                          : comment.authorUserId
                            ? "Board"
                            : "Unknown"}
                      </span>
                      <span>{formatDate(comment.createdAt)}</span>
                      <span>{timeAgo(comment.createdAt)}</span>
                    </div>
                    <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      {comment.body}
                    </MarkdownBody>
                  </div>
                ))
              ) : previewIssue?.description?.trim() ? (
                <div className="rounded-lg border border-border/70 bg-background p-4">
                  <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    {previewIssue.description}
                  </MarkdownBody>
                </div>
              ) : (
                <div className="rounded-lg border border-border/70 bg-background p-4 text-sm text-muted-foreground">
                  Chưa có nội dung nào để preview.
                </div>
              )}
            </div>
          </section>

          <Collapsible open={showSourceContext} onOpenChange={setShowSourceContext}>
            <div className="rounded-lg border border-border/70 bg-muted/20">
              <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left">
                <div>
                  <div className="text-sm font-semibold">Yêu cầu gốc từ PM</div>
                  <div className="text-xs text-muted-foreground">
                    Mở rộng khi cần xem lại bối cảnh giao việc ban đầu.
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    showSourceContext && "rotate-180",
                  )}
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="border-t border-border/70 bg-background p-4">
                  {isPreviewParentIssueLoading ? (
                    <p className="text-sm text-muted-foreground">Đang tải nội dung issue...</p>
                  ) : previewParentIssue ? (
                    <div className="space-y-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                          Issue PM
                        </div>
                        <div className="mt-1 text-sm font-medium">
                          {previewParentIssue.identifier ?? "—"} · {previewParentIssue.title}
                        </div>
                      </div>
                      {previewParentIssue.description?.trim() ? (
                        <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                          {previewParentIssue.description}
                        </MarkdownBody>
                      ) : (
                        <p className="text-sm text-muted-foreground">Issue PM này chưa có phần mô tả.</p>
                      )}
                    </div>
                  ) : isPreviewIssueLoading ? (
                    <p className="text-sm text-muted-foreground">Đang tải nội dung issue...</p>
                  ) : previewIssue?.description?.trim() ? (
                    <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      {previewIssue.description}
                    </MarkdownBody>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Chưa tìm thấy issue gốc của PM hoặc issue đó chưa có phần mô tả.
                    </p>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </div>
        <DialogFooter className="border-t border-border/70 pt-4">
          <div className="flex w-full items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {approvalRow ? (
                <>
                  {approvalTypeLabel(approvalRow.approval.type)} · {approvalStatusLabel(approvalRow.approval.status)}
                </>
              ) : (
                "Review issue content and output from this completed stage."
              )}
            </div>
            <div className="flex items-center gap-2">
              {actionable && approvalRow && onApprove && onReject ? (
                <>
                  <Button
                    size="sm"
                    className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
                    onClick={() => onApprove(approvalRow.approval.id)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-8 px-3"
                    onClick={() => onReject(approvalRow.approval.id)}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

function approvalStatusLabel(status: Approval["status"]) {
  return status.replaceAll("_", " ");
}

function approvalStatusBadgeClass(status: Approval["status"]) {
  if (status === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "pending") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "revision_requested") return "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300";
  if (status === "rejected") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  return "border-border bg-muted text-muted-foreground";
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
  const titleText = issue.title.toLowerCase();
  const detailText = `${issue.title}\n${issue.description ?? ""}`.toLowerCase();

  if (/(hypercare|handover|service desk|takeover)/.test(titleText)) return "handover";
  if (/(uat|go-live|golive|go live|release readiness)/.test(titleText)) return "uat";
  if (/(ux\/ui|ui\/ux|wireframe|prototype|design|thiết kế|thiet ke|ux flow|ui flow|ui structure)/.test(titleText)) {
    return "design";
  }
  if (/(qa|test|regression|validation|kiểm thử|kiem thu|qa exit)/.test(titleText)) return "qa";
  if (
    /(technical solution|solutioning|kế hoạch kỹ thuật|technical planning|module breakdown|dependencies|technical risk|dev approach|kiến trúc|giải pháp kỹ thuật)/.test(
      titleText,
    )
  ) {
    return "solutioning";
  }
  if (/(requirement|yêu cầu|yeu cau|scope|business|actor|user flow|acceptance|requirement package)/.test(titleText)) {
    return "requirement";
  }
  if (
    /(development|coding|implementation|code review|build ready|deploy|fix bug|bugfix|hotfix|release readiness|triển khai|phát triển|lập trình|sửa lỗi)/.test(
      titleText,
    )
  ) {
    return "development";
  }

  if (role.includes("CTO")) return "intake";
  if (role.includes("BA")) return "requirement";
  if (role.includes("DESIGNER")) return "design";
  if (role.includes("QA")) return "qa";
  if (role.includes("SD")) return "handover";
  if (role.includes("FE") || role.includes("BE") || role.includes("INTEGRATION") || role.includes("DEVOPS")) return "development";
  if (role.includes("TECH LEAD")) {
    return "solutioning";
  }
  if (role.includes("PM")) {
    if (/(hypercare|handover|service desk|takeover)/.test(detailText)) return "handover";
    if (/(uat|go-live|golive|go live|release readiness)/.test(detailText) && !/(requirement|yêu cầu|yeu cau|scope|business|actor|user flow|acceptance)/.test(titleText)) return "uat";
    return "requirement";
  }
  return null;
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
  const [previewIssueId, setPreviewIssueId] = useState<string | null>(null);
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
    const rows: ApprovalRow[] = [];
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
          approvals: [] as typeof approvalsByIssue,
        },
      ]),
    );

    for (const issue of projectIssues ?? []) {
      const assigneeName = actorLabel(resolveIssueRecipientAgentId(issue), resolveIssueRecipientUserId(issue), agentNameById);
      const stageKey = inferTimelineStageKey(issue, assigneeName);
      if (!stageKey) continue;
      stageMap.get(stageKey)?.issues.push(issue);
    }

    // Defensive rebucketing: TECH LEAD solutioning issues can be misread as
    // development later in the flow because their descriptions mention downstream
    // dev work. Keep title-first intent and move them back to stage 3.
    const solutioningTitlePattern =
      /(technical solution|solutioning|kế hoạch kỹ thuật|technical planning|module breakdown|dependencies|technical risk|dev approach|kiến trúc|giải pháp kỹ thuật)/;
    const developmentTitlePattern =
      /(development|coding|implementation|code review|build ready|deploy|fix bug|bugfix|hotfix|release readiness|triển khai|phát triển|lập trình|sửa lỗi)/;
    const developmentBucket = stageMap.get("development");
    const solutioningBucket = stageMap.get("solutioning");
    if (developmentBucket && solutioningBucket) {
      const misbucketedSolutioningIssues = developmentBucket.issues.filter((issue) => {
        const titleText = issue.title.toLowerCase();
        return solutioningTitlePattern.test(titleText) && !developmentTitlePattern.test(titleText);
      });
      if (misbucketedSolutioningIssues.length > 0) {
        developmentBucket.issues = developmentBucket.issues.filter(
          (issue) => !misbucketedSolutioningIssues.some((candidate) => candidate.id === issue.id),
        );
        solutioningBucket.issues.push(...misbucketedSolutioningIssues);
      }
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
      stageMap.get(stageKey)?.approvals.push(item);
    }

    for (const item of approvalsByIssue) {
      const stageKey =
        item.approval.type === "approve_requirement_package"
          ? "requirement"
          : item.approval.type === "approve_design_package"
            ? "design"
            : item.approval.type === "approve_qa_exit"
              ? "qa"
              : null;
      if (!stageKey) continue;
      if (!stageMap.get(stageKey)?.approvals.some((row) => row.approval.id === item.approval.id)) {
        stageMap.get(stageKey)?.approvals.push(item);
      }
    }

    const buckets = DELIVERY_TIMELINE.map((stage) => {
      const bucket = stageMap.get(stage.key)!;
      const openStageIssues = bucket.issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
      const latestIssue = latestBy(bucket.issues, (issue) => issue.updatedAt);
      const latestAssignee = latestIssue
        ? actorLabel(resolveIssueRecipientAgentId(latestIssue), resolveIssueRecipientUserId(latestIssue), agentNameById)
        : null;
      const pending =
        latestBy(
          bucket.approvals.filter(
            (row) => row.approval.status === "pending" || row.approval.status === "revision_requested",
          ),
          (row) => row.approval.updatedAt,
        ) ?? null;
      const latestApproval = latestBy(bucket.approvals, (row) => row.approval.updatedAt);
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

      return {
        stage,
        bucket,
        openStageIssues,
        latestIssue,
        latestAssignee,
        pending,
        latestApproval,
        waitingForOperatorApprovalRequest,
        hasBlocked: bucket.issues.some((issue) => issue.status === "blocked"),
        hasActivity: bucket.issues.length > 0 || bucket.approvals.length > 0,
      };
    });

    const currentIndex = buckets.reduce((acc, entry, index) => {
      if (
        entry.pending ||
        entry.waitingForOperatorApprovalRequest ||
        entry.hasBlocked ||
        entry.openStageIssues.length > 0
      ) {
        return index;
      }
      return acc;
    }, -1);

    const lastActivityIndex = buckets.reduce((acc, entry, index) => (entry.hasActivity ? index : acc), -1);

    return buckets.map(({ stage, bucket, openStageIssues, latestIssue, latestAssignee, pending, latestApproval, waitingForOperatorApprovalRequest, hasBlocked, hasActivity }, index) => {
      let state: "completed" | "in_progress" | "pending_approval" | "operator_action" | "blocked" | "upcoming" = "upcoming";
      if (index === currentIndex && pending) {
        state = "pending_approval";
      } else if (index === currentIndex && waitingForOperatorApprovalRequest) {
        state = "operator_action";
      } else if (index === currentIndex && hasBlocked) {
        state = "blocked";
      } else if (index === currentIndex && (openStageIssues.length > 0 || bucket.issues.length > 0)) {
        state = "in_progress";
      } else if (currentIndex >= 0 && index < currentIndex && hasActivity) {
        state = "completed";
      } else if (currentIndex === -1 && lastActivityIndex >= 0 && index <= lastActivityIndex && hasActivity) {
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

      let substeps: StageSubstep[] = [];
      if (stage.key === "requirement") {
        const pmIssue = latestBy(
          bucket.issues.filter((issue) =>
            actorLabel(resolveIssueRecipientAgentId(issue), resolveIssueRecipientUserId(issue), agentNameById)
              .toUpperCase()
              .includes("PM"),
          ),
          (issue) => issue.updatedAt,
        );
        const baIssue = latestBy(
          bucket.issues.filter((issue) =>
            actorLabel(resolveIssueRecipientAgentId(issue), resolveIssueRecipientUserId(issue), agentNameById)
              .toUpperCase()
              .includes("BA"),
          ),
          (issue) => issue.updatedAt,
        );
        const requirementApproval = latestApproval;
        substeps = [
          {
            key: "pm-handoff-to-ba",
            label: "PM nhận task từ CTO và giao việc cho BA",
            status: baIssue || pmIssue?.status === "done" ? "done" : pmIssue ? "in_progress" : "waiting",
            meta: pmIssue ? pmIssue.title : "Chưa có issue PM/BA",
            previewIssueId: pmIssue?.id ?? null,
          },
          {
            key: "ba-build-package",
            label: "BA xây dựng requirement package và gửi PM review",
            status: requirementApproval || baIssue?.status === "in_review" || baIssue?.status === "done"
              ? "done"
              : baIssue
                ? "in_progress"
                : "waiting",
            meta: baIssue ? baIssue.title : "Chưa có issue BA",
            previewIssueId: baIssue?.id ?? null,
          },
          {
            key: "pm-requirement-approval",
            label: "PM review Requirement Package",
            status:
              requirementApproval?.approval.status === "approved"
                ? "done"
                : requirementApproval?.approval.status === "rejected"
                  ? "rejected"
                : requirementApproval?.approval.status === "pending" || requirementApproval?.approval.status === "revision_requested"
                  ? "pending"
                  : "waiting",
            meta: requirementApproval ? approvalStatusLabel(requirementApproval.approval.status) : "Chưa có approval",
            previewIssueId:
              requirementApproval?.approval.status === "approved" ? requirementApproval.issueId : null,
          },
        ];
      } else if (stage.key === "solutioning") {
        const techLeadIssue = latestBy(bucket.issues, (issue) => issue.updatedAt);
        const designerIssue = latestBy(stageMap.get("design")?.issues ?? [], (issue) => issue.updatedAt);
        const designerIssueExists = Boolean(designerIssue);
        const solutioningHandedOff = Boolean(
          techLeadIssue &&
            (techLeadIssue.status === "done" ||
              techLeadIssue.status === "in_review" ||
              designerIssueExists),
        );
        substeps = [
          {
            key: "pm-handoff-to-tech-lead",
            label: "PM handoff requirement package đã approve cho TECH LEAD",
            status: techLeadIssue ? "done" : "waiting",
            meta: techLeadIssue ? techLeadIssue.title : "Chưa có issue TECH LEAD",
            previewIssueId: techLeadIssue?.id ?? null,
          },
          {
            key: "tech-lead-solutioning",
            label: "TECH LEAD xây technical solution và technical planning",
            status:
              solutioningHandedOff
                ? "done"
                : techLeadIssue
                ? "in_progress"
                : "waiting",
            meta: techLeadIssue ? techLeadIssue.title : null,
            previewIssueId: solutioningHandedOff ? techLeadIssue?.id ?? null : null,
          },
          {
            key: "tech-lead-design-brief",
            label: "TECH LEAD giao designer để thiết kế UX/UI",
            status: designerIssueExists ? "done" : techLeadIssue ? "in_progress" : "waiting",
            meta: designerIssueExists ? "Đã sinh task design" : "Chưa giao task design",
            previewIssueId: designerIssue?.id ?? null,
          },
        ];
      } else if (stage.key === "design") {
        const designIssue = latestBy(bucket.issues, (issue) => issue.updatedAt);
        const designApproval = latestApproval;
        substeps = [
          {
            key: "tech-lead-assign-designer",
            label: "TECH LEAD giao task UX/UI cho DESIGNER",
            status: designIssue ? "done" : "waiting",
            meta: designIssue ? designIssue.title : "Chưa có issue design",
            previewIssueId: designIssue?.id ?? null,
          },
          {
            key: "designer-package",
            label: "DESIGNER hoàn tất design package",
            status: designApproval || designIssue?.status === "in_review" || designIssue?.status === "done"
              ? "done"
              : designIssue
                ? "in_progress"
                : "waiting",
            meta: designIssue ? designIssue.title : null,
            previewIssueId: designIssue?.id ?? null,
          },
          {
            key: "design-approval",
            label: "PM / TECH LEAD review UX/UI approval",
            status:
              designApproval?.approval.status === "approved"
                ? "done"
                : designApproval?.approval.status === "rejected"
                  ? "rejected"
                : designApproval?.approval.status === "pending" || designApproval?.approval.status === "revision_requested"
                  ? "pending"
                  : "waiting",
            meta: designApproval ? approvalStatusLabel(designApproval.approval.status) : "Chưa có approval",
            previewIssueId: designApproval?.approval.status === "approved" ? designApproval.issueId : null,
          },
        ];
      }

      return {
        ...stage,
        state,
        latestIssue,
        latestAssignee,
        pendingApproval: pending,
        waitingForOperatorApprovalRequest,
        detail,
        substeps,
      };
    });
  }, [agentNameById, approvalsByIssue, pendingApprovals, projectIssues]);

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
          <div className="absolute left-[132px] top-0 bottom-0 w-px -translate-x-1/2 bg-border/80" />
          {timelineStages.map((stage, index) => (
            <div key={stage.key} className="relative grid grid-cols-[104px_24px_minmax(0,1fr)] gap-4 pb-6 last:pb-0">
              <div className="min-w-0 text-right">
                <div className="text-lg font-semibold leading-none text-foreground">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 break-words text-[11px] uppercase leading-4 tracking-[0.12em] text-muted-foreground">
                  {stage.owner}
                </div>
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
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <p className="text-[11px] text-muted-foreground">
                    {stage.pendingApproval
                      ? `Updated ${timeAgo(stage.pendingApproval.approval.updatedAt)}`
                      : stage.latestIssue
                        ? `Updated ${timeAgo(stage.latestIssue.updatedAt)}`
                        : "Chưa có hoạt động nào"}
                  </p>
                  {stage.state === "completed" && stage.latestIssue ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() => setPreviewIssueId(stage.latestIssue!.id)}
                    >
                      Xem kết quả
                    </Button>
                  ) : null}
                </div>
                {stage.substeps?.length ? (
                  <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      Workflow Steps
                    </p>
                    <div className="space-y-2">
                      {stage.substeps.map((step) => {
                        const Icon = substepIcon(step.status);
                        return (
                          <div key={step.key} className="flex items-start gap-2">
                            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", substepIconClass(step.status), step.status === "in_progress" ? "animate-spin" : "")} />
                            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-xs font-medium text-foreground">{step.label}</div>
                                {step.meta ? (
                                  <div className="text-[11px] text-muted-foreground">{step.meta}</div>
                                ) : null}
                              </div>
                              {step.previewIssueId ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 shrink-0 px-2 text-[10px]"
                                  onClick={() => setPreviewIssueId(step.previewIssueId!)}
                                >
                                  Xem kết quả
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <IssuePreviewDialog
        companyId={companyId}
        issueId={previewIssueId}
        approvalRow={null}
        open={Boolean(previewIssueId)}
        onOpenChange={(open) => {
          if (!open) setPreviewIssueId(null);
        }}
      />
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
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${color === currentColor
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

function ProjectIssuesList({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [previewIssueId, setPreviewIssueId] = useState<string | null>(null);
  const [previewApprovalId, setPreviewApprovalId] = useState<string | null>(null);

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

  const issueApprovalQueries = useQueries({
    queries: (issues ?? []).map((issue) => ({
      queryKey: queryKeys.issues.approvals(issue.id),
      queryFn: () => issuesApi.listApprovals(issue.id),
      enabled: !!companyId,
    })),
  });

  const projectApprovals = useMemo(() => {
    const rows: ApprovalRow[] = [];
    for (let index = 0; index < (issues ?? []).length; index += 1) {
      const issue = issues?.[index];
      if (!issue) continue;
      for (const approval of issueApprovalQueries[index]?.data ?? []) {
        rows.push({
          issueId: issue.id,
          issueTitle: issue.title,
          approval,
        });
      }
    }

    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.approval.id)) return false;
        seen.add(row.approval.id);
        return true;
      })
      .sort((a, b) => {
        const statusRank = (status: Approval["status"]) => {
          if (status === "pending") return 0;
          if (status === "revision_requested") return 1;
          if (status === "rejected") return 2;
          if (status === "approved") return 3;
          return 4;
        };
        return (
          statusRank(a.approval.status) - statusRank(b.approval.status) ||
          new Date(b.approval.updatedAt).getTime() - new Date(a.approval.updatedAt).getTime()
        );
      });
  }, [issueApprovalQueries, issues]);

  const agentNameById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const previewApprovalRow = useMemo(() => {
    if (!previewApprovalId) return null;
    return projectApprovals.find((row) => row.approval.id === previewApprovalId) ?? null;
  }, [previewApprovalId, projectApprovals]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  const approveApproval = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      for (const issue of issues ?? []) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issue.id) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
  });

  const rejectApproval = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      for (const issue of issues ?? []) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issue.id) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
  });

  return (
    <div className="space-y-3">
      {projectApprovals.length > 0 ? (
        <>
          <div className="rounded-xl border border-border/70 bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">Project Approvals</h3>
                <p className="text-xs text-muted-foreground">
                  Theo dõi approvals liên kết với các issue của dự án.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {projectApprovals.length} approval{projectApprovals.length === 1 ? "" : "s"}
              </span>
            </div>

            <div className="divide-y divide-border">
              {projectApprovals.map(({ issueId, issueTitle, approval }) => {
                const requesterName = approval.requestedByAgentId
                  ? (agentNameById.get(approval.requestedByAgentId) ?? "Agent")
                  : "Board";
                const actionable = approval.status === "pending" || approval.status === "revision_requested";

                return (
                  <div key={approval.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{approvalTypeLabel(approval.type)}</span>
                        <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize", approvalStatusBadgeClass(approval.status))}>
                          {approvalStatusLabel(approval.status)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Issue: <span className="text-foreground">{issueTitle}</span>
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>requested by {requesterName}</span>
                        <span>updated {timeAgo(approval.updatedAt)}</span>
                        <span className="font-mono">{approval.id.slice(0, 8)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-3"
                        onClick={() => {
                          setPreviewIssueId(issueId);
                          setPreviewApprovalId(approval.id);
                        }}
                      >
                        View Issue
                      </Button>
                      {actionable ? (
                        <>
                          <Button
                            size="sm"
                            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
                            onClick={() => approveApproval.mutate(approval.id)}
                            disabled={approveApproval.isPending || rejectApproval.isPending}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-8 px-3"
                            onClick={() => rejectApproval.mutate(approval.id)}
                            disabled={approveApproval.isPending || rejectApproval.isPending}
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <IssuePreviewDialog
            companyId={companyId}
            issueId={previewIssueId}
            approvalRow={previewApprovalRow}
            open={Boolean(previewIssueId)}
            onOpenChange={(open) => {
              if (!open) {
                setPreviewIssueId(null);
                setPreviewApprovalId(null);
              }
            }}
            onApprove={(approvalId) =>
              approveApproval.mutate(approvalId, {
                onSuccess: () => {
                  setPreviewIssueId(null);
                  setPreviewApprovalId(null);
                },
              })
            }
            onReject={(approvalId) =>
              rejectApproval.mutate(approvalId, {
                onSuccess: () => {
                  setPreviewIssueId(null);
                  setPreviewApprovalId(null);
                },
              })
            }
          />
        </>
      ) : null}

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
    </div>
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
  const isDev = import.meta.env.DEV;
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

  const cleanProjectIssues = useMutation({
    mutationFn: () => {
      if (!resolvedCompanyId || !project?.id) {
        throw new Error("Project context is not ready");
      }
      return issuesApi.cleanProject(resolvedCompanyId, project.id);
    },
    onSuccess: (result) => {
      if (resolvedCompanyId && project?.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(resolvedCompanyId, project.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(resolvedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(resolvedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      }
      pushToast({
        title: "Project issues cleaned",
        body: result.removedIssueCount > 0
          ? `Removed ${result.removedIssueCount} issues from this project.`
          : "No project issues to remove.",
        tone: "success",
      });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch { }
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
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch { }
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
      <div className="flex items-start justify-between gap-4">
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

      <div className="flex items-start justify-between gap-4">
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
        {isDev && activeTab === "list" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-0.5 shrink-0 text-destructive hover:text-destructive"
            disabled={cleanProjectIssues.isPending}
            onClick={() => {
              const confirmed = window.confirm(
                "Clean all issues in this project? This also removes linked issue approvals, comments, and inbox read-state data for those project issues. Dev-only reset.",
              );
              if (!confirmed) return;
              cleanProjectIssues.mutate();
            }}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {cleanProjectIssues.isPending ? "Cleaning…" : "Clean Issues"}
          </Button>
        ) : null}
      </div>

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
        <ProjectIssuesList
          projectId={project.id}
          companyId={resolvedCompanyId}
        />
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
