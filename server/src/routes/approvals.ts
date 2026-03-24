import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  agentService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function firstMeaningfulLine(value: string | null | undefined) {
  if (!value) return null;
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function summarizeCommentBody(value: string | null | undefined, maxLength = 280) {
  const line = firstMeaningfulLine(value);
  if (!line) return null;
  if (line.length <= maxLength) return line;
  return `${line.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function approvalGateMeta(type: string) {
  if (type === "approve_requirement_package") {
    return {
      label: "Requirement Package Approval",
      approvedStatus: "done" as const,
      revisionStatus: "todo" as const,
      rejectedStatus: "blocked" as const,
    };
  }
  if (type === "approve_design_package") {
    return {
      label: "UX/UI Design Approval",
      approvedStatus: "done" as const,
      revisionStatus: "todo" as const,
      rejectedStatus: "blocked" as const,
    };
  }
  if (type === "approve_qa_exit") {
    return {
      label: "QA Exit Approval",
      approvedStatus: "done" as const,
      revisionStatus: "todo" as const,
      rejectedStatus: "blocked" as const,
    };
  }
  return null;
}

function normalizeComparableAgentName(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function requestedForCandidates(value: unknown) {
  if (typeof value !== "string") return [];
  return value
    .split(/->|[+,/&]/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractProjectSubjectFromTitle(title: string | null | undefined) {
  if (!title) return null;
  const match = title.match(/cho dự án\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function buildTechLeadHandoffTitle(sourceTitle: string | null | undefined) {
  const subject = extractProjectSubjectFromTitle(sourceTitle);
  if (subject) {
    return `Xây dựng technical solution và kế hoạch kỹ thuật cho dự án ${subject}`;
  }
  return "Xây dựng technical solution và kế hoạch kỹ thuật từ Requirement Package đã approved";
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function applyLinkedIssueApprovalOutcome(
    approval: Awaited<ReturnType<typeof svc.getById>>,
    outcome: "approved" | "revision_requested" | "rejected",
  ) {
    if (!approval) return;
    const gate = approvalGateMeta(approval.type);
    if (!gate) return;

    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const nextStatus =
      outcome === "approved"
        ? gate.approvedStatus
        : outcome === "revision_requested"
          ? gate.revisionStatus
          : gate.rejectedStatus;
    const note =
      outcome === "approved"
        ? `${gate.label} approved in ${approval.id.slice(0, 8)}.`
        : outcome === "revision_requested"
          ? `${gate.label} requested revision in ${approval.id.slice(0, 8)}. Issue moved back to todo.`
          : `${gate.label} rejected in ${approval.id.slice(0, 8)}. Issue moved to blocked.`;

    for (const issue of linkedIssues) {
      await issuesSvc.update(issue.id, { status: nextStatus });
      await issuesSvc.addComment(issue.id, note, {});

      if (outcome === "approved" && issue.parentId) {
        const [parentIssue, latestComment] = await Promise.all([
          issuesSvc.getById(issue.parentId),
          issuesSvc.listComments(issue.id, { order: "desc", limit: 1 }).then((rows) => rows[0] ?? null),
        ]);
        if (parentIssue) {
          const summary = summarizeCommentBody(latestComment?.body);
          const issueRef = issue.identifier ?? issue.id;
          await issuesSvc.addComment(
            parentIssue.id,
            [
              `Sub-issue approved: ${issueRef} - ${issue.title}`,
              `Approval: ${gate.label} (${approval.id.slice(0, 8)})`,
              summary ? `Summary: ${summary}` : "Summary: Design issue approved and ready for the next workflow stage.",
              `Open sub-issue: /issues/${issueRef}`,
            ].join("\n"),
            {},
          );
        }
      }

    }
  }

  async function resolveApprovalResumeContext(
    approval: Awaited<ReturnType<typeof svc.getById>>,
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>,
  ) {
    const primaryLinkedIssue = linkedIssues[0] ?? null;
    if (!primaryLinkedIssue) {
      return {
        resumeIssue: null,
        wakeAgentId: approval?.requestedByAgentId ?? null,
      };
    }

    const primaryIssue = await issuesSvc.getById(primaryLinkedIssue.id);
    const resumeIssue =
      primaryIssue?.parentId ? await issuesSvc.getById(primaryIssue.parentId) : primaryIssue;
    const resumeOwnerAgentId =
      resumeIssue?.assigneeAgentId ??
      resumeIssue?.lastAssignedAgentId ??
      null;

    if (resumeOwnerAgentId) {
      return {
        resumeIssue,
        wakeAgentId: resumeOwnerAgentId,
      };
    }

    const candidateNames = requestedForCandidates(approval?.payload?.requestedFor);
    if (candidateNames.length === 0) {
      return {
        resumeIssue,
        wakeAgentId: approval?.requestedByAgentId ?? null,
      };
    }

    const availableAgents = await agentsSvc.list(approval.companyId);
    const availableAgentsByName = new Map(
      availableAgents.map((agent) => [normalizeComparableAgentName(agent.name), agent]),
    );

    for (const candidate of candidateNames) {
      const matched = availableAgentsByName.get(normalizeComparableAgentName(candidate));
      if (matched) {
        return {
          resumeIssue,
          wakeAgentId: matched.id,
        };
      }
    }

    return {
      resumeIssue,
      wakeAgentId: approval?.requestedByAgentId ?? null,
    };
  }

  async function resolveTechLeadAgent(companyId: string, preferredManagerId: string | null) {
    const availableAgents = (await agentsSvc.list(companyId)).filter((agent) => agent.status !== "terminated");
    const scored = availableAgents
      .map((agent) => {
        let score = 0;
        if (preferredManagerId && agent.reportsTo === preferredManagerId) score += 100;

        const title = normalizeComparableAgentName(agent.title);
        const name = normalizeComparableAgentName(agent.name);
        const capabilities = normalizeComparableAgentName(agent.capabilities);

        if (title.includes("tech lead") || title.includes("technical lead")) score += 80;
        if (name.includes("tech lead") || name.includes("technical lead")) score += 70;
        if (capabilities.includes("technical solution")) score += 20;
        if (capabilities.includes("module breakdown")) score += 10;

        return { agent, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    return scored[0]?.agent ?? null;
  }

  async function automateRequirementApprovalHandoff(input: {
    approval: Awaited<ReturnType<typeof svc.getById>>;
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>;
    resumeIssue: Awaited<ReturnType<typeof issuesSvc.getById>>;
    coordinatorAgentId: string | null;
    requestedByUserId: string;
  }) {
    const { approval, linkedIssues, resumeIssue, coordinatorAgentId, requestedByUserId } = input;
    if (approval.type !== "approve_requirement_package" || !resumeIssue) {
      return { handled: false as const, techLeadIssueId: null as string | null, wakeRunId: null as string | null };
    }

    const requirementIssue = linkedIssues[0] ? await issuesSvc.getById(linkedIssues[0].id) : null;
    const techLeadAgent = await resolveTechLeadAgent(approval.companyId, coordinatorAgentId);
    if (!techLeadAgent) {
      return { handled: false as const, techLeadIssueId: null as string | null, wakeRunId: null as string | null };
    }

    const siblingIssues = await issuesSvc.list(approval.companyId, { parentId: resumeIssue.id });
    const existingTechLeadIssue =
      siblingIssues.find(
        (issue) =>
          issue.assigneeAgentId === techLeadAgent.id &&
          issue.status !== "done" &&
          issue.status !== "cancelled",
      ) ?? null;

    const latestRequirementComment = requirementIssue
      ? await issuesSvc.listComments(requirementIssue.id, { order: "desc", limit: 1 }).then((rows) => rows[0] ?? null)
      : null;
    const requirementSummary = summarizeCommentBody(latestRequirementComment?.body, 400);

    const techLeadIssue =
      existingTechLeadIssue ??
      (await issuesSvc.create(approval.companyId, {
        projectId: resumeIssue.projectId,
        projectWorkspaceId: resumeIssue.projectWorkspaceId,
        goalId: resumeIssue.goalId,
        parentId: resumeIssue.id,
        title: buildTechLeadHandoffTitle(requirementIssue?.title ?? resumeIssue.title),
        description: [
          "Requirement Package đã được approve và sẵn sàng bàn giao sang TECH LEAD.",
          requirementIssue
            ? `Nguồn requirement: ${requirementIssue.identifier ?? requirementIssue.id} - ${requirementIssue.title}`
            : null,
          `Issue điều phối: ${resumeIssue.identifier ?? resumeIssue.id} - ${resumeIssue.title}`,
          requirementSummary ? `Tóm tắt đầu ra BA: ${requirementSummary}` : null,
          "",
          "Mục tiêu bước tiếp theo:",
          "- Xây dựng Technical Solution",
          "- Xác định Module Breakdown",
          "- Làm rõ Technical Dependencies",
          "- Xác định Technical Risks",
          "- Đề xuất Dev Approach",
        ]
          .filter(Boolean)
          .join("\n"),
        status: "todo",
        priority: resumeIssue.priority,
        assigneeAgentId: techLeadAgent.id,
        requestDepth: resumeIssue.requestDepth + 1,
        createdByAgentId: coordinatorAgentId,
      }));

    if (!existingTechLeadIssue) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: requestedByUserId,
        agentId: coordinatorAgentId,
        action: "issue.created",
        entityType: "issue",
        entityId: techLeadIssue.id,
        details: {
          identifier: techLeadIssue.identifier,
          title: techLeadIssue.title,
          sourceApprovalId: approval.id,
        },
      });
    }

    const coordinatorComment = await issuesSvc.addComment(
      resumeIssue.id,
      [
        `Requirement Package đã được approve qua gate ${approval.id.slice(0, 8)}.`,
        `Đã bàn giao tiếp sang TECH LEAD: ${techLeadIssue.identifier ?? techLeadIssue.id} - ${techLeadIssue.title}.`,
      ].join("\n"),
      {},
    );
    await issuesSvc.update(resumeIssue.id, { status: "done" });

    const techLeadComment = await issuesSvc.addComment(
      techLeadIssue.id,
      [
        "Requirement Package đã được PM review và approve.",
        requirementIssue
          ? `Nguồn requirement: ${requirementIssue.identifier ?? requirementIssue.id} - ${requirementIssue.title}`
          : null,
        `Hãy bắt đầu bước Solutioning & Technical Planning từ issue điều phối ${resumeIssue.identifier ?? resumeIssue.id}.`,
      ]
        .filter(Boolean)
        .join("\n"),
      {},
    );

    const wakeRun = await heartbeat.wakeup(techLeadAgent.id, {
      source: "automation",
      triggerDetail: "system",
      reason: "requirement_approval_handoff",
      payload: {
        issueId: techLeadIssue.id,
        mutation: "approval_handoff",
        approvalId: approval.id,
        commentId: techLeadComment.id,
      },
      requestedByActorType: "user",
      requestedByActorId: requestedByUserId,
      contextSnapshot: {
        source: "approval.approved.requirement_handoff",
        approvalId: approval.id,
        issueId: techLeadIssue.id,
        taskId: techLeadIssue.id,
        wakeReason: "requirement_approval_handoff",
        wakeCommentId: techLeadComment.id,
      },
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: requestedByUserId,
      action: "approval.requirement_handoff_created",
      entityType: "approval",
      entityId: approval.id,
      details: {
        coordinatorIssueId: resumeIssue.id,
        coordinatorCommentId: coordinatorComment.id,
        techLeadAgentId: techLeadAgent.id,
        techLeadIssueId: techLeadIssue.id,
        wakeRunId: wakeRun?.id ?? null,
      },
    });

    return {
      handled: true as const,
      techLeadIssueId: techLeadIssue.id,
      wakeRunId: wakeRun?.id ?? null,
    };
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      await applyLinkedIssueApprovalOutcome(approval, "approved");
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const { resumeIssue, wakeAgentId } = await resolveApprovalResumeContext(approval, linkedIssues);
      const wakeIssueId = resumeIssue?.id ?? linkedIssueIds[0] ?? null;
      const requirementHandoff = await automateRequirementApprovalHandoff({
        approval,
        linkedIssues,
        resumeIssue,
        coordinatorAgentId: wakeAgentId,
        requestedByUserId: req.actor.userId ?? "board",
      });

      if (
        resumeIssue &&
        wakeAgentId &&
        !requirementHandoff.handled &&
        resumeIssue.status !== "done" &&
        resumeIssue.status !== "cancelled" &&
        (resumeIssue.assigneeAgentId !== wakeAgentId || resumeIssue.assigneeUserId !== null)
      ) {
        await issuesSvc.update(resumeIssue.id, {
          assigneeAgentId: wakeAgentId,
          assigneeUserId: null,
          status: resumeIssue.status === "in_review" ? "todo" : resumeIssue.status,
        });
      }

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
          techLeadIssueId: requirementHandoff.techLeadIssueId,
        },
      });

      if (wakeAgentId && !requirementHandoff.handled) {
        try {
          const wakeRun = await heartbeat.wakeup(wakeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: wakeIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: wakeIssueId,
              issueIds: linkedIssueIds,
              taskId: wakeIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              resumedAgentId: wakeAgentId,
              resumeIssueId: wakeIssueId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
              resumedAgentId: wakeAgentId,
              resumeIssueId: wakeIssueId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              resumedAgentId: wakeAgentId,
              resumeIssueId: wakeIssueId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.reject(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      await applyLinkedIssueApprovalOutcome(approval, "rejected");
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const approval = await svc.requestRevision(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      );

      await applyLinkedIssueApprovalOutcome(approval, "revision_requested");

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
