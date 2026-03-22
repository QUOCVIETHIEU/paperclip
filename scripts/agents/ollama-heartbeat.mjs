#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PAPERCLIP_API_URL = requiredEnv("PAPERCLIP_API_URL");
const PAPERCLIP_API_KEY = requiredEnv("PAPERCLIP_API_KEY");
const PAPERCLIP_RUN_ID = requiredEnv("PAPERCLIP_RUN_ID");
const OLLAMA_MODEL = requiredEnv("OLLAMA_MODEL");

const OLLAMA_BASE_URL = optionalEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
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
  });

  const ollama = await callOllama(prompt);
  const plan = parseDelegationPlan(ollama.response);
  const delegationResult = await maybeCreateDelegatedIssues({
    companyId: me.companyId,
    parentIssue: context.issue,
    directReports,
    plan,
  });
  const body = buildIssueComment({
    model: OLLAMA_MODEL,
    issue: context.issue,
    response: plan.comment,
    delegationResult,
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
        "If this issue should be delegated, return your answer in two parts:",
        "1. The human-facing markdown comment.",
        "2. A machine-readable block introduced by the exact marker `DELEGATION_PLAN_JSON` followed by a single JSON code fence.",
        "",
        "The JSON schema is:",
        JSON.stringify({
          delegate: true,
          tasks: [
            {
              title: "string",
              assigneeAgentId: "uuid from directReports list",
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
        "- Create at most one task per direct report unless the issue explicitly requires otherwise.",
        "- Keep task titles concrete and role-appropriate.",
        "- If no delegation is needed, omit the marker and JSON block entirely.",
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
  if (input.delegationResult?.created?.length > 0 || input.delegationResult?.skipped?.length > 0) {
    lines.push(
      "",
      "### Kết quả giao việc tự động",
    );
    if (input.delegationResult.created.length > 0) {
      lines.push(...input.delegationResult.created.map((task) => `- Đã tạo ${task.identifier ?? task.id}: ${task.title}`));
    }
    if (input.delegationResult.skipped.length > 0) {
      lines.push(...input.delegationResult.skipped.map((task) => `- Bỏ qua task đã tồn tại: ${task.title}`));
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

  const planMarkerIndex = text.indexOf("DELEGATION_PLAN_JSON");
  if (planMarkerIndex >= 0) {
    text = text.slice(0, planMarkerIndex).trim();
  }

  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  text = text.replace(/^##\s+Ollama trial update\s*/i, "").trim();
  text = text.replace(/^#\s+Ollama trial update\s*/i, "").trim();

  return text;
}

function parseDelegationPlan(response) {
  const marker = "DELEGATION_PLAN_JSON";
  const markerIndex = response.indexOf(marker);
  if (markerIndex < 0) {
    return {
      comment: response.trim(),
      tasks: [],
    };
  }

  const comment = response.slice(0, markerIndex).trim();
  const remainder = response.slice(markerIndex + marker.length);
  const match = remainder.match(/```json\s*([\s\S]*?)```/i) ?? remainder.match(/```\s*([\s\S]*?)```/i);
  if (!match?.[1]) {
    throw new Error("Delegation marker found but JSON block is missing");
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Delegation JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  return {
    comment,
    tasks: tasks
      .filter((task) => task && typeof task === "object")
      .map((task) => ({
        title: readNonEmptyString(task.title),
        assigneeAgentId: readNonEmptyString(task.assigneeAgentId),
        objective: readNonEmptyString(task.objective),
        scope: normalizeStringList(task.scope),
        outOfScope: normalizeStringList(task.outOfScope),
        deliverables: normalizeStringList(task.deliverables),
        completionCriteria: normalizeStringList(task.completionCriteria),
      }))
      .filter((task) => task.title && task.assigneeAgentId && task.objective),
  };
}

async function maybeCreateDelegatedIssues(input) {
  if (!Array.isArray(input.directReports) || input.directReports.length === 0) {
    return { created: [], skipped: [] };
  }
  if (!Array.isArray(input.plan.tasks) || input.plan.tasks.length === 0) {
    return { created: [], skipped: [] };
  }

  const directReportsById = new Map(
    input.directReports
      .filter((report) => report && typeof report.id === "string")
      .map((report) => [report.id, report]),
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
  for (const task of input.plan.tasks) {
    if (!directReportsById.has(task.assigneeAgentId)) continue;
    const normalizedTitle = normalizeComparableTitle(task.title);
    if (!normalizedTitle) continue;
    if (existingTitles.has(normalizedTitle)) {
      skipped.push({ title: task.title });
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
        assigneeAgentId: task.assigneeAgentId,
        requestDepth: Number(input.parentIssue.requestDepth ?? 0) + 1,
      },
    });
    created.push(createdIssue);
    existingTitles.add(normalizedTitle);
  }

  return { created, skipped };
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
