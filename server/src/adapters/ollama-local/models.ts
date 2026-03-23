const DEFAULT_OLLAMA_BASE_URL = "http://115.78.94.36:11434";

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveBaseUrl() {
  const value = process.env.PAPERCLIP_OLLAMA_BASE_URL?.trim();
  return value && value.length > 0 ? value : DEFAULT_OLLAMA_BASE_URL;
}

export async function listOllamaModels(): Promise<Array<{ id: string; label: string }>> {
  try {
    const response = await fetch(`${trimTrailingSlash(resolveBaseUrl())}/api/tags`);
    if (!response.ok) return [];
    const json = await response.json() as { models?: Array<{ name?: string }> };
    const models = Array.isArray(json.models) ? json.models : [];
    return models
      .map((entry) => (typeof entry.name === "string" ? entry.name.trim() : ""))
      .filter(Boolean)
      .map((name) => ({ id: name, label: name }));
  } catch {
    return [];
  }
}
