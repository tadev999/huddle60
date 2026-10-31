# Bài 8: Giới Thiệu Huddle60 — Công Cụ Nhỏ Tôi Viết Cho Team Để Vận Hành AI-DLC Trên GitHub

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Huddle60 là gì và tại sao tôi viết nó?

Trong 7 bài viết trước, chúng ta đã cùng nhau mổ xẻ những nút thắt lớn nhất kìm hãm tốc độ giao hàng của các startup thời AI:
- Sự lệch pha trong giao tiếp giữa PO và DEV.
- Căn bệnh chia task theo tầng ngang thay vì Lát cắt dọc (Vertical Slice).
- Cơn ác mộng quản lý đa repo và sự phân mảnh công cụ quản lý.
- Hiểm họa sửa trộm yêu cầu làm trôi dạt ngữ cảnh của AI Coding Agent.

Từ chính những va vấp thực tế đó trong công việc hàng ngày, tôi quyết định tự tay phát triển một công cụ nhỏ cho anh em trong team của mình mang tên **Huddle60**.

Nói một cách mộc mạc: **Huddle60 là một công cụ hỗ trợ quy trình AI-DLC (AI Development Life Cycle) cực kỳ tinh gọn, chạy trực tiếp trên GitHub repository của bạn.**

Mục tiêu của tôi khi viết nó rất đơn giản: Giúp bạn Product Owner và bạn Developer trong team tôi có một "tiếng nói chung", phối hợp nhịp nhàng với các AI Coding Agent (Cursor, Claude Code, Copilot) theo một quy trình kỷ luật, rõ ràng và có thể kiểm chứng bằng mã băm mà không cần phải họp hành triền miên.

```
       PO (Nghiệp vụ)
             │  (Hội ý 60 giây, link tài liệu, ảnh mockup)
             ▼
      ┌───────────────┐
      │   HUDDLE60    │ ◄─── Đọc hiểu Codebase & Lập kế hoạch AI (Gemini Flash)
      └───────────────┘
             │  (Khóa Hash-Lock SHA-256 & Bàn giao Context)
             ▼
      DEV & AI Coding Agent (Cursor / Claude Code)
             │  (Viết code Full-stack + Test AC tự động)
             ▼
     GitHub Actions Gate (Kiểm định PR bất biến & Đóng Issue tự động)
```

---

## 2. Các Trụ Cột Tính Năng Cốt Lõi Của Huddle60

Khi làm cho team mình dùng, tiêu chí đầu tiên của tôi là: **Phải nhẹ, phải nhanh, và không được tạo thêm gánh nặng vận hành.** Vì thế, Huddle60 xoay quanh 4 trụ cột thực dụng:

### Trụ cột 1: Giao diện Web siêu tốc (Zero-Build Vanilla Web UI)
Khác với những ứng dụng web cồng kềnh ngốn hàng trăm megabyte RAM, giao diện của Huddle60 được xây dựng bằng **Vanilla JavaScript chuẩn ES Module thuần túy**:
- Không cần build step, không Webpack/Vite phức tạp, khởi động trong 10 mili-giây.
- Hỗ trợ mô hình đa không gian làm việc (Multi-tenant) qua subdomain (ví dụ: `tadev999.localhost:4317` hoặc `myteam.localhost:4317`).
- Chuyển đổi giữa các repository trên GitHub chỉ bằng một cú click chuột.

### Trụ cột 2: Phân quyền minh bạch dựa trên Git (Git-Native RBAC)
Ai là PO? Ai là DEV? Ai là Maintainer? 
Không cần cấu hình bảng phân quyền phức tạp trong database. Mọi quyền hạn được tôi quy định minh bạch trong tệp `.github/huddle60/policy.yml` ngay trên kho code của dự án:
- **Product Owner (`po`):** Chỉ PO mới có quyền bấm **Approve** (Duyệt kế hoạch) và bấm **Accept** (Nghiệm thu đóng Issue).
- **Developer (`dev`):** Chỉ DEV mới có quyền chọn luồng (**Lane: fast / standard / strict**), bấm **Ready** và chỉnh sửa đặc tả kỹ thuật.
- **Maintainer (`maintainer`):** Quản trị viên phân quyền thành viên và thiết lập hạ tầng CI/CD.

### Trụ cột 3: AI Codebase-Aware Planner (Hỗ trợ bởi Gemini Flash)
Huddle60 tích hợp sẵn adapter kết nối với **Gemini 2.5 Flash / 3.8 Flash** của Google:
- Hoàn toàn miễn phí hạn ngạch lên đến **1.500 lượt lập kế hoạch mỗi ngày** (quá thừa cho nhu cầu của một team).
- Tự động đọc lướt cây thư mục repo, `package.json`, `README.md` để hiểu sâu dự án trước khi sinh kế hoạch.
- Tự động chuyển đổi mọi đề bài thành **Acceptance Criteria (AC) dạng Given/When/Then** chuẩn mực.

### Trụ cột 4: Cổng kiểm định tự động trên GitHub Actions (PR Verification Gate)
Một template GitHub Actions được cài sẵn vào thư mục `.github/workflows/huddle60.yml`:
- Tự động kích hoạt khi có Pull Request mở ra.
- Đối chiếu mã băm trong PR với nhánh bằng chứng `huddle60-evidence`.
- Tự động bật đèn xanh cho merge nếu code thỏa mãn đúng baseline, và tự động chặn đứng nếu phát hiện spec bị sửa đổi trái phép.

---

## 3. Khởi Chạy Huddle60 Trong Vòng 2 Phút

