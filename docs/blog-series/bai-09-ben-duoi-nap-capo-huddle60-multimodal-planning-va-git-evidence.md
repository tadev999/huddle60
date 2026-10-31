# Bài 9: Bên Dưới Nắp Capo Huddle60 — Multimodal Planning, Context Handover & Git Evidence

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Mở nắp capo của một công cụ thực chiến

Ở bài trước, tôi đã giới thiệu tổng quan về Huddle60 — công cụ nhỏ mà tôi viết để giải quyết bài toán vận hành thực tế cho team của mình. Nhưng với tư cách là một kỹ sư làm nghề 17 năm, điều làm tôi hứng thú nhất khi bắt tay vào làm một công cụ nội bộ không phải là vẽ ra một giao diện hào nhoáng, mà là **cách xử lý những bài toán kỹ thuật bên dưới nắp capo (Under the hood)** sao cho vừa tinh gọn, vừa tin cậy.

Trong bài viết này, tôi muốn chia sẻ chi tiết 3 giải pháp kỹ thuật cốt lõi mà tôi đã áp dụng vào Huddle60:
1. **Xử lý ngữ cảnh đa phương thức (Multimodal Planning) với link Figma, file PDF và CSV.**
2. **Cơ chế chuyển giao ngữ cảnh bảo mật cho Cursor (Context Handover & PR Block).**
3. **Sổ cái kiểm toán độc lập trên Git mà không cần database (Git Evidence Branch).**

---

## 2. Multimodal Planning: Khi AI đọc cả Link Figma, Tài liệu PDF và Bảng tính CSV

Trong thực tế làm việc ở team tôi, bạn Product Owner hiếm khi chỉ đưa ra yêu cầu bằng vài câu chữ ngắn ngủi. Bạn ấy thường gửi kèm:
- Một đường link **Figma / Miro** thiết kế màn hình.
- Một file **PDF** chứa quy chuẩn hợp đồng hoặc quy định bảo mật.
- Một file **CSV / Excel** chứa danh sách mã lỗi, bảng tính phí chiết khấu hoặc danh mục dữ liệu.
- Hoặc đơn giản là một bức ảnh chụp màn hình phác thảo ý tưởng trên bảng trắng.

Nếu công cụ lập kế hoạch AI chỉ có một ô nhập văn bản (text), PO sẽ phải ngồi copy-paste hoặc gõ lại toàn bộ những thứ đó bằng tay — vừa mất thời gian, vừa dễ sót thông tin quan trọng.

### Cách tôi xử lý luồng nạp dữ liệu đa phương thức trong Huddle60:

```
[PO nạp dữ liệu từ giao diện]
├── Text: Tiêu đề & mô tả yêu cầu
├── Links: Link Figma, Google Docs, Notion, Swagger API (Mỗi link 1 dòng)
└── Attachments: Ảnh (PNG/JPG/WebP), PDF, Bảng tính (CSV), Văn bản (MD/TXT)
       │
       ▼ (Gửi qua POST /api/plans với payload tối đa 10MB)
[Huddle60 Server Engine]
       │
       ├── Phân loại MIME Type:
       │   ├── Ảnh & PDF ──────► Đóng gói thành `inlineData` nhị phân (Binary Parts)
       │   └── CSV, JSON, TXT ──► Giải mã UTF-8 đưa vào thẻ `<attached_file>` có cấu trúc
       │
       ├── Đọc cấu trúc Codebase thực tế (File Tree, package.json, README)
       │
       ▼ (Tổng hợp thành một Multimodal Context duy nhất)
[Gemini Flash API]
       │
       ▼ (Suy luận đa phương thức & trích xuất ngữ cảnh)
[ModelPlan JSON]: Sinh ra các AC chuẩn xác đến từng trường dữ liệu!
```

### Kết quả hiển thị trên GitHub Issue:
Toàn bộ link tài liệu và file đính kèm được Huddle60 phân loại và ghi chuẩn hóa vào phần `### Tham chiếu kỹ thuật` của Issue:

