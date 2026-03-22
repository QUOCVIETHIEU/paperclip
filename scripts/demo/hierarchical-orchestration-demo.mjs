const base = (process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100/api").replace(/\/+$/, "");
const targetCompanyId = process.env.PAPERCLIP_COMPANY_ID?.trim() || null;
const targetCompanyName = process.env.PAPERCLIP_COMPANY_NAME?.trim() || "QUOC VIET Co., LTD";

const agentNames = {
  cto: process.env.DEMO_CTO_NAME?.trim() || "",
  techLead: process.env.DEMO_TECH_LEAD_NAME?.trim() || "",
  pm: process.env.DEMO_PM_NAME?.trim() || "",
  fe: process.env.DEMO_FE_NAME?.trim() || "",
  be: process.env.DEMO_BE_NAME?.trim() || "",
  qa: process.env.DEMO_QA_NAME?.trim() || "",
  integration: process.env.DEMO_INTEGRATION_NAME?.trim() || "",
  ba: process.env.DEMO_BA_NAME?.trim() || "",
  sd: process.env.DEMO_SD_NAME?.trim() || "",
};

const aliases = {
  cto: ["CTO AGENT", "VO QUOC HIEU"],
  techLead: ["TECH LEAD AGENT", "TECH LEAD", "LÊ QUỲNH MINH THƯ"],
  pm: ["PM AGENT", "PRODUCT OWNER AGENT", "PROJECT MANAGER"],
  fe: ["FE AGENT", "FE DEVELOPER AGENT", "FRONTEND AGENT"],
  be: ["BE AGENT", "BE DEVELOPER AGENT", "BACKEND AGENT"],
  qa: ["QA AGENT", "QA-QC AGENT", "QA QC AGENT"],
  integration: ["INTEGRATION AGENT", "INTEGRATION ENGINEER"],
  ba: ["BA AGENT", "BUSINESS ANALYST AGENT"],
  sd: ["SD AGENT", "SERVICE DESK AGENT"],
};

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
    // Keep raw text if not JSON.
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function includesAny(text, values) {
  const normalized = String(text ?? "").toLowerCase();
  return values.some((value) => normalized.includes(value.toLowerCase()));
}

function findByAliases(items, preferred, fallbackAliases) {
  const candidates = [preferred, ...fallbackAliases].filter(Boolean);
  return items.find((item) => candidates.includes(item.name)) ?? null;
}

function flattenOrg(nodes) {
  const out = [];
  const walk = (node, depth = 0, parent = null) => {
    out.push({ ...node, depth, parentId: parent?.id ?? null });
    for (const child of node.reports ?? []) walk(child, depth + 1, node);
  };
  for (const node of nodes) walk(node, 0, null);
  return out;
}

function collectSubtreeNames(node) {
  const names = [];
  const walk = (current) => {
    names.push(current.name);
    for (const child of current.reports ?? []) walk(child);
  };
  walk(node);
  return names;
}

function inferEngineeringManager(orgRoots) {
  const roots = Array.isArray(orgRoots) ? orgRoots : [];
  const managers = roots.flatMap((root) => root.reports ?? []);
  return managers.find((node) => includesAny(collectSubtreeNames(node).join(" "), ["fe", "frontend", "be", "backend", "qa"])) ?? null;
}

function inferProductManager(orgRoots) {
  const roots = Array.isArray(orgRoots) ? orgRoots : [];
  const managers = roots.flatMap((root) => root.reports ?? []);
  return managers.find((node) => includesAny(collectSubtreeNames(node).join(" "), ["service desk", "sd agent", "business analyst", "ba agent", "product owner"])) ?? null;
}

function requireFound(item, label, items) {
  if (item) return item;
  const known = items.map((entry) => `${entry.name}${entry.title ? ` (${entry.title})` : ""}`).sort().join(", ");
  throw new Error(`Could not infer ${label}. Known agents: ${known}`);
}

async function findCompany() {
  if (targetCompanyId) {
    const company = await request("GET", `/companies/${targetCompanyId}`);
    return company;
  }
  const companies = await request("GET", "/companies");
  const company = companies.find((item) => item.name === targetCompanyName);
  if (!company) {
    throw new Error(`Could not find company "${targetCompanyName}"`);
  }
  return company;
}

async function createIssue(companyId, payload) {
  return request("POST", `/companies/${companyId}/issues`, payload);
}

async function updateIssue(issueId, payload) {
  return request("PATCH", `/issues/${issueId}`, payload);
}

async function addComment(issueId, body) {
  return request("POST", `/issues/${issueId}/comments`, { body });
}

async function listIssues(companyId) {
  return request("GET", `/companies/${companyId}/issues`);
}

async function getIssue(issueId) {
  return request("GET", `/issues/${issueId}`);
}

async function findLatestBenchmarkIssue(companyId, sourceIssueId) {
  const issues = await listIssues(companyId);
  const matches = issues
    .filter((issue) => issue.parentId === sourceIssueId && typeof issue.title === "string" && issue.title.startsWith("Benchmark: "))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  if (matches.length === 0) {
    throw new Error(`No benchmark issue found for source issue ${sourceIssueId}`);
  }
  return matches[0];
}

function summarize(issue) {
  return `${issue.identifier ?? issue.id} [${issue.status}] -> ${issue.title}`;
}

async function main() {
  const company = await findCompany();
  const agents = await request("GET", `/companies/${company.id}/agents`);
  const orgRoots = await request("GET", `/companies/${company.id}/org`);
  const flatOrg = flattenOrg(orgRoots);
  const rootNode = flatOrg.find((node) => node.depth === 0) ?? null;
  const inferredEngineeringManager = inferEngineeringManager(orgRoots);
  const inferredProductManager = inferProductManager(orgRoots);

  const cto = requireFound(
    findByAliases(agents, agentNames.cto, aliases.cto) ?? (rootNode ? agents.find((agent) => agent.id === rootNode.id) : null),
    "CTO/root agent",
    agents,
  );
  const techLead = requireFound(
    findByAliases(agents, agentNames.techLead, aliases.techLead)
      ?? (inferredEngineeringManager ? agents.find((agent) => agent.id === inferredEngineeringManager.id) : null),
    "engineering manager",
    agents,
  );
  const pm = requireFound(
    findByAliases(agents, agentNames.pm, aliases.pm)
      ?? (inferredProductManager ? agents.find((agent) => agent.id === inferredProductManager.id) : null),
    "product/operations manager",
    agents,
  );

  const fe = findByAliases(agents, agentNames.fe, aliases.fe);
  const be = findByAliases(agents, agentNames.be, aliases.be);
  const qa = findByAliases(agents, agentNames.qa, aliases.qa);
  const integration = findByAliases(agents, agentNames.integration, aliases.integration);
  const ba = findByAliases(agents, agentNames.ba, aliases.ba);
  const sd = findByAliases(agents, agentNames.sd, aliases.sd);

  const stamp = new Date().toISOString().slice(11, 19);
  const ctoProgram = await createIssue(company.id, {
    title: `Demo program ${stamp}: deliver self-service support flow`,
    description: "Small orchestration demo seeded by script.",
    assigneeAgentId: cto.id,
    status: "in_progress",
    priority: "high",
  });

  const engineeringTrack = await createIssue(company.id, {
    parentId: ctoProgram.id,
    title: "Engineering track: deliver internal support workspace",
    description: "Tech Lead owns execution across FE/BE/QA/Integration.",
    assigneeAgentId: techLead.id,
    status: "in_progress",
    priority: "high",
    orchestrationPolicy: {
      delegationMode: "auto_direct_reports",
      benchmark: {
        enabled: true,
        assigneeMode: "parent_assignee",
        maxRetries: 1,
        instructions: "Validate that the leaf work product is usable end-to-end, with no broken handoff or missing acceptance criteria.",
      },
    },
  });

  const operationsTrack = await createIssue(company.id, {
    parentId: ctoProgram.id,
    title: "Operations track: validate service-desk readiness",
    description: "PM owns BA/SD readiness and service process quality.",
    assigneeAgentId: pm.id,
    status: "in_progress",
    priority: "medium",
    orchestrationPolicy: {
      delegationMode: "auto_direct_reports",
      benchmark: {
        enabled: true,
        assigneeMode: "parent_assignee",
        maxRetries: 1,
        instructions: "Check that requirements are explicit and service-desk workflow can be executed without operator clarification.",
      },
    },
  });

  const feTask = fe ? await createIssue(company.id, {
    parentId: engineeringTrack.id,
    title: "Build the request intake UI",
    description: "FE creates the operator-facing self-service intake screen.",
    assigneeAgentId: fe.id,
    status: "todo",
    priority: "high",
  }) : null;

  const beTask = be ? await createIssue(company.id, {
    parentId: engineeringTrack.id,
    title: "Implement request lifecycle API",
    description: "BE exposes request create/list/update endpoints for the UI.",
    assigneeAgentId: be.id,
    status: "todo",
    priority: "high",
  }) : null;

  const qaTask = qa ? await createIssue(company.id, {
    parentId: engineeringTrack.id,
    title: "Prepare acceptance checklist",
    description: "QA defines acceptance checks for the support flow.",
    assigneeAgentId: qa.id,
    status: "todo",
    priority: "medium",
  }) : null;

  const integrationTask = integration ? await createIssue(company.id, {
    parentId: engineeringTrack.id,
    title: "Wire FE to request lifecycle API",
    description: "Integration stitches UI and API into one working vertical slice.",
    assigneeAgentId: integration.id,
    status: "todo",
    priority: "medium",
  }) : null;

  const baTask = ba ? await createIssue(company.id, {
    parentId: operationsTrack.id,
    title: "Define support acceptance criteria",
    description: "BA turns service expectations into explicit rules.",
    assigneeAgentId: ba.id,
    status: "todo",
    priority: "medium",
  }) : null;

  const sdTask = sd ? await createIssue(company.id, {
    parentId: operationsTrack.id,
    title: "Validate service-desk handoff script",
    description: "SD checks that operator handoff is executable without ambiguity.",
    assigneeAgentId: sd.id,
    status: "todo",
    priority: "medium",
  }) : null;

  await addComment(ctoProgram.id, "CTO seeded a small demo program with engineering and operations tracks.");

  let feBenchmark1 = null;
  let feAfterFail = null;
  let feBenchmark2 = null;
  let feAfterPass = null;
  if (feTask) {
    await updateIssue(feTask.id, { status: "in_progress", comment: "FE started the intake UI." });
    await updateIssue(feTask.id, { status: "done", comment: "First FE implementation is ready for review." });
    feBenchmark1 = await findLatestBenchmarkIssue(company.id, feTask.id);
    await updateIssue(feBenchmark1.id, {
      status: "blocked",
      comment: "Benchmark failed: edge-state handling is still ambiguous, reopen for one more pass.",
    });
    feAfterFail = await getIssue(feTask.id);

    await updateIssue(feTask.id, { status: "in_progress", comment: "FE picked up the reopened task and fixed the flow." });
    await updateIssue(feTask.id, { status: "done", comment: "Second FE implementation is ready for benchmark." });
    feBenchmark2 = await findLatestBenchmarkIssue(company.id, feTask.id);
    await updateIssue(feBenchmark2.id, {
      status: "done",
      comment: "Benchmark passed: the UI is now acceptable for the demo.",
    });
    feAfterPass = await getIssue(feTask.id);
  }

  let beFinal = null;
  if (beTask) {
    await updateIssue(beTask.id, { status: "done", comment: "BE API is complete and passed manager-level review." });
    const beBenchmark = await findLatestBenchmarkIssue(company.id, beTask.id);
    await updateIssue(beBenchmark.id, { status: "done", comment: "Benchmark passed on the first run." });
    beFinal = await getIssue(beTask.id);
  }

  let baFinal = null;
  if (baTask) {
    await updateIssue(baTask.id, { status: "done", comment: "BA acceptance criteria are documented." });
    const baBenchmark = await findLatestBenchmarkIssue(company.id, baTask.id);
    await updateIssue(baBenchmark.id, { status: "done", comment: "PM benchmark passed for BA output." });
    baFinal = await getIssue(baTask.id);
  }

  const result = {
    company: { id: company.id, name: company.name },
    agents: {
      cto: cto.name,
      techLead: techLead.name,
      pm: pm.name,
      fe: fe?.name ?? null,
      be: be?.name ?? null,
      qa: qa?.name ?? null,
      integration: integration?.name ?? null,
      ba: ba?.name ?? null,
      sd: sd?.name ?? null,
    },
    issues: {
      ctoProgram: summarize(ctoProgram),
      engineeringTrack: summarize(engineeringTrack),
      operationsTrack: summarize(operationsTrack),
      feTaskInitial: feTask ? summarize(feTask) : null,
      feBenchmark1: feBenchmark1 ? summarize(feBenchmark1) : null,
      feAfterFail: feAfterFail ? summarize(feAfterFail) : null,
      feBenchmark2: feBenchmark2 ? summarize(feBenchmark2) : null,
      feAfterPass: feAfterPass ? summarize(feAfterPass) : null,
      beTask: beFinal ? summarize(beFinal) : null,
      baTask: baFinal ? summarize(baFinal) : null,
      qaTask: qaTask ? summarize(qaTask) : null,
      integrationTask: integrationTask ? summarize(integrationTask) : null,
      sdTask: sdTask ? summarize(sdTask) : null,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