Bạn không cần cài đặt cơ sở dữ liệu. Bạn chỉ cần có Node.js trên máy tính:

### Bước 1: Khởi tạo hạ tầng Huddle60 cho Repository của bạn
Đứng tại thư mục dự án của bạn và chạy lệnh:

```bash
npx huddle60 init
```

Lệnh này sẽ tự động tạo tệp chính sách `.github/huddle60/policy.yml` và workflow `.github/workflows/huddle60.yml` trên repo của bạn.

### Bước 2: Bật giao diện điều phối
Chạy lệnh khởi động:

```bash
npx huddle60 ui
```

Hệ thống sẽ tự động mở trình duyệt tại địa chỉ `http://localhost:4317`. 

*Mẹo nhỏ:* Nếu trên máy bạn đã cài sẵn GitHub CLI (`gh`), Huddle60 sẽ tự động nhận diện và kết nối với tài khoản GitHub của bạn qua 1 cú click **"Tự động kết nối từ GitHub CLI"** mà bạn không cần phải tự tạo hay dán Personal Access Token (PAT) thủ công!

---

## 4. Trải Nghiệm Thực Tế Khi Chúng Tôi Sử Dụng

Khi mở tab **Lập kế hoạch**, bạn sẽ thấy một bảng điều khiển tinh gọn:
1. PO gõ tiêu đề: *"Thêm chức năng lọc đơn hàng theo trạng thái thanh toán"*.
2. PO gõ vài dòng mô tả yêu cầu, dán link Figma hoặc đính kèm ảnh mockup/tài liệu spec nếu có.
3. Bấm **Tạo kế hoạch**.
4. Chỉ sau vài giây, màn hình hiển thị một cấu trúc công việc hoàn chỉnh: Đúng 1 Story, các tiêu chí nghiệm thu rõ ràng, danh sách giả định kỹ thuật, và câu hỏi nếu có điểm nghiệp vụ chưa rõ.
5. Sau khi hội ý nhanh dưới 60 giây, PO bấm **Tạo Issue trên GitHub**: Toàn bộ hệ thống issue được sinh ra trên GitHub repository ngay tức thì.

---

## 5. Một Dự Án Cá Nhân Cho Team — Chia Sẻ Mở Để Bạn Cần Thì Dùng Và Góp Ý Giúp Tôi

Tôi không định vị Huddle60 là một sản phẩm thương mại to tát hay một nền tảng SaaS quy mô lớn. 

Thành thật mà nói, **đây đơn thuần là một công cụ do tôi tự viết để giải quyết đúng những cơn đau đầu hàng ngày của team mình**: Muốn làm việc nhanh hơn, muốn anh em đỡ mệt mỏi vì họp hành, muốn PO và DEV không còn cảnh cãi cọ vì hiểu sai ý, và muốn tận dụng tối đa năng lực của AI trong IDE.

Nhưng vì thấy nó thực sự giúp công việc của team tôi trôi chảy hơn rất nhiều, tôi quyết định để toàn bộ mã nguồn ở dạng mở (Open Source 100%) trên GitHub, với tinh thần chia sẻ mộc mạc:

- **Nếu bạn hoặc team của bạn cũng đang gặp những vấn đề tương tự:** Cứ thoải mái lấy Huddle60 về dùng thử cho dự án của bạn xem có cải thiện được phần nào không. Nó hoàn toàn miễn phí, không thu thập dữ liệu cá nhân, không giam lỏng dữ liệu của bạn, và toàn bộ quyền kiểm soát nằm trong tay bạn trên GitHub.
- **Vì là công cụ tôi viết cho nhu cầu nội bộ, chắc chắn nó vẫn còn nhiều điểm chưa trọn vẹn:** Có những luồng nghiệp vụ tôi chưa va phải, có những trường hợp biên chưa được xử lý mượt mà. Nếu bạn dùng thử và thấy có gì chưa tiện, hoặc có ý tưởng nào hay hơn, tôi rất mong nhận được những lời khuyên, những phản hồi chân tình từ bạn qua GitHub Issue hoặc Pull Request.
- **Nếu bạn muốn mở rộng thêm:** Chẳng hạn như viết thêm adapter hỗ trợ mô hình AI khác (Claude, OpenAI, Ollama chạy local) hay thêm bộ đọc file đặc thù, tôi luôn hoan nghênh và sẵn lòng merge vào mã nguồn để cùng nhau dùng tốt hơn.

Toàn bộ mã nguồn và tài liệu của dự án được tôi để tại:  
👉 **GitHub Repository:** [https://github.com/tadev999/huddle60](https://github.com/tadev999/huddle60)

---

## 6. Lời kết

Huddle60 không sinh ra để cạnh tranh với Cursor hay Claude Code. Nó chỉ đơn giản là một chiếc cờ lê nhỏ, một vô lăng dẫn hướng giúp Cursor và Claude Code chạy đúng làn đường mà PO và DEV đã thống nhất với nhau.

Nó giúp chúng tôi giải phóng bản thân khỏi những cuộc họp hành vô bổ, để mỗi ngày đi làm đều có thể tập trung vào niềm vui thực sự: sáng tạo và mang lại giá trị cho người dùng.

*Ở Bài 9, tôi sẽ chia sẻ sâu hơn về những phần kỹ thuật bên dưới nắp capo của Huddle60: Cách chúng tôi xử lý Lập kế hoạch đa phương thức (Multimodal Planning với link Figma, file PDF/CSV) và cơ chế chuyển giao Context an toàn cho Cursor.*
