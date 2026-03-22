import type { CreateConfigValues } from "../../components/AgentConfigForm";

function parseEnvVars(text: string): Record<string, { type: "plain"; value: string }> {
  const env: Record<string, { type: "plain"; value: string }> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = { type: "plain", value };
  }
  return env;
}

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    timeoutSec: 0,
    graceSec: 15,
    command: v.command || "node",
  };
  if (v.cwd) config.cwd = v.cwd;
  if (v.model) config.model = v.model;
  if (v.instructionsFilePath) config.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) config.promptTemplate = v.promptTemplate;
  if (v.url) config.baseUrl = v.url;

  const env = {
    ...parseEnvVars(v.envVars),
    ...(typeof v.envBindings === "object" && v.envBindings ? v.envBindings : {}),
  };
  if (Object.keys(env).length > 0) config.env = env;

  return config;
}
