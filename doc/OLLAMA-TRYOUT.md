# Ollama Tryout

Paperclip now includes a minimal `ollama_local` adapter for local evaluation.

This adapter is intentionally lightweight:

- it reads one assigned issue
- sends compact issue context to Ollama
- posts the model response back as an issue comment
- releases the issue back to `todo`

It is meant for trying the product locally without external provider keys.
It is not a replacement for the richer coding-agent adapters.

## Prerequisites

- Paperclip running locally
- Ollama running locally
- at least one local model pulled, for example:

```sh
ollama pull qwen2.5-coder:7b
```

Verify Ollama is reachable:

```sh
curl http://127.0.0.1:11434/api/tags
```

## In The UI

Create an agent with adapter type `Ollama (local)`.

Recommended values:

- `Working directory`: absolute path to your repo or workspace
- `Model`: a model returned by Ollama, for example `qwen2.5-coder:7b`
- `Ollama base URL`: `http://127.0.0.1:11434`
- `Command`: leave blank to use `node`

Optional:

- `Instructions file`: markdown file appended to the prompt
- `Prompt template`: extra heartbeat guidance appended after issue context
- env vars such as:

```text
OLLAMA_KEEP_ALIVE=10m
OLLAMA_OPTIONS_JSON={"temperature":0.2}
```

## Behavior

When the agent is woken:

- if it has no assigned issues, it exits cleanly
- if it has an assigned issue, it posts an `Ollama trial update` comment
- it then releases the issue so the bridge does not hold the checkout lock

This is useful for testing:

- local model latency
- issue wakeups
- comment round-trip UX
- basic Paperclip orchestration without OpenAI/Anthropic keys

## Limits

`ollama_local` does not provide:

- file editing tools
- shell tools
- browser tools
- session resume across heartbeats
- automatic `done` transitions

If you want a deeper integration later, the next step would be extending this adapter with:

- richer model/base-url discovery
- structured usage accounting
- tool-capable local runtimes
