import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { listOllamaModels } from "./models.js";

export const ollamaLocalAdapter: ServerAdapterModule = {
  type: "ollama_local",
  execute,
  testEnvironment,
  models: [],
  listModels: listOllamaModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want a lightweight Paperclip trial agent backed by a local Ollama model
- You want to evaluate issue wakeups and comment round-trips without external provider keys

Core fields:
- cwd (string, optional): absolute working directory used by the bridge process
- model (string, required): Ollama model name, for example nemotron-cascade-2
- baseUrl (string, optional): Ollama API base URL; defaults to http://115.78.94.36:11434
- instructionsFilePath (string, optional): absolute or cwd-relative markdown file appended to the prompt
- promptTemplate (string, optional): heartbeat guidance appended after issue context
- keepAlive (string, optional): Ollama keep_alive value
- optionsJson (string, optional): JSON object passed as Ollama request options
- systemPrompt (string, optional): override for the bridge system prompt
- command (string, optional): node executable used to launch the bridge script; defaults to "node"
- env (object, optional): additional environment variables

Notes:
- This adapter is intentionally conservative. It posts issue comments and releases the issue back to todo.
- It does not provide coding tools, file editing, or session resume.
- Model discovery uses the local Ollama /api/tags endpoint when available.
`,
};