```markdown
### Tham chiếu kỹ thuật

#### 🔗 Tài liệu & Liên kết tham chiếu
- Figma UI Specs: https://www.figma.com/design/...
- API Swagger: https://api.myproject.com/swagger

#### 📎 Tệp đính kèm đã phân tích
- `mockup-onboarding.png` (Hình ảnh)
- `quy-chuan-bao-mat.pdf` (Tài liệu PDF)
- `ma-loi-he-thong.csv` (Bảng tính CSV)
```

Điểm quan trọng ở đây là: **Mục Tham chiếu kỹ thuật này nằm trong diện được khóa cứng bằng mã băm (Hash-locked).** Nghĩa là một khi PO đã bấm Duyệt, không ai có thể âm thầm tráo đổi link thiết kế hay thay đổi nội dung file quy chuẩn mà không bị hệ thống phát hiện.

---

## 3. Cơ Chế "Context Handover": Chiếc Cầu Nối Giữa Yêu Cầu và Cursor/Claude Code

Một trong những vấn đề đau đầu nhất của anh em lập trình viên khi dùng Cursor hay Claude Code là: **Prompt quá sơ sài hoặc copy thiếu ngữ cảnh.**

Trong Huddle60, tôi làm một tính năng rất nhỏ nhưng cực kỳ hữu dụng cho team: nút bấm **Context**.

Khi DEV bấm nút **Context** cạnh một Story đã sẵn sàng (`Ready`), Huddle60 sẽ tự động đóng gói toàn bộ thông tin thành một payload Markdown hoàn chỉnh và sao chép vào clipboard:

```markdown
# huddle60 context for #9
Baseline `bl-9-e188424e` · lane `standard` · story

## AI Engineering Directive
- Implement this as a complete, vertical testable slice across all required layers (UI, API, Data).
- You MUST write or update automated tests verifying that all acceptance criteria below pass before submitting the PR.
- Implement only what this baseline describes. Do not run /huddle60 approve, ready or accept.

## [Story] Màn hình khảo sát thông tin cho người dùng mới

### Mục tiêu và người dùng
...

### Acceptance Criteria
- AC-01: Given... When... Then...
- AC-02: Given... When... Then...

### Tham chiếu kỹ thuật
- Link Figma: https://www.figma.com/design/...

## PR body block
```text
<!-- BEGIN HUDDLE60 -->
issue: 9
baseline: bl-9-e188424e
hash: sha256:7636bca2d5d9dd0deccceb067a67016f4774c81b5a8ccb707f08a05367a7ef77
criteria: AC-01, AC-02
<!-- END HUDDLE60 -->
```
```

Khi bạn dán khối Context này vào Cursor:
1. Con AI hiểu ngay lập tức nó là một **Full-stack Engineer làm việc trên một Lát cắt dọc (Vertical Slice)**.
2. Nó biết chính xác các tiêu chí `AC-01`, `AC-02` cần phải vượt qua.
3. Nó tự động viết code thực thi kèm theo bộ unit tests tương ứng.
4. Và khi mở PR, nó tự động dán khối `<!-- BEGIN HUDDLE60 -->` vào phần mô tả của Pull Request để kích hoạt cổng kiểm định tự động!

---

## 4. Git Evidence Branch: Sổ Cái Kiểm Toán Bất Biến

Làm sao để hệ thống ghi nhận lịch sử duyệt yêu cầu của PO mà không cần dùng cơ sở dữ liệu riêng?

Tôi đã tận dụng một kỹ thuật khá thú vị trong Git mang tên **Orphan Evidence Branch (Nhánh bằng chứng mồ côi)** mang tên `huddle60-evidence`:
- Đây là một nhánh Git chạy song song, tách biệt hoàn toàn với nhánh `main` (không chứa code của ứng dụng).
- Mỗi khi có một quyết định diễn ra (PO bấm Approve, DEV bấm Ready, PO bấm Accept), GitHub Actions bot sẽ commit một file JSON nhỏ vào nhánh này:
  - `evidence/decisions/issue-9-approve-1730350000.json`: Ghi nhận ai đã duyệt, vào thời điểm nào, mã băm tại thời điểm đó là gì.
  - `evidence/baselines/bl-9-e188424e.json`: Lưu snapshot nội dung bất biến của yêu cầu.

