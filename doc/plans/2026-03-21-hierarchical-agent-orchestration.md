# Hierarchical Agent Orchestration

Date: 2026-03-21
Status: initial backend slice

## Goal

Nang cap Paperclip de agent co the:

- tao subtask cho cap duoi theo org chart
- tu dong tao benchmark task de danh gia ket qua
- tu reopen va giao lai cong viec khi benchmark that bai

## Slice da implement

1. `issues.orchestration_policy`
   - `delegationMode: manual | auto_direct_reports`
   - `benchmark.enabled`
   - `benchmark.assigneeMode: parent_assignee | creator_agent`
   - `benchmark.maxRetries`
   - `benchmark.instructions`

2. `issues.orchestration_state`
   - luu benchmark source issue, so lan thu benchmark, benchmark issue gan nhat, va trang thai pass/fail/pending

3. Auto delegation
   - khi manager-agent tao subtask duoi parent issue cua minh
   - neu parent issue bat `auto_direct_reports`
   - Paperclip tu chon direct report it tai nhat de assign

4. Benchmark loop
   - khi issue con chuyen sang `done`, Paperclip tao benchmark issue va dua issue nguon sang `in_review`
   - neu benchmark issue `done`, issue nguon chuyen ve `done`
   - neu benchmark issue `blocked` hoac `cancelled`, issue nguon se:
     - `todo` neu con retry
     - `blocked` neu da het retry

## Notes

- Slice nay la orchestration backend, chua them UI editor cho policy.
- Tat ca side effect di qua issue routes hien co, co activity log va wakeup assignee.
