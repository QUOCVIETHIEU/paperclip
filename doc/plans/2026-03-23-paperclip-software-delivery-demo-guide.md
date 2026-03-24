# Paperclip Software Delivery Demo Guide

Date: 2026-03-23
Status: Draft
Audience: Board operator, workflow designer, demo operator

## 1. Mục Tiêu

Tài liệu này hướng dẫn cách demo quy trình delivery chuẩn của một công ty phần mềm trong Paperclip, dựa trên:

- Cơ cấu tổ chức chuẩn
- 8 giai đoạn delivery
- Approval gate giữa các bước quan trọng
- Cơ chế wake agent và handoff sau khi approval được duyệt

Mục tiêu của demo:

- Đi đúng quy trình
- Đúng owner ở từng giai đoạn
- Có approval trước khi qua bước tiếp theo
- Nhìn rõ output, handoff, và support flow

## 2. Cơ Cấu Tổ Chức Áp Dụng

- `CTO`
- `PM`
- `BA`
- `SD`
- `TECH LEAD`
- `DESIGNER`
- `FE`
- `BE`
- `QA`
- `DEVOPS & SECURITY`
- `INTEGRATION`

### Tuyến Điều Phối

- `CTO -> PM`
- `PM -> BA`
- `PM -> TECH LEAD`
- `TECH LEAD -> DESIGNER`
- `TECH LEAD -> FE / BE / INTEGRATION / DEVOPS & SECURITY`
- `FE / BE / INTEGRATION -> QA`
- `QA -> TECH LEAD + PM`
- `PM -> SD` sau hypercare

## 3. 8 Giai Đoạn Chuẩn

### Giai Đoạn 1. Inquiry / Opportunity Intake

- Owner: `CTO`
- Mục tiêu:
  - Nhận inquiry
  - Chốt có nhận dự án hay không
  - Chốt scope sơ bộ
  - Chỉ định `PM` làm owner delivery

### Giai Đoạn 2. Planning & Requirement Definition

- Owner: `PM`
- Producer: `BA`
- Đầu ra:
  - Requirement package
  - Scope
  - Actor
  - User Flow
  - Business Rules
  - Acceptance Criteria

### Giai Đoạn 3. Solutioning & Technical Planning

- Owner: `TECH LEAD`
- Input: Requirement package đã review
- Đầu ra:
  - Technical solution
  - Module breakdown
  - Technical dependencies
  - Technical risks
  - Dev approach

### Giai Đoạn 4. UX/UI Design

- Owner: `DESIGNER`
- Review:
  - `PM`
  - `TECH LEAD`
- Đầu ra:
  - UX Flow
  - Wireframe / UI package

### Giai Đoạn 5. Development

- Owner: `TECH LEAD`
- Executor:
  - `FE`
  - `BE`
  - `INTEGRATION`
  - `DEVOPS & SECURITY` khi cần
- Đầu ra:
  - Build/module sẵn sàng test

### Giai Đoạn 6. QA / Internal Validation

- Owner: `QA`
- Review:
  - `TECH LEAD`
  - `PM`
- Đầu ra:
  - Test report
  - Defect log
  - Regression result
  - QA sign-off nội bộ

### Giai Đoạn 7. UAT / Go-Live

- Owner: `PM`
- Support:
  - `BA`
  - `TECH LEAD`
  - `QA`
  - `SD` nếu cần
- Đầu ra:
  - UAT complete
  - Go-live complete

### Giai Đoạn 8. Hypercare / Handover / Service Desk

- Owner giai đoạn đầu: `PM`
- Owner dài hạn: `SD`
- Đầu ra:
  - Handover tài liệu
  - Known issues
  - Support flow
  - SD takeover

## 4. Approval Gates Đã Có Trong Hệ Thống

Hiện ứng dụng đã có 3 approval gate:

### 1. Requirement Package Approval

Dùng khi:

- `BA` hoàn tất requirement package
- `PM` cần approve trước khi sang Tech Lead

Nút trong issue:

- `Request Requirement Approval`

Khi approve:

- Issue requirement chuyển `done`
- Wake lại owner điều phối

### 2. UX/UI Design Approval

Dùng khi:

- `DESIGNER` hoàn tất thiết kế
- Cần approve trước khi sang dev

Nút trong issue:

- `Request UX/UI Approval`

Khi approve:

- Issue design chuyển `done`
- Wake lại owner điều phối
- Parent issue nhận summary comment

### 3. QA Exit Approval

Dùng khi:

- `QA` hoàn tất internal validation
- Cần approve trước khi sang UAT / Go-live readiness

Nút trong issue:

- `Request QA Exit Approval`

Khi approve:

- Issue QA chuyển `done`
- Wake lại owner điều phối

### Kết Quả Khi Approval Được Xử Lý

- `Approve` -> issue linked sang `done`
- `Request Revision` -> issue linked về `todo`
- `Reject` -> issue linked sang `blocked`

## 5. Quy Trình Demo Chuẩn Từ Đầu Đến Cuối

### Bước 1. CTO Nhận Dự Án

Tạo issue gốc cho `CTO`.

`CTO` cần làm:

- Chốt có nhận dự án không
- Chốt scope sơ bộ
- Giao delivery ownership cho `PM`

Kết quả mong đợi:

- Có issue/task giao xuống `PM`

### Bước 2. PM Tạo Requirement Workstream

`PM` nhận task từ `CTO`.

`PM` cần làm:

- Giao task cho `BA`
- Yêu cầu BA tạo requirement package

Kết quả mong đợi:

- Có subissue cho `BA`

