<h1 align="center">huddle60</h1>

<p align="center">
  <b>The 60-second huddle between PO, DEV and AI.</b><br>
  One sentence in. A hash-locked plan out. PRs that can’t drift.
</p>

<p align="center">
  <img alt="status: alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <img alt="protocol: AI-DLC" src="https://img.shields.io/badge/protocol-AI--DLC-5eead4">
  <img alt="infra: none" src="https://img.shields.io/badge/infra-none-7aa2f7">
  <img alt="node 22" src="https://img.shields.io/badge/node-22-339933">
</p>

```bash
npx huddle60 ui
```

**PO gõ một câu → AI soạn Epic/Story/Task → PO bấm _approve_ → DEV bấm _ready_ → agent code đúng yêu cầu đã khóa
bằng hash → ai sửa yêu cầu sau khi chốt, PR tự đỏ.**

Bỏ buổi grooming 60 phút. Thay bằng một **huddle 60 giây**.

<p align="center">
  <img src="docs/assets/huddle60-flow.svg" width="100%"
       alt="PO gõ một câu, AI đề xuất cây Epic/Story/Task, PO xác nhận, DEV làm trong IDE theo baseline, PR được kiểm tra tự động, PO nghiệm thu">
</p>

### 60 giây trông như thế nào

| Giây | Ai | Việc |
|---|---|---|
| 0–10 | **PO** | Gõ _“Lập trình login sử dụng Google OAuth”_ |
| 10–30 | **AI** | Soạn Epic → Story → Task, AC dạng Given/When/Then, câu hỏi chặn và giả định |
| 30–45 | **PO** | Trả lời một câu hỏi, bấm **create issues**, rồi **approve** Story |
| 45–60 | **DEV** | Chọn lane, bấm **ready**, bấm **context** → dán vào Copilot/Claude/Gemini trong IDE |

Từ đó trở đi, mọi PR đều phải khớp đúng phiên bản yêu cầu đã duyệt. Không còn _“AI code theo bản cũ”_.

### Vì sao developer sẽ star

- **`package-lock.json` cho yêu cầu.** Mỗi Story được chốt thành baseline có SHA-256 (RFC 8785). Issue bị sửa →
  hash lệch → check `huddle60/baseline` chuyển đỏ. Giống hệt lockfile, nhưng cho nghiệp vụ.
- **Zero infra.** Không server, không database, không SaaS. Một lệnh `npx` trên máy bạn + GitHub Actions.
- **Agent-native.** `huddle60 context --issue 15` xuất đúng baseline đã duyệt cho bất kỳ coding agent nào, kèm
  khối dán vào PR.
- **AI đề xuất, người quyết định.** Gemini không có quyền GitHub. App không có quyền hơn bạn. Mọi quyết định
  được Actions kiểm tra theo user ID và ghi vào branch bằng chứng.
- **GitHub là nguồn sự thật.** Tận dụng Issues, Projects, PR quen thuộc của repository.

### Định vị: huddle60 & AI-DLC

**huddle60** là bộ công cụ và governance engine mã nguồn mở thực thi quy trình **AI-DLC (AI Development Life Cycle)** trực tiếp trên GitHub:
- **AI-DLC** là phương pháp luận và chuẩn quy trình: AI tham gia phát triển phần mềm trong phạm vi được giao, con người định hướng và phê duyệt, mọi bước đều có bằng chứng số (evidence hash-locked).
- **huddle60** là công cụ hiện thực hóa quy trình này một cách tự nhiên nhất vào GitHub:
  - Lệnh tương tác: `/huddle60` (hỗ trợ tương thích ngược với `/ai-dlc`)
  - Nhãn phân loại: `huddle60:*` (như `huddle60:request`, `huddle60:plan-draft`...)
  - PR verification gate: status check `huddle60/baseline`
  - Bằng chứng kiểm toán: nhánh `huddle60-evidence`
  - Cấu hình chính sách: `.github/huddle60/policy.yml`

Đặc tả đầy đủ: [tài liệu kỹ thuật](docs/technical-implementation.md).

