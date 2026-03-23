import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import {
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
} from "../utils.js";

const DEFAULT_OLLAMA_BASE_URL = "http://115.78.94.36:11434";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "node");
  const cwd = asString(config.cwd, process.cwd());
  const model = asString(config.model, "").trim();
  const baseUrl = asString(config.baseUrl, DEFAULT_OLLAMA_BASE_URL).trim() || DEFAULT_OLLAMA_BASE_URL;
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "ollama_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (error) {
    checks.push({
      code: "ollama_cwd_invalid",
      level: "error",
      message: error instanceof Error ? error.message : "Invalid working directory",
      detail: cwd,
    });
  }

  if (!model) {
    checks.push({
      code: "ollama_model_missing",
      level: "error",
      message: "Ollama adapter requires a model.",
      hint: "Choose a configured model or pull one with `ollama pull <model>`.",
    });
  } else {
    checks.push({
      code: "ollama_model_present",
      level: "info",
      message: `Configured model: ${model}`,
    });
  }

  try {
    await ensureCommandResolvable(command, cwd, ensurePathInEnv({ ...process.env, ...env }));
    checks.push({
      code: "ollama_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (error) {
    checks.push({
      code: "ollama_command_unresolvable",
      level: "error",
      message: error instanceof Error ? error.message : "Command is not executable",
      detail: command,
    });
  }

  try {
    const response = await fetch(`${trimTrailingSlash(baseUrl)}/api/tags`);
    if (!response.ok) {
      checks.push({
        code: "ollama_api_unreachable",
        level: "error",
        message: `Ollama API responded with ${response.status}.`,
        detail: baseUrl,
        hint: "Ensure Ollama is reachable and confirm the base URL is correct.",
      });
    } else {
      const json = await response.json() as { models?: Array<{ name?: string }> };
      const models = Array.isArray(json.models) ? json.models : [];
      const names = models
        .map((entry) => (typeof entry.name === "string" ? entry.name.trim() : ""))
        .filter(Boolean);
      checks.push({
        code: "ollama_api_reachable",
        level: "info",
        message: `Ollama API reachable at ${baseUrl}.`,
      });
      if (model && names.length > 0 && !names.includes(model)) {
        checks.push({
          code: "ollama_model_unavailable",
          level: "warn",
          message: `Configured model is not available from Ollama: ${model}`,
          hint: "Run `ollama pull <model>` or choose an installed model.",
        });
      }
    }
  } catch (error) {
    checks.push({
      code: "ollama_api_unreachable",
      level: "error",
      message: error instanceof Error ? error.message : "Could not connect to Ollama API",
      detail: baseUrl,
      hint: "Ensure Ollama is reachable and verify the configured base URL.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
