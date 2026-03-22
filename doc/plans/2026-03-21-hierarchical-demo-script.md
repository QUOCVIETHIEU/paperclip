# Hierarchical Demo Script

Date: 2026-03-21

Script: `scripts/demo/hierarchical-orchestration-demo.mjs`

## What it does

- Reuses an existing company and org chart.
- Assumes the current org contains these agents:
  - `CTO AGENT`
  - `TECH LEAD AGENT`
  - `PM AGENT`
  - `FE AGENT`
  - `BE AGENT`
  - `QA AGENT`
  - `INTEGRATION AGENT`
  - `BA AGENT`
  - `SD AGENT`
- Creates a small CTO program issue with two manager tracks:
  - Engineering track owned by Tech Lead
  - Operations track owned by PM
- Seeds a few leaf tasks under each track.
- Simulates one benchmark failure and retry on the FE branch.
- Simulates first-pass benchmark success on the BE and BA branches.

## Run

```sh
node scripts/demo/hierarchical-orchestration-demo.mjs
```

Optional overrides:

```sh
PAPERCLIP_BASE_URL=http://127.0.0.1:3100/api \
PAPERCLIP_COMPANY_NAME="QUOC VIET Co., LTD" \
node scripts/demo/hierarchical-orchestration-demo.mjs
```

Or target by company id:

```sh
PAPERCLIP_COMPANY_ID=<uuid> node scripts/demo/hierarchical-orchestration-demo.mjs
```