> Thấy hữu ích? Hãy **star** repo và thử trên một repo thử nghiệm. Dự án đang alpha và cần người chạy thật nhất.

## Vì sao PO và DEV sẽ thích

| | Hôm nay | Với huddle60 |
|---|---|---|
| **PO** | Ngồi viết từng ticket, AC, chia việc | Gõ _“Lập trình login sử dụng Google OAuth”_ → AI soạn cả cây công việc kèm AC. PO chỉ trả lời câu hỏi và xác nhận |
| **PO** | Không chắc DEV/AI đang làm theo phiên bản yêu cầu nào | Mỗi PR gắn baseline có hash; sửa yêu cầu sau khi chốt thì PR **tự bị chặn** |
| **DEV** | Ticket mơ hồ, hỏi đi hỏi lại | Nhận Story có AC rõ ràng; câu hỏi chặn đã được PO trả lời **trước** khi Issue được tạo |
| **DEV** | Copy yêu cầu vào agent bằng tay, dễ sót | `huddle60 context --issue 15` đưa đúng baseline vào agent trong IDE của bạn |
| **Cả team** | Merge xong vẫn không rõ “xong chưa” | Done chỉ khi PO nghiệm thu đúng build trên `main`; mọi quyết định truy vết được |

### PO thấy gì sau 30 giây?

Chạy `huddle60 ui`, gõ yêu cầu vào tab **new plan**, bấm **generate plan** (rút gọn):

> ## Kế hoạch đề xuất (revision 1)
> Đăng nhập bằng Google OAuth cho ứng dụng web.
>
> - **Epic** `epic-auth`: Xác thực người dùng bằng Google OAuth
>   - **Story** `story-login`: Đăng nhập bằng tài khoản Google
>     - AC-01: Given tài khoản Google hợp lệ When đăng nhập Then vào trang chính
>     - AC-02: Given người dùng hủy cấp quyền When đăng nhập Then thấy thông báo lỗi phù hợp
>     - **Task** `task-oauth-setup`: Cấu hình Google OAuth Client
>     - **Task** `task-login-ui`: Giao diện đăng nhập _(blocked by task-oauth-setup)_
>   - **Story** `story-logout`: Đăng xuất
>
> **Câu hỏi khác:** Có cần lưu session vào cookie không?

PO bấm **create 5 issues** → Issues được tạo, liên kết cha–con và nằm sẵn trên Project board. Chưa đồng ý → gõ một dòng
vào ô **refine**, AI soạn lại. Có câu hỏi chặn thì nút tạo bị khóa đến khi PO trả lời.

