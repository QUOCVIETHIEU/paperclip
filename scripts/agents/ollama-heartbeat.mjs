#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PAPERCLIP_API_URL = requiredEnv("PAPERCLIP_API_URL");
const PAPERCLIP_API_KEY = requiredEnv("PAPERCLIP_API_KEY");
const PAPERCLIP_RUN_ID = requiredEnv("PAPERCLIP_RUN_ID");
const OLLAMA_MODEL = requiredEnv("OLLAMA_MODEL");

const OLLAMA_BASE_URL = optionalEnv("OLLAMA_BASE_URL", "http://115.78.94.36:11434");
const OLLAMA_KEEP_ALIVE = optionalEnv("OLLAMA_KEEP_ALIVE", "5m");
const OLLAMA_OPTIONS_JSON = optionalEnv("OLLAMA_OPTIONS_JSON", "");
const OLLAMA_SYSTEM_PROMPT = optionalEnv(
  "OLLAMA_SYSTEM_PROMPT",
  [
    "You are a lightweight Paperclip local agent running through an Ollama bridge.",
    "You do not have file editing tools, shell tools, browser tools, or hidden context outside the prompt.",
    "Your job is to produce a high-quality final answer for the assigned issue comment.",
    "If the issue description specifies an output format, section structure, or language, follow it exactly.",
    "Do not add wrapper headings such as 'Ollama trial update' unless the task explicitly asks for them.",
    "Do not mention Paperclip, Ollama, model limitations, or your tooling unless the task explicitly asks for that.",
    "Do not claim code changes, tests, or external actions that you did not actually perform.",
    "If important context is missing, state the missing assumption briefly and continue with the most reasonable answer.",
    "Prefer concrete, professional, business-appropriate writing over generic filler.",
  ].join(" "),
);
const OLLAMA_PROMPT_TEMPLATE = optionalEnv("OLLAMA_PROMPT_TEMPLATE", "");
const OLLAMA_INSTRUCTIONS_FILE_PATH = optionalEnv("OLLAMA_INSTRUCTIONS_FILE_PATH", "");
const PAPERCLIP_DIRECT_REPORTS_JSON = optionalEnv("PAPERCLIP_DIRECT_REPORTS_JSON", "");

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ollama-heartbeat] ${message}`);

  try {
    const issueId = process.env.PAPERCLIP_TASK_ID?.trim();
    if (issueId) {
      await postIssueComment(issueId, [
        "## Ollama bridge failed",
        "",
        "The trial heartbeat bridge could not complete.",
        "",
        `Error: \`${message}\``,
      ].join("\n"));
    }
  } catch {
    // Best-effort only.
  }

  process.exitCode = 1;
});

async function main() {
  const me = await apiJson("/api/agents/me");
  const inbox = await apiJson("/api/agents/me/inbox-lite");
  const directReports = parseJsonEnv(PAPERCLIP_DIRECT_REPORTS_JSON, "PAPERCLIP_DIRECT_REPORTS_JSON") ?? [];

  const issue = pickIssue(inbox);
  if (!issue) {
    console.log("[ollama-heartbeat] No assigned issues. Exiting.");
    return;
  }

  if (issue.status !== "in_progress") {
    await apiJson(`/api/issues/${issue.id}/checkout`, {
      method: "POST",
      body: {
        agentId: me.id,
        expectedStatuses: ["todo", "backlog", "blocked"],
      },
      includeRunId: true,
    });
  }

  const approvalContext = inferApprovalContext({ agent: me, issue });
  const wakeCommentId = process.env.PAPERCLIP_WAKE_COMMENT_ID?.trim();
  const heartbeatContextPath = wakeCommentId
    ? `/api/issues/${issue.id}/heartbeat-context?wakeCommentId=${encodeURIComponent(wakeCommentId)}`
    : `/api/issues/${issue.id}/heartbeat-context`;
  const context = await apiJson(heartbeatContextPath);
  const instructions = await loadInstructions(OLLAMA_INSTRUCTIONS_FILE_PATH);

  const prompt = buildPrompt({
    agent: me,
    issue: context.issue,
    ancestors: context.ancestors ?? [],
    project: context.project ?? null,
    goal: context.goal ?? null,
    wakeReason: process.env.PAPERCLIP_WAKE_REASON?.trim() || null,
    wakeComment: context.wakeComment ?? null,
    instructions,
    directReports,
    approvalContext,
  });

  const ollama = await callOllama(prompt);
  const approvalRequest = parseApprovalRequest(ollama.response, approvalContext);
  const plan = parseDelegationPlan(approvalRequest.comment);
  const delegationResult = await maybeCreateDelegatedIssues({
    companyId: me.companyId,
    parentIssue: context.issue,
    directReports,
    plan,
  });
  const approvalResult = await maybeCreateApprovalRequest({
    companyId: me.companyId,
    issue: context.issue,
    approvalContext,
    request: approvalRequest.request,
    diagnostics: approvalRequest.diagnostics,
  });
  const body = buildIssueComment({
    model: OLLAMA_MODEL,
    issue: context.issue,
    response: plan.comment,
    delegationResult,
    approvalResult,
  });

  await postIssueComment(issue.id, body);
  await apiJson(`/api/issues/${issue.id}/release`, {
    method: "POST",
    includeRunId: true,
  });

  console.log(`[ollama-heartbeat] Commented on ${context.issue.identifier} using ${OLLAMA_MODEL}.`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`Missing required env var ${name}`);
}