### Bước 3. BA Hoàn Tất Requirement Package

`BA` xử lý issue.

Đầu ra cần có:

- Scope
- Actor
- User Flow
- Business Rules
- Acceptance Criteria

Sau khi xong:

- Bấm `Request Requirement Approval`

Người duyệt:

- `PM`

Khi approval được approve:

- Issue requirement sang `done`
- `PM` được wake lại

### Bước 4. PM Bàn Giao Sang Tech Lead

Sau khi requirement được approve, `PM` tạo hoặc giao issue cho `TECH LEAD`.

`TECH LEAD` cần làm:

- Technical solution
- Module breakdown
- Technical risks
- Dev approach

Nếu cần thiết kế:

- Giao tiếp xuống `DESIGNER`

### Bước 5. Designer Hoàn Tất UX/UI

`DESIGNER` xử lý issue design.

Đầu ra cần có:

- UX Flow
- Wireframe
- UI package

Sau khi xong:

- Bấm `Request UX/UI Approval`

Người duyệt theo nghiệp vụ thật:

- `PM`
- `TECH LEAD`

Lưu ý:

- Trong sản phẩm hiện tại approval là một gate chung, chưa tách riêng nhiều approver theo role
- Nhưng khi demo, nên trình bày đây là bước review của `PM + TECH LEAD`

Khi approval được approve:

- Issue design sang `done`
- `TECH LEAD` được wake lại
- Parent issue có summary comment

### Bước 6. Tech Lead Giao Dev

Sau khi design được approve, `TECH LEAD` mới giao xuống:

- `FE`
- `BE`
- `INTEGRATION`
- `DEVOPS & SECURITY` nếu cần

Đầu ra:

- Build/module hoàn thành
- Sẵn sàng test

### Bước 7. QA Internal Validation

`QA` nhận build/module.

`QA` cần làm:

- Test
- Log defect
- Regression
- QA sign-off nội bộ

Sau khi xong:

- Bấm `Request QA Exit Approval`

Người duyệt theo nghiệp vụ thật:

- `TECH LEAD`
- `PM`

Khi approval được approve:

- Issue QA sang `done`
- Owner điều phối được wake lại

### Bước 8. PM Điều Phối UAT / Go-Live

Sau khi QA gate qua:

- `PM` tổ chức UAT
- `BA` hỗ trợ business clarification
- `TECH LEAD` hỗ trợ lỗi kỹ thuật
- `QA` hỗ trợ test evidence

Khi UAT đạt:

- `PM` chốt Go-live

### Bước 9. Hypercare

Go-live xong chưa bàn giao ngay cho `SD`.

Phải có giai đoạn hypercare:

- `PM` theo dõi
- `TECH LEAD` hỗ trợ
- `QA / BA` hỗ trợ khi cần

### Bước 10. Handover Sang Service Desk

Khi hệ thống ổn định:

- Bàn giao tài liệu
- Bàn giao known issues
- Bàn giao support flow
- `SD` tiếp nhận chính thức

## 6. Cách Thao Tác Approval Trong Demo

### Với Issue Requirement

- Mở issue của `BA`
- Bấm `Request Requirement Approval`
- Vào trang `Approvals`
- Approve để đi tiếp

### Với Issue Design

- Mở issue của `DESIGNER`
- Bấm `Request UX/UI Approval`
- Vào trang `Approvals`
- Approve để đi tiếp

### Với Issue QA

- Mở issue của `QA`
- Bấm `Request QA Exit Approval`
- Vào trang `Approvals`
- Approve để đi tiếp

## 7. Cách Giải Thích Trong Lúc Demo

Nên giải thích theo logic này:

- Agent không được tự ý nhảy sang bước tiếp theo
- Mỗi artifact quan trọng phải qua approval gate
- Chỉ khi gate được duyệt thì owner điều phối mới được wake lại để thực hiện bước tiếp
- Điều này giúp mô phỏng đúng governance của một công ty phần mềm thật

## 8. Những Điểm Cần Nhớ Khi Demo

- `CTO` không đi sâu vào leaf task
- `PM` là owner delivery
- `BA` không làm technical solution
- `TECH LEAD` không làm thay BA
- `DESIGNER` phải qua gate trước dev
- `QA` phải qua gate trước UAT
- Không bàn giao thẳng cho `SD` ngay sau go-live
- Phải có `Hypercare`

## 9. Kịch Bản Demo Tối Thiểu Đề Xuất

Nếu muốn demo ngắn nhưng đúng quy trình, hãy đi theo chuỗi này:

1. `CTO` nhận dự án
2. `PM` giao `BA`
3. `BA` hoàn tất requirement -> `Request Requirement Approval`
4. Approve requirement
5. `PM` giao `TECH LEAD`
6. `TECH LEAD` giao `DESIGNER`
7. `DESIGNER` hoàn tất -> `Request UX/UI Approval`
8. Approve design
9. `TECH LEAD` giao `FE / BE`
10. `QA` test -> `Request QA Exit Approval`
11. Approve QA exit
12. `PM` mô tả UAT / Go-live / Hypercare / Handover sang `SD`

## 10. Trạng Thái Ứng Dụng Hiện Tại

Phần ứng dụng đã có:

- Approval type cho Requirement / Design / QA Exit
- Nút request approval trong issue detail
- Đổi trạng thái issue theo approval outcome
- Wake lại owner điều phối sau approve
- Summary comment lên parent issue

Phần tiếp theo cần làm sau tài liệu này:

- Viết lại `Prompt Template`
- Viết benchmark task cho từng role
- Chạy demo lại từ đầu với flow chuẩn
