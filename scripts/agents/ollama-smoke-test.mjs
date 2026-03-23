const base = process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100/api";
const model = process.env.OLLAMA_MODEL ?? "nemotron-cascade-2";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://115.78.94.36:11434";

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body == null ? undefined : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text when the response is not JSON.
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const stamp = Date.now();
  const company = await request("POST", "/companies", { name: `Ollama Smoke ${stamp}` });
  const agent = await request("POST", `/companies/${company.id}/agents`, {
    name: `ollama-smoke-${stamp}`,
    adapterType: "ollama_local",
    workingDirectory: process.cwd(),
    adapterConfig: {
      model,
      baseUrl: ollamaBaseUrl,
    },
  });
  const issue = await request("POST", `/companies/${company.id}/issues`, {
    title: "Ollama smoke test issue",
    description: "Reply briefly with the exact phrase SMOKE_OK and mention the configured model.",
    assigneeAgentId: agent.id,
    status: "todo",
    priority: "medium",
  });

  const invoke = await request("POST", `/agents/${agent.id}/heartbeat/invoke`, {});

  let comments = [];
  let runs = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(3000);
    comments = await request("GET", `/issues/${issue.id}/comments`);
    if (Array.isArray(comments) && comments.length > 0) break;
    if (Array.isArray(comments.comments) && comments.comments.length > 0) break;
  }

  try {
    runs = await request("GET", `/agents/${agent.id}/runs?limit=5`);
  } catch (error) {
    runs = { error: String(error) };
  }

  const result = {
    companyId: company.id,
    agentId: agent.id,
    issueId: issue.id,
    invoke,
    comments,
    runs,
  };

  console.log(JSON.stringify(result, null, 2));

  const commentList = Array.isArray(comments) ? comments : Array.isArray(comments.comments) ? comments.comments : [];
  const hasBridgeComment = commentList.some((comment) =>
    typeof comment?.body === "string" &&
    comment.body.includes("## Ollama trial update") &&
    comment.body.includes(`Bridge model: \`${model}\``)
  );
  if (!hasBridgeComment) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