function optionalEnv(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function buildPrompt(input) {
  const issueDescription =
    typeof input.issue.description === "string" && input.issue.description.trim().length > 0
      ? input.issue.description.trim()
      : "(none)";
  const wakeComment =
    input.wakeComment && typeof input.wakeComment.body === "string" && input.wakeComment.body.trim().length > 0
      ? input.wakeComment.body.trim()
      : "(none)";
  const directReportsSection = Array.isArray(input.directReports) && input.directReports.length > 0
    ? [
        "Direct reports available for delegation",
        JSON.stringify(input.directReports, null, 2),
        "",
        "If this issue should be delegated, produce a normal human-facing markdown answer first.",
        "After the human-facing markdown answer, append a machine-readable block introduced by the exact marker `DELEGATION_PLAN_JSON` followed by a single JSON code fence.",
        "Do not mention these formatting instructions in the human-facing markdown answer.",
        "Do not say things like 'we need to output two parts', 'human-facing markdown comment', or discuss the response protocol.",
        "",
        "The JSON schema is:",
        JSON.stringify({
          delegate: true,
          tasks: [
            {
              title: "string",
              assigneeAgentId: "uuid from directReports list",
              assigneeName: "exact direct report name from directReports list",
              objective: "string",
              scope: ["string"],
              outOfScope: ["string"],
              deliverables: ["string"],
              completionCriteria: ["string"],
            },
          ],
        }, null, 2),
        "",
        "Rules for delegation JSON:",
        "- Only include direct reports from the provided list.",
        "- Prefer `assigneeName` using the exact direct report name. Use `assigneeAgentId` only if you are certain.",
        "- Create at most one task per direct report unless the issue explicitly requires otherwise.",
        "- Keep task titles concrete and role-appropriate.",
        "- If no delegation is needed, omit the marker and JSON block entirely.",
        "- If you omit the JSON block, Paperclip may still try to infer delegation from markdown sections named like `### Issue cho BA AGENT`, but JSON is more reliable.",
      ].join("\n")
    : "";
  const approvalSection = input.approvalContext
    ? [
        "Approval gate available for this issue",
        JSON.stringify(input.approvalContext, null, 2),
        "",
        "If and only if your final deliverable is complete and ready for review at this gate, append a machine-readable block introduced by the exact marker `APPROVAL_REQUEST_JSON` followed by a single JSON code fence.",
        "Do not mention these formatting instructions in the human-facing markdown answer.",
        "For BA, DESIGNER, and QA deliverables, requesting approval when the package is complete is expected and should happen automatically.",
        "Do not request approval if the deliverable is still incomplete or still needs clarification.",
        "If you do request approval, keep the JSON concise and use the exact `type` provided in the approval context.",
        "",
        "The JSON schema is:",
        JSON.stringify({
          requestApproval: true,
          type: input.approvalContext.type,
          stage: input.approvalContext.stage,
          summary: "short reviewer-facing summary",
        }, null, 2),
      ].join("\n")
    : "";

  return [
    input.instructions ? `Agent instructions\n${input.instructions}\n` : "",
    `Agent: ${input.agent.name} (${input.agent.role})`,
    `Company ID: ${input.agent.companyId}`,
    `Run ID: ${PAPERCLIP_RUN_ID}`,
    `Wake reason: ${input.wakeReason ?? "(none)"}`,
    "",
    "Issue",
    JSON.stringify(
      {
        id: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
        status: input.issue.status,
        priority: input.issue.priority,
        description: issueDescription,
      },
      null,
      2,
    ),
    "",
    "Ancestors",
    JSON.stringify(input.ancestors, null, 2),
    "",
    "Project",
    JSON.stringify(input.project, null, 2),
    "",
    "Goal",
    JSON.stringify(input.goal, null, 2),
    "",
    "Wake comment",
    wakeComment,
    "",
    approvalSection,
    approvalSection ? "" : "",
    directReportsSection,
    directReportsSection ? "" : "",
    OLLAMA_PROMPT_TEMPLATE.trim().length > 0
      ? `Heartbeat instructions\n${OLLAMA_PROMPT_TEMPLATE.trim()}`
      : [
          "Execution instructions",
          "- Read the issue description carefully and treat it as the primary source of instructions.",
          "- If the issue includes an explicit output format, follow that format exactly.",
          "- Return only the final answer body intended for the issue comment.",
          "- Do not add commentary about your process, tooling, or missing tools.",
          "- Write in a concise, professional tone.",
          "- If the task asks for Vietnamese output, answer in Vietnamese.",
        ].join("\n"),
  ].join("\n");
}

async function callOllama(prompt) {
  const options = parseJsonEnv(OLLAMA_OPTIONS_JSON, "OLLAMA_OPTIONS_JSON");
  const response = await fetch(`${trimTrailingSlash(OLLAMA_BASE_URL)}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: OLLAMA_SYSTEM_PROMPT,
      prompt,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      ...(options ? { options } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama request failed with ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  const text = typeof json.response === "string" ? json.response.trim() : "";
  if (!text) {
    throw new Error("Ollama returned an empty response");
  }
  return { response: text };
}

function parseJsonEnv(raw, name) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildIssueComment(input) {
  const cleanedResponse = normalizeAgentResponse(input.response);
  const lines = [
    cleanedResponse,
  ];
  if (
    input.delegationResult?.created?.length > 0 ||
    input.delegationResult?.skipped?.length > 0 ||
    input.delegationResult?.notes?.length > 0
  ) {
    lines.push(
      "",
      "### Kết quả giao việc tự động",
    );
    if (input.delegationResult.created.length > 0) {
      lines.push(...input.delegationResult.created.map((task) => `- Đã tạo ${task.identifier ?? task.id}: ${task.title}`));
    }
    if (input.delegationResult.skipped.length > 0) {
      lines.push(...input.delegationResult.skipped.map((task) => `- Bỏ qua: ${task.reason}${task.title ? ` (${task.title})` : ""}`));
    }
    if (input.delegationResult.notes.length > 0) {
      lines.push(...input.delegationResult.notes.map((note) => `- Ghi chú: ${note}`));
    }
  }
  if (
    input.approvalResult?.created ||
    input.approvalResult?.skipped?.length > 0 ||
    input.approvalResult?.notes?.length > 0
  ) {
    lines.push(
      "",
      "### Kết quả approval tự động",
    );
    if (input.approvalResult.created) {
      lines.push(`- Đã tạo approval ${input.approvalResult.created.id.slice(0, 8)}: ${input.approvalResult.created.type}`);
    }
    if (input.approvalResult.skipped?.length > 0) {
      lines.push(...input.approvalResult.skipped.map((note) => `- Bỏ qua: ${note}`));
    }
    if (input.approvalResult.notes?.length > 0) {
      lines.push(...input.approvalResult.notes.map((note) => `- Ghi chú: ${note}`));
    }
  }
  lines.push(
    "",
    "---",
    `Bridge model: \`${input.model}\``,
    `Issue: \`${input.issue.identifier}\``,
    "",
    "_Posted by the local Ollama process bridge._",
  );
  return lines.join("\n");
}

function normalizeAgentResponse(response) {
  let text = response.trim();

  const approvalMarkerIndex = text.indexOf("APPROVAL_REQUEST_JSON");
  if (approvalMarkerIndex >= 0) {
    text = text.slice(0, approvalMarkerIndex).trim();
  }

  const planMarkerIndex = text.indexOf("DELEGATION_PLAN_JSON");
  if (planMarkerIndex >= 0) {
    text = text.slice(0, planMarkerIndex).trim();
  }

  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  text = text
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().toLowerCase();
      if (!normalized) return true;
      if (normalized.includes("we need to output two parts")) return false;
      if (normalized.includes("human-facing markdown")) return false;
      if (normalized.includes("response protocol")) return false;
      if (normalized.includes("machine-readable block")) return false;
      return true;
    })
    .join("\n")
    .trim();

  text = text.replace(/^##\s+Ollama trial update\s*/i, "").trim();
  text = text.replace(/^#\s+Ollama trial update\s*/i, "").trim();

  return text;
}

function inferApprovalContext(input) {
  const roleSource = `${readNonEmptyString(input.agent?.name)} ${readNonEmptyString(input.agent?.role)}`.toLocaleUpperCase();
  if (roleSource.includes("BA")) {
    return {
      type: "approve_requirement_package",
      stage: "Requirement Package",
      gate: "Requirement Package Approval",
      requestedFor: "PM",
      summary: "Review and approve the requirement package before technical solutioning starts.",
    };
  }
  if (roleSource.includes("DESIGNER")) {
    return {
      type: "approve_design_package",
      stage: "UX/UI Design",
      gate: "UX/UI Design Approval",
      requestedFor: "PM + TECH LEAD",
      summary: "Review and approve the UX/UI design package before development starts.",
    };
  }
  if (roleSource.includes("QA")) {
    return {
      type: "approve_qa_exit",
      stage: "QA Exit",
      gate: "QA Exit Approval",
      requestedFor: "TECH LEAD + PM",
      summary: "Review and approve QA exit readiness before UAT or go-live.",
    };
  }
  return null;
}

function parseApprovalRequest(response, approvalContext) {
  if (!approvalContext) {
    return { comment: response.trim(), request: null, diagnostics: [] };
  }

  const marker = "APPROVAL_REQUEST_JSON";
  const markerIndex = response.indexOf(marker);
  if (markerIndex < 0) {
    const inferred = inferApprovalRequestFromMarkdown(response, approvalContext);
    return {
      comment: response.trim(),
      request: inferred,
      diagnostics: inferred ? ["Không có APPROVAL_REQUEST_JSON, đã fallback parse từ markdown."] : [],
    };
  }

  const remainder = response.slice(markerIndex + marker.length);
  const match = remainder.match(/```json\s*([\s\S]*?)```/i) ?? remainder.match(/```\s*([\s\S]*?)```/i);
  const comment = response.slice(0, markerIndex).trim();
  if (!match?.[1]) {
    const inferred = inferApprovalRequestFromMarkdown(comment, approvalContext);
    return {
      comment,
      request: inferred,
      diagnostics: inferred
        ? ["Marker approval có mặt nhưng thiếu JSON block; đã fallback parse từ markdown."]
        : ["Marker approval có mặt nhưng thiếu JSON block."],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    const inferred = inferApprovalRequestFromMarkdown(comment, approvalContext);
    return {
      comment,
      request: inferred,
      diagnostics: inferred
        ? ["Approval JSON không hợp lệ; đã fallback parse từ markdown."]
        : [`Approval JSON không hợp lệ: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const requestApproval = parsed?.requestApproval;
  if (requestApproval !== true) {
    return { comment, request: null, diagnostics: [] };
  }

  const type = readNonEmptyString(parsed?.type) || approvalContext.type;
  const stage = readNonEmptyString(parsed?.stage) || approvalContext.stage;
  const summary = readNonEmptyString(parsed?.summary) || approvalContext.summary;
  if (!type || !stage || !summary) {
    return { comment, request: null, diagnostics: ["Approval request thiếu type/stage/summary hợp lệ."] };
  }

  return {
    comment,
    request: {
      type,
      stage,
      summary,
    },
    diagnostics: [],
  };
}

function parseDelegationPlan(response) {
  const marker = "DELEGATION_PLAN_JSON";
  const markerIndex = response.indexOf(marker);
  if (markerIndex < 0) {
    const inferredTasks = inferDelegationTasksFromMarkdown(response);
    return {
      comment: response.trim(),
      tasks: inferredTasks.tasks,
      diagnostics: inferredTasks.tasks.length > 0
        ? ["Không có DELEGATION_PLAN_JSON, đã fallback parse từ markdown."]
        : ["Không có DELEGATION_PLAN_JSON nên không có delegation machine-readable."],
    };
  }

  const comment = response.slice(0, markerIndex).trim();
  const remainder = response.slice(markerIndex + marker.length);
  const match = remainder.match(/```json\s*([\s\S]*?)```/i) ?? remainder.match(/```\s*([\s\S]*?)```/i);
  if (!match?.[1]) {
    const inferredTasks = inferDelegationTasksFromMarkdown(comment);
    if (inferredTasks.tasks.length === 0) {
      console.warn("[ollama-heartbeat] Delegation marker found but JSON block is missing, and markdown fallback found no tasks.");
    } else {
      console.log("[ollama-heartbeat] Delegation marker found without JSON block; recovered via markdown fallback.");
    }
    return {
      comment,
      tasks: inferredTasks.tasks,
      diagnostics: inferredTasks.tasks.length > 0
        ? ["Marker delegation có mặt nhưng thiếu JSON block; đã fallback parse từ markdown."]
        : ["Marker delegation có mặt nhưng thiếu JSON block."],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    const inferredTasks = inferDelegationTasksFromMarkdown(comment);
    if (inferredTasks.tasks.length === 0) {
      console.warn(
        `[ollama-heartbeat] Delegation JSON is invalid and markdown fallback found no tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
    } else {
      console.log(
        `[ollama-heartbeat] Delegation JSON is invalid; recovered via markdown fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      comment,
      tasks: inferredTasks.tasks,
      diagnostics: inferredTasks.tasks.length > 0
        ? ["Delegation JSON không hợp lệ; đã fallback parse từ markdown."]
        : ["Delegation JSON không hợp lệ."],
    };
  }

  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  return {
    comment,
    tasks: tasks
      .filter((task) => task && typeof task === "object")
      .map((task) => ({
        title: readNonEmptyString(task.title),
        assigneeAgentId: readNonEmptyString(task.assigneeAgentId),
        assigneeName: readNonEmptyString(task.assigneeName),
        objective: readNonEmptyString(task.objective),
        scope: normalizeStringList(task.scope),
        outOfScope: normalizeStringList(task.outOfScope),
        deliverables: normalizeStringList(task.deliverables),
        completionCriteria: normalizeStringList(task.completionCriteria),
      }))
      .filter((task) => task.title && (task.assigneeAgentId || task.assigneeName) && task.objective),
    diagnostics: [],
  };
}

async function maybeCreateDelegatedIssues(input) {
  if (!Array.isArray(input.directReports) || input.directReports.length === 0) {
    return { created: [], skipped: [], notes: ["Agent không có direct reports nên không thể auto-delegate."] };
  }
  if (!Array.isArray(input.plan.tasks) || input.plan.tasks.length === 0) {
    return { created: [], skipped: [], notes: input.plan.diagnostics ?? [] };
  }

  const directReportsById = new Map(
    input.directReports
      .filter((report) => report && typeof report.id === "string")
      .map((report) => [report.id, report]),
  );
  const directReportsByName = new Map(
    input.directReports
      .filter((report) => report && typeof report.name === "string")
      .map((report) => [normalizeComparableTitle(report.name), report]),
  );
  const existingChildren = await apiJson(
    `/api/companies/${input.companyId}/issues?parentId=${encodeURIComponent(input.parentIssue.id)}`,
  );
  const existingTitles = new Set(
    Array.isArray(existingChildren)
      ? existingChildren
          .map((issue) => normalizeComparableTitle(issue?.title))
          .filter(Boolean)
      : [],
  );

  const created = [];
  const skipped = [];
  const notes = [...(input.plan.diagnostics ?? [])];
  for (const task of input.plan.tasks) {
    const assignee = resolveDelegationAssignee({
      task,
      directReportsById,
      directReportsByName,
    });
    if (!assignee) {
      skipped.push({
        title: task.title,
        reason: task.assigneeAgentId || task.assigneeName
          ? "Không map được assignee sang direct report hợp lệ"
          : "Task thiếu assignee hợp lệ",
      });
      continue;
    }
    const normalizedTitle = normalizeComparableTitle(task.title);
    if (!normalizedTitle) continue;
    if (existingTitles.has(normalizedTitle)) {
      skipped.push({ title: task.title, reason: "Task đã tồn tại dưới parent issue" });
      continue;
    }

    const createdIssue = await apiJson(`/api/companies/${input.companyId}/issues`, {
      method: "POST",
      includeRunId: true,
      body: {
        projectId: input.parentIssue.projectId ?? null,
        goalId: input.parentIssue.goalId ?? null,
        parentId: input.parentIssue.id,
        title: task.title,
        description: buildDelegatedIssueDescription(task),
        status: "todo",
        priority: input.parentIssue.priority ?? "medium",
        assigneeAgentId: assignee.id,
        requestDepth: Number(input.parentIssue.requestDepth ?? 0) + 1,
      },
    });
    created.push(createdIssue);
    existingTitles.add(normalizedTitle);
  }

  if (created.length === 0 && skipped.length === 0 && notes.length === 0) {
    notes.push("Không phát hiện task delegation nào có thể tạo.");
  }

  return { created, skipped, notes };
}

async function maybeCreateApprovalRequest(input) {
  const result = { created: null, skipped: [], notes: [...(input.diagnostics ?? [])] };
  if (!input.approvalContext) {
    return result;
  }
  if (!input.request) {
    return result;
  }

  const linkedApprovals = await apiJson(`/api/issues/${input.issue.id}/approvals`);
  const sameType = Array.isArray(linkedApprovals)
    ? linkedApprovals
        .filter((approval) => approval && approval.type === input.request.type)
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    : [];
  const latest = sameType[0] ?? null;
  if (latest?.status === "pending") {
    result.skipped.push("Approval cùng loại đang pending, không tạo lại.");
    return result;
  }
  if (latest?.status === "approved") {
    result.skipped.push("Approval cùng loại đã approved, không tạo lại.");
    return result;
  }

  const requestedByAgentId =
    input.issue.createdByAgentId ??
    input.issue.assigneeAgentId ??
    input.issue.lastAssignedAgentId ??
    null;

  const approval = await apiJson(`/api/companies/${input.companyId}/approvals`, {
    method: "POST",
    includeRunId: true,
    body: {
      type: input.request.type,
      requestedByAgentId,
      issueIds: [input.issue.id],
      payload: {
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier ?? input.issue.id,
        issueTitle: input.issue.title,
        stage: input.request.stage,
        requestedFor: input.approvalContext.requestedFor,
        summary: input.request.summary,
      },
    },
  });

  await apiJson(`/api/issues/${input.issue.id}`, {
    method: "PATCH",
    includeRunId: true,
    body: {
      status: "in_review",
      comment: `Requested ${input.request.stage} approval in ${approval.id.slice(0, 8)}.`,
    },
  });

  result.created = approval;
  return result;
}

function resolveDelegationAssignee(input) {
  if (input.task.assigneeAgentId && input.directReportsById.has(input.task.assigneeAgentId)) {
    return input.directReportsById.get(input.task.assigneeAgentId) ?? null;
  }
  const normalizedName = normalizeComparableTitle(input.task.assigneeName);
  if (normalizedName && input.directReportsByName.has(normalizedName)) {
    return input.directReportsByName.get(normalizedName) ?? null;
  }
  return null;
}

function buildDelegatedIssueDescription(task) {
  return [
    `Mục tiêu\n${task.objective}`,
    formatBulletSection("Phạm vi công việc", task.scope),
    formatBulletSection("Ngoài phạm vi", task.outOfScope),
    formatBulletSection("Kết quả cần đạt", task.deliverables),
    formatBulletSection("Tiêu chí hoàn thành", task.completionCriteria),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatBulletSection(title, items) {
  if (!Array.isArray(items) || items.length === 0) return `${title}\n- (không nêu)`;
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readNonEmptyString(item))
    .filter(Boolean);
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function normalizeComparableTitle(value) {
  return readNonEmptyString(value).toLocaleLowerCase();
}

function inferDelegationTasksFromMarkdown(response) {
  const tasks = [];
  const sections = response.match(/###\s*Issue cho[\s\S]*?(?=\n###\s*Issue cho|\s*$)/gi) ?? [];
  for (const section of sections) {
    const headingMatch = section.match(/###\s*Issue cho\s*:?\s*(.+?)\s*$/im);
    const assigneeName = headingMatch?.[1]?.trim() ?? "";
    const title = extractSingleLineField(section, "Task title");
    const objective = extractSingleLineField(section, "Mục tiêu");
    const scope = extractListField(section, "Phạm vi công việc");
    const outOfScope = extractListField(section, "Ngoài phạm vi");
    const deliverables = extractListField(section, "Output mong đợi");
    const completionCriteria = extractListField(section, "Tiêu chí hoàn thành");
    if (title && assigneeName && objective) {
      tasks.push({
        title,
        assigneeAgentId: "",
        assigneeName,
        objective,
        scope,
        outOfScope,
        deliverables,
        completionCriteria,
      });
    }
  }
  return { tasks };
}

function inferApprovalRequestFromMarkdown(response, approvalContext) {
  const text = response.toLocaleLowerCase();
  const candidatePhrases = [
    `sẵn sàng gửi ${approvalContext.gate}`.toLocaleLowerCase(),
    `sẵn sàng gửi ${approvalContext.stage} approval`.toLocaleLowerCase(),
    `ready to send ${approvalContext.gate}`.toLocaleLowerCase(),
    `ready for ${approvalContext.gate}`.toLocaleLowerCase(),
    `trạng thái sẵn sàng approval`.toLocaleLowerCase(),
    `sẵn sàng approval`.toLocaleLowerCase(),
    "co the tien hanh gui yeu cau phe duyet",
    "có thể tiến hành gửi yêu cầu phê duyệt",
    "san sang gui yeu cau phe duyet",
    "sẵn sàng gửi yêu cầu phê duyệt",
    "ready for approval",
  ];
  const explicitReady = candidatePhrases.some((phrase) => text.includes(phrase));

  if (!looksLikeApprovalReady(response, approvalContext, explicitReady)) {
    return null;
  }
  const deliverableReady =
    looksLikeGateDeliverable(response, approvalContext) ||
    looksLikeStructuredDeliverable(response, approvalContext);

  if (!explicitReady && !deliverableReady) {
    // For governed delivery roles, treat a substantive completed response as approval-ready by default.
    if (!isGovernedDeliveryGate(approvalContext.type)) {
      return null;
    }
  }

  return {
    type: approvalContext.type,
    stage: approvalContext.stage,
    summary: approvalContext.summary,
  };
}

function extractSingleLineField(section, label) {
  const match = section.match(new RegExp(`[-*]\\s*\\*\\*?${escapeRegExp(label)}\\*\\*?\\s*:?\\s*(.+)$`, "im"))
    ?? section.match(new RegExp(`${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function extractListField(section, label) {
  const blockMatch = section.match(
    new RegExp(`${escapeRegExp(label)}\\*\\*?\\s*:?\\s*([\\s\\S]*?)(?=\\n[-*]\\s*\\*\\*?[A-ZÀ-ỹ]|\\n###|$)`, "im"),
  ) ?? section.match(
    new RegExp(`${escapeRegExp(label)}\\s*:?\\s*([\\s\\S]*?)(?=\\n[-*]\\s*[A-ZÀ-ỹ]|\\n###|$)`, "im"),
  );

  if (!blockMatch?.[1]) return [];
  return blockMatch[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-+*]\s*/, "").trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeApprovalReady(response, approvalContext, explicitReady = false) {
  const normalized = normalizeComparableTitle(response).replace(/\s+/g, " ");
  if (!normalized || normalized.length < 180) return false;

  const negativePhrases = [
    "chua hoan tat",
    "chưa hoàn tất",
    "chua san sang",
    "chưa sẵn sàng",
    "can lam ro",
    "cần làm rõ",
    "can bo sung",
    "cần bổ sung",
    "draft",
    "placeholder",
    "todo",
    "to do",
    "tbd",
    "wip",
    "work in progress",
    "dang lam",
    "đang làm",
  ];
  if (!explicitReady && negativePhrases.some((phrase) => normalized.includes(normalizeComparableTitle(phrase)))) {
    return false;
  }

  return true;
}

function isGovernedDeliveryGate(type) {
  return [
    "approve_requirement_package",
    "approve_design_package",
    "approve_qa_exit",
  ].includes(type);
}

function looksLikeGateDeliverable(response, approvalContext) {
  const normalized = normalizeComparableTitle(response).replace(/\s+/g, " ");

  if (approvalContext.type === "approve_requirement_package") {
    return countPhraseGroups(normalized, [
      ["requirement package", "goi yeu cau", "gói yêu cầu"],
      ["scope", "pham vi", "phạm vi"],
      ["actor"],
      ["user flow", "luong nguoi dung", "luồng người dùng"],
      ["business rule", "business rules", "nghiep vu", "nghiệp vụ"],
      ["acceptance criteria", "tieu chi chap nhan", "tiêu chí chấp nhận"],
    ]) >= 4;
  }

  if (approvalContext.type === "approve_design_package") {
    return countPhraseGroups(normalized, [
      ["ux flow"],
      ["wireframe"],
      ["ui structure", "cau truc ui", "cấu trúc ui"],
      ["ui package"],
      ["muc tieu thiet ke", "mục tiêu thiết kế"],
      ["tieu chi hoan thanh", "tiêu chí hoàn thành"],
    ]) >= 3;
  }

  if (approvalContext.type === "approve_qa_exit") {
    return countPhraseGroups(normalized, [
      ["pham vi kiem thu", "phạm vi kiểm thử", "test scope"],
      ["ket qua kiem thu", "kết quả kiểm thử", "test result"],
      ["defect"],
      ["regression"],
      ["readiness", "san sang", "sẵn sàng"],
      ["qa exit"],
    ]) >= 3;
  }

  return false;
}

function looksLikeStructuredDeliverable(response, approvalContext) {
  const normalized = normalizeComparableTitle(response).replace(/\s+/g, " ");

  const generalSectionGroups = [
    ["muc tieu", "mục tiêu", "objective"],
    ["pham vi", "phạm vi", "scope"],
    ["ngoai pham vi", "ngoài phạm vi", "out of scope"],
    ["ket qua can dat", "kết quả cần đạt", "deliverable", "deliverables"],
    ["tieu chi hoan thanh", "tiêu chí hoàn thành", "completion criteria"],
    ["san sang", "sẵn sàng", "ready"],
  ];

  const requirementGroups = [
    ["actor", "actors"],
    ["user flow", "luong nguoi dung", "luồng người dùng"],
    ["business rule", "business rules", "nghiep vu", "nghiệp vụ"],
    ["acceptance criteria", "tieu chi chap nhan", "tiêu chí chấp nhận"],
  ];

  const designGroups = [
    ["ux flow"],
    ["wireframe"],
    ["ui structure", "cau truc ui", "cấu trúc ui"],
    ["ui package"],
    ["review"],
  ];

  const qaGroups = [
    ["test scope", "pham vi kiem thu", "phạm vi kiểm thử"],
    ["test result", "ket qua kiem thu", "kết quả kiểm thử"],
    ["defect"],
    ["regression"],
    ["readiness", "san sang", "sẵn sàng"],
  ];

  const generalScore = countPhraseGroups(normalized, generalSectionGroups);
  if (approvalContext.type === "approve_requirement_package") {
    return generalScore >= 2 && countPhraseGroups(normalized, requirementGroups) >= 2;
  }
  if (approvalContext.type === "approve_design_package") {
    return generalScore >= 2 && countPhraseGroups(normalized, designGroups) >= 2;
  }
  if (approvalContext.type === "approve_qa_exit") {
    return generalScore >= 2 && countPhraseGroups(normalized, qaGroups) >= 2;
  }

  return false;
}

function countPhraseGroups(normalized, groups) {
  return groups.reduce((count, group) => {
    const matched = group.some((phrase) => normalized.includes(normalizeComparableTitle(phrase)));
    return count + (matched ? 1 : 0);
  }, 0);
}

function pickIssue(inbox) {
  if (!Array.isArray(inbox) || inbox.length === 0) return null;

  const wakeIssueId = process.env.PAPERCLIP_TASK_ID?.trim();
  if (wakeIssueId) {
    const exact = inbox.find((issue) => issue && issue.id === wakeIssueId);
    if (exact) return exact;
  }

  const statusOrder = new Map([
    ["in_progress", 0],
    ["todo", 1],
    ["blocked", 2],
  ]);
  const priorityOrder = new Map([
    ["critical", 0],
    ["high", 1],
    ["medium", 2],
    ["low", 3],
  ]);

  return [...inbox]
    .filter((issue) => issue && typeof issue.id === "string")
    .sort((a, b) => {
      const statusDelta = (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99);
      if (statusDelta !== 0) return statusDelta;
      const priorityDelta = (priorityOrder.get(a.priority) ?? 99) - (priorityOrder.get(b.priority) ?? 99);
      if (priorityDelta !== 0) return priorityDelta;
      return String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? ""));
    })[0] ?? null;
}

async function postIssueComment(issueId, body) {
  await apiJson(`/api/issues/${issueId}/comments`, {
    method: "POST",
    body: { body },
    includeRunId: true,
  });
}

async function apiJson(path, options = {}) {
  const response = await fetch(`${trimTrailingSlash(PAPERCLIP_API_URL)}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "content-type": "application/json",
      ...(options.includeRunId ? { "x-paperclip-run-id": PAPERCLIP_RUN_ID } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Paperclip API ${options.method ?? "GET"} ${path} failed with ${response.status}: ${text.slice(0, 300)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function loadInstructions(filePath) {
  if (!filePath) return "";
  const resolved = path.resolve(filePath);
  try {
    const contents = await fs.readFile(resolved, "utf8");
    return `${contents.trim()}\n\nLoaded from ${resolved}.`;
  } catch (error) {
    throw new Error(
      `Could not read OLLAMA_INSTRUCTIONS_FILE_PATH=${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
