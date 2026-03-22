import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "../utils.js";

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

function bridgeScriptPath() {
  const adapterDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(adapterDir, "../../../../scripts/agents/ollama-heartbeat.mjs");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "node");
  const cwd = asString(config.cwd, process.cwd());
  const model = asString(config.model, "").trim();
  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_BASE_URL).trim() || DEFAULT_OLLAMA_BASE_URL;
  const promptTemplate = asString(config.promptTemplate, "").trim();
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const keepAlive = asString(config.keepAlive, "5m").trim() || "5m";
  const optionsJson = asString(config.optionsJson, "").trim();
  const systemPrompt = asString(config.systemPrompt, "").trim();
  const envConfig = parseObject(config.env);
  const managerInstructions = asString(context.paperclipManagerInstructions, "").trim();
  const orgContext = parseObject(context.paperclipOrg);

  if (!model) {
    throw new Error("ollama_local requires adapterConfig.model");
  }

  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (authToken && (!env.PAPERCLIP_API_KEY || env.PAPERCLIP_API_KEY.trim().length === 0)) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  env.OLLAMA_MODEL = model;
  env.OLLAMA_BASE_URL = baseUrl;
  env.OLLAMA_KEEP_ALIVE = keepAlive;
  const effectivePromptTemplate = [managerInstructions, promptTemplate]
    .filter((value) => value.length > 0)
    .join("\n\n");
  if (effectivePromptTemplate) env.OLLAMA_PROMPT_TEMPLATE = effectivePromptTemplate;
  if (instructionsFilePath) env.OLLAMA_INSTRUCTIONS_FILE_PATH = path.resolve(cwd, instructionsFilePath);
  if (optionsJson) env.OLLAMA_OPTIONS_JSON = optionsJson;
  if (systemPrompt) env.OLLAMA_SYSTEM_PROMPT = systemPrompt;
  if (Array.isArray(orgContext.directReports) && orgContext.directReports.length > 0) {
    env.PAPERCLIP_DIRECT_REPORTS_JSON = JSON.stringify(orgContext.directReports);
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const args = [bridgeScriptPath()];
  if (onMeta) {
    await onMeta({
      adapterType: "ollama_local",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env: runtimeEnv,
    timeoutSec: 0,
    graceSec: 15,
    onLog,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: "Timed out",
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage: (proc.exitCode ?? 0) === 0 ? null : `Ollama bridge exited with code ${proc.exitCode ?? -1}`,
    provider: "ollama",
    model,
    billingType: "fixed",
    summary: (proc.exitCode ?? 0) === 0 ? `Ollama bridge ran with ${model}` : null,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