### Tại sao lại là Git Branch?
1. **Tính bất biến (Tamper-proof):** Lịch sử Git được liên kết bằng các chuỗi mã băm Git commit. Không ai có thể sửa lại lịch sử quá khứ mà không làm vỡ chuỗi Git tree.
2. **Tính độc lập:** Các file bằng chứng không làm rác nhánh `main` hay ảnh hưởng đến code của dự án.
3. **Khả năng kiểm toán trọn đời (Audit Trail):** Dù sau này nhìn lại dự án sau nhiều tháng, bạn chỉ cần mở nhánh `huddle60-evidence` ra là có đầy đủ bằng chứng ai đã duyệt tính năng này, duyệt trên thiết kế nào, merge bằng bản build nào.

---

## 5. Kiến Trúc Mở — Dễ Dàng Tùy Biến Thêm Theo Nhu Cầu Của Bạn

Khi bắt tay viết Huddle60 cho team, tôi cố gắng thiết kế các tầng thật tách bạch theo mô hình Ports & Adapters (Hexagonal Architecture) để sau này nếu team mình có đổi công cụ hay cần tích hợp thêm gì thì sửa rất nhẹ nhàng:

- **Giao diện `ModelPort`:** Hiện tại team tôi chủ yếu dùng **Gemini 2.5 Flash / 3.8 Flash** vì nó có quota miễn phí rất hào phóng và tốc độ suy luận cực nhanh. Nhưng nếu team của bạn quen dùng **Claude 3.5 Sonnet, GPT-4o**, hay muốn chạy một mô hình local qua **Ollama** trên máy tính riêng để bảo mật dữ liệu nội bộ, bạn hoàn toàn có thể viết thêm một Adapter mới chỉ với khoảng 30-40 dòng TypeScript.
- **Bộ phân tích tài liệu (Document Parsers):** Nếu bạn muốn hỗ trợ đọc thêm file Word `.docx`, file trình chiếu `.pptx`, hay tích hợp kéo spec từ hệ thống nội bộ của công ty bạn, kiến trúc của Huddle60 cho phép bạn cắm thêm module vào rất tự nhiên.

Tôi để toàn bộ mã nguồn mở trên GitHub để nếu anh em nào thấy có ích cho dự án của mình thì cứ thoải mái lấy về dùng, tùy biến hoặc mở rộng thêm. Và nếu bạn viết được adapter hay tính năng nào thấy hữu ích cho số đông, đừng ngần ngại gửi PR hoặc chia sẻ lại nhé. Tôi rất vui lòng được đón nhận và merge vào repo để tất cả chúng ta cùng dùng tốt hơn.

---

## 6. Sự Thanh Lịch Của Một Giải Pháp Thuần Khiết

Sau 17 năm làm nghề phần mềm, tôi nhận ra rằng một công cụ tốt cho công việc hàng ngày không nhất thiết phải là một hệ thống đồ sộ hay phức tạp. Điều quan trọng nhất là nó giải quyết đúng nút thắt, chạy ổn định, nhẹ nhàng và không làm phiền người dùng.

Huddle60 đơn giản chỉ là một công cụ nhỏ như vậy — tận dụng tối đa những gì mạnh mẽ nhất sẵn có của **Git, GitHub Actions và AI**, kết nối chúng lại bằng một giao thức rõ ràng để giúp team tôi làm việc nhẹ nhàng và hiệu quả hơn mỗi ngày.

*Ở Bài 10 — bài viết cuối cùng của series, chúng ta sẽ cùng phác họa tương lai của các đội ngũ phát triển phần mềm: Đội hình tinh gọn 1 PO + 1 DEV + Đội quân AI Agents sẽ thay đổi cách chúng ta làm sản phẩm ra sao?*