**Trạng thái: alpha, cần cộng đồng kiểm thử.** Logic được kiểm thử tự động bằng fake GitHub/Gemini (105 test),
nhưng **chưa được chạy đầu-cuối trên GitHub và Gemini thật**. Xem [Giới hạn đã biết](#giới-hạn-đã-biết).

## Bắt đầu nhanh

```bash
gh auth login                          # app dùng token GitHub của chính bạn
export GEMINI_API_KEY=...              # chỉ PO cần (để soạn kế hoạch); macOS có thể lưu vào Keychain:
                                       # security add-generic-password -s huddle60-gemini -a $USER -w
npx huddle60 ui --repo owner/name
```

App mở trình duyệt tại `http://127.0.0.1:4317/#token=…`:

- **work items**: mọi Epic/Story/Task đang mở, trạng thái _chờ PO duyệt → chờ DEV ready → đang làm_, cảnh báo khi
  Issue bị sửa sau quyết định. Nút **approve / ready (lane) / accept / context** hiện theo role của bạn trong policy.
- **new plan**: mô tả nhu cầu → cây công việc, câu hỏi chặn, giả định → refine → tạo Issues.
- **activity**: lệnh đã gửi và phản hồi của GitHub Actions.

Mỗi nút chỉ đăng một comment `/huddle60 …` **bằng tài khoản của bạn**; GitHub Actions kiểm tra role, hash, phụ thuộc rồi
ghi bằng chứng. App không có quyền gì hơn bạn và không tự quyết thay ai.

Bảo mật app: chỉ nghe `127.0.0.1`, token phiên ngẫu nhiên mỗi lần chạy, kiểm tra `Host`/`Origin` (chống DNS rebinding,
CSRF), CSP chặt, không dựng HTML từ dữ liệu.

## Cách hoạt động

```mermaid
flowchart LR
    PO[PO] -->|huddle60 ui| L[Local app<br/>127.0.0.1]
    DEV[DEV] -->|huddle60 ui / context| L
    L <-->|structured JSON| G[Gemini API]
    L -->|Issues + comment /huddle60<br/>bằng token của user| GH[GitHub Issues/Projects]
    GH -->|issue_comment| A[GitHub Action<br/>baseline/approve/ready/accept]
    A -->|evidence + phản hồi| GH
    DEV --> PR[Pull Request]
    A -->|status huddle60/baseline| PR
```

| Thành phần | Chạy ở đâu | Làm gì |
|---|---|---|
| **Local app** (`src/app`, `ui/`) | Máy PO/DEV (`huddle60 ui`) | Soạn kế hoạch với Gemini, tạo cây Issues, nút approve/ready/accept, context cho IDE agent |
| **Workflow gates** (`src/workflow`) | GitHub Actions (`action.yml`) | Baseline có hash, quyết định PO/DEV, check `huddle60/baseline` cho PR, nghiệm thu build |
| **CLI** (`src/entry/cli.ts`) | Máy DEV | `context` cho IDE agent, `init`, kiểm tra policy, thử planner |
| **Lõi** (`src/core`) | Dùng chung | Hash canonical (RFC 8785), parser, schema kế hoạch, kiểm tra quyết định — không phụ thuộc mạng |

Nguyên tắc: **AI đề xuất, con người quyết định.** Gemini không có quyền gọi GitHub; mọi quyết định được GitHub Actions
kiểm tra theo GitHub user ID trong `.github/huddle60/policy.yml`. Thiết kế đầy đủ:
[tài liệu kỹ thuật](docs/technical-implementation.md).

## Luồng sử dụng

1. **PO** mở `huddle60 ui` → **new plan**, gõ: _“Xây dựng tính năng đăng nhập Google OAuth”_ → trả lời câu hỏi chặn → **create issues**.
2. PO và DEV chỉnh nội dung Story trên GitHub nếu cần. Khi Story đã rõ: PO bấm **approve** (chốt đúng nội dung hiện tại).
3. DEV chọn lane và bấm **ready**. Task kế thừa approve của Story cha.
4. DEV bấm **context** (hoặc chạy CLI) để đưa baseline vào IDE agent, rồi mở PR kèm khối Huddle60 trong context:
   ```bash
   npx huddle60 context --issue 15
   ```
5. Sau khi merge và build trên `main` thành công, PO bấm **accept**, chọn build → Issue được đóng.

Không dùng app vẫn được: mọi nút tương ứng một lệnh comment bên dưới.

### Các lệnh qua GitHub Comment (xử lý bởi GitHub Action)

| Lệnh | Vai trò | Tác dụng |
|---|---|---|
| `/huddle60 baseline` | PO, DEV | Chụp snapshot yêu cầu của Issue, tính hash SHA-256 |
| `/huddle60 approve baseline=<id> hash=<h>` | PO | Duyệt nghiệp vụ của Story (Task kế thừa duyệt của Story cha) |
| `/huddle60 ready baseline=<id> hash=<h> lane=<fast\|standard\|strict>` | DEV | Xác nhận sẵn sàng code, sinh khối trace cho PR |
| `/huddle60 accept baseline=<id> run=<run_id> commit=<sha>` | PO | Nghiệm thu Story/Epic trên build thành công của branch `main`, đóng Issue |
| `/huddle60 revoke decision=<id> reason="..."` | Tác giả hoặc cùng role | Thu hồi quyết định đã ban hành |

*Lưu ý: Lệnh phải nằm ở **dòng đầu tiên** của comment (tiền tố `/huddle60`). Mọi quyết định đều được kiểm tra tính hợp lệ và ghi vào nhánh bằng chứng `huddle60-evidence`.*

## Phát triển

Yêu cầu: Node.js 22.

```bash
npm ci
npm run check      # typecheck + test + format
npm run build      # dist/action.js, dist/cli.js
```

Chạy app với dữ liệu thật từ mã nguồn: `npm run build && node dist/cli.js ui --repo owner/name`.

Thử planner với Gemini thật mà không cần GitHub (tốn quota của bạn):

```bash
GEMINI_API_KEY=... node dist/cli.js plan-preview "Xây dựng tính năng đăng nhập Google OAuth"
```

### Cấu trúc

```text
src/core/        Lõi thuần: canonical hash, policy, command, issue form, plan, baseline, decision, render
src/app/         Local app: LocalApp (plan, items, decisions), HTTP server bảo vệ bằng token/Host/Origin
ui/              Giao diện tĩnh (HTML/CSS/JS thuần, không build step)
src/planner/     Prompt, generatePlan, IssueTreeCreator
src/workflow/    WorkflowService (baseline, approve, ready, accept, revoke, PR gate), agent context
src/adapters/    GitHub (Octokit), evidence branch, Gemini, in-memory
src/entry/       action, cli
templates/       Tệp cho repository áp dụng: Issue forms, policy, workflow, PR template, AGENTS.md
tests/           Unit + kịch bản đầu-cuối với FakeGitHub/FakeModel
```

## Cài đặt vào một repository

> Thử trên **repository kiểm thử** trước. Cách mặc định (local app + Actions) không cần Google Cloud hay bất kỳ server nào.

1. **GitHub App** để Actions ghi bằng chứng (Organization settings → Developer settings → GitHub Apps):
   - Repository permissions: Contents **RW**, Issues **RW**, Commit statuses **RW**, Pull requests **R**, Actions **R**, Metadata **R**.
   - Organization permissions: Projects **RW** (bỏ qua nếu không dùng Project).
   - **Không cần webhook** (bỏ chọn _Active_). Tải private key; cài App vào repository.
2. **Repository áp dụng**: sao chép nội dung `templates/` vào repository (hoặc chạy `npx huddle60 init`).
3. Tạo repository variable `AI_DLC_APP_ID` và secret `AI_DLC_APP_PRIVATE_KEY`.
4. Tạo labels và evidence branch: `npx huddle60 init --repo owner/name`, rồi tạo ruleset chặn
   force-push/xóa cho branch `huddle60-evidence` và chỉ cho App ghi.
5. Ruleset cho `main`: bắt buộc PR, review, CODEOWNERS cho `.github/**`, required status check `huddle60/baseline`.
6. Trong Project: **tắt** workflow tự chuyển Done khi Issue đóng hoặc PR merge.
7. Mỗi PO/DEV: `gh auth login`, rồi `npx huddle60 ui`.

## Giới hạn đã biết

- Local app: bản nháp kế hoạch chỉ nằm trong bộ nhớ của tiến trình; tắt app trước khi tạo Issues thì phải soạn lại.
  Chỉ hỗ trợ github.com (chưa GHES). Mỗi PO cần Gemini key riêng hoặc key do tổ chức cấp.
- API **sub-issues** và **Projects v2** phụ thuộc gói/quyền GitHub; khi không khả dụng, Issue vẫn được tạo và tham chiếu
  cha trong nội dung, lỗi được ghi trong comment kết quả.
- Sửa Issue sau baseline chỉ bị phát hiện khi PR có sự kiện mới (push, sửa mô tả); chưa có reconciler định kỳ.
- Chưa hỗ trợ merge queue (`merge_group`), Issue và code ở hai repository khác nhau, hoặc nghiệm thu trên preview PR.
- Planner chỉ đọc nội dung Request Issue; không đọc mã nguồn.
- **Chưa chọn giấy phép.** Chủ dự án cần thêm `LICENSE` trước khi công bố để người khác được phép đóng góp và sử dụng.

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md). Báo lỗ hổng bảo mật theo [SECURITY.md](SECURITY.md), không đăng công khai.
