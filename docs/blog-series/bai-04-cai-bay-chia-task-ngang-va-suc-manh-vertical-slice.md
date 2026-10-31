# Bài 4: Cái Bẫy Chia Task Theo Chiều Ngang Và Sức Mạnh Giải Phóng Của "Lát Cắt Dọc" (Vertical Slice)

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Một câu chuyện chia task kinh điển trên bảng Kanban

Mở bất kỳ bảng Jira hay Trello của một dự án Agile thông thường, bạn sẽ thấy tính năng *"Đăng nhập bằng Google"* bị băm nhỏ ra thành 4 hoặc 5 task con như thế này:
- Task 1: `[BE] Tạo migration bảng users và thêm cột google_id`
- Task 2: `[BE] Viết API POST /auth/google-login`
- Task 3: `[FE] Thiết kế giao diện nút bấm Google và màn hình chờ`
- Task 4: `[FE] Đảm bảo responsive trên mobile và tablet`
- Task 5: `[QA] Viết testcase và kiểm thử giao diện`

Cách chia việc này được gọi là **Chia task theo chiều ngang (Horizontal Slicing)** — nghĩa là cắt lát một tính năng theo các tầng công nghệ (Database, Backend API, Frontend UI, Styling).

Cách làm này ra đời từ 15-20 năm trước, thời kỳ mà một công ty thường có các đội nhóm chuyên môn hóa riêng biệt: Đội Database Administrator (DBA), đội Backend Java, đội Frontend cắt HTML/CSS, và đội QA ngồi test bằng tay.

Nhưng trong kỷ nguyên AI hiện nay, **đây chính là kẻ giết chết tốc độ giao hàng số một của mọi startup!**

---

## 2. Tại sao chia task ngang lại biến AI Coding Agent thành thảm họa?

Khi bạn bảo một con AI Agent (như Cursor, Claude Code, hay Copilot Workspace) làm Task 2: *"Viết API POST /auth/google-login"*:
1. **Mù ngữ cảnh (Context Blindness):** Con AI backend không hề biết giao diện frontend cần những trường dữ liệu gì, thông báo lỗi hiển thị ra sao. Nó chỉ đoán mò và sinh ra một API chung chung.
2. **Pull Request chết lâm sàng (Untestable PRs):** Bạn tạo một PR cho Task 2. PR này chỉ có code API. Bạn không thể bấm thử trên trình duyệt vì chưa có giao diện. Bạn không thể release cho người dùng. Nó nằm chết dí ở cột "Code Review" hoặc "In QA" cả tuần trời.
3. **Cơn ác mộng tích hợp (Integration Hell):** Đến ngày thứ 5, bạn làm Task 3 (Giao diện). Bạn phát hiện ra API backend hôm trước viết thiếu trường `avatar_url` và trả về mã lỗi không khớp với thư viện frontend. Thế là lại mở Task 2 ra sửa lại. Code xung đột (merge conflicts) xuất hiện khắp nơi.
4. **Phân mảnh sự tập trung:** Một tính năng bé xíu nhưng bạn phải tạo 5 branch git, mở 5 pull request, họp sync 3 lần. 

Bạn biến một việc đáng lẽ chỉ mất 30 phút thành một dự án kéo dài nửa tháng!

---

## 3. Bản chất của AI: AI là Full-stack Kỹ sư mặc định!

Một điều mà nhiều kỹ sư thế hệ cũ chưa kịp nhận ra: **AI không có sự phân biệt ranh giới giữa Frontend và Backend.**

Con người chúng ta có giới hạn về nhận thức: Một bạn học chuyên sâu React có thể ngại đụng vào SQL migration; một bạn chuyên viên PostgreSQL có thể sợ viết CSS Tailwind. Vì vậy con người mới chia việc theo tầng.

Nhưng AI thì khác:
- Nó hiểu cú pháp của Prisma ORM hay SQL migration tốt như nhau.
- Nó viết controller Fastify/Express trong chớp mắt.
- Nó sinh component React/Vue mượt mà không kém một frontend kỳ cựu.
- Và quan trọng nhất: **Nó có thể nhìn thấy toàn bộ chuỗi mắt xích từ nút bấm của người dùng đến câu lệnh lưu vào ổ đĩa trong cùng một ngữ cảnh duy nhất.**

Khi bạn ép AI làm một task ngang vụn vặt, bạn đang tước bỏ sức mạnh lớn nhất của nó: **Khả năng tư duy end-to-end trên toàn bộ hệ thống!**

---

## 4. Mô hình Lát Cắt Dọc (Vertical Slice): Tư duy của thời đại mới

Thay vì cắt bánh theo chiều ngang (tách rời kem, bánh bông lan và mứt), hãy **cắt một lát dọc từ trên xuống dưới**.

```
MÔ HÌNH TRUYỀN THỐNG (Horizontal - CHẬM):
┌───────────────────────────────────────────────┐
│ [FE Task] Chỉ làm giao diện (Không test được) │
├───────────────────────────────────────────────┤
│ [BE Task] Chỉ làm API (Không có giao diện)    │
├───────────────────────────────────────────────┤
│ [DB Task] Chỉ tạo bảng (Chưa ai dùng đến)     │
└───────────────────────────────────────────────┘

MÔ HÌNH VERTICAL SLICE (Thời AI - SIÊU TỐC):
┌───────┬───────┬───────┐
│ Lát 1 │ Lát 2 │ Lát 3 │
│  UI   │  UI   │  UI   │   -> Mỗi lát cắt (Story) chứa đủ UI + API + DB.
│  API  │  API  │  API  │   -> Có thể test độc lập, merge vào main 
│  DB   │  DB   │  DB   │      và release ngay cho người dùng!
└───────┴───────┴───────┘
```

Trong tư duy Lát cắt dọc:
- **Một Story là một đơn vị giá trị hoàn chỉnh:** Một Story giải quyết trọn vẹn một kịch bản người dùng (User Scenario). Ví dụ: *"Người dùng đăng nhập lần đầu bằng Google và lưu hồ sơ thành công"*.
- **1 Pull Request duy nhất:** PR đó chứa:
  - File migration tạo bảng.
  - Route API xác thực.
  - Component giao diện trên web/mobile.
  - **Và bộ bài kiểm thử tự động (Unit & Integration tests) chứng minh toàn bộ luồng đó chạy thông suốt.**
- **Merge là xong (Ship or Revert):** Khi PR đó được merge vào nhánh chính, tính năng đó đã hoạt động 100%. Không có chuyện *"Code xong backend rồi, chờ frontend làm tiếp ở sprint sau"*.

---

## 5. Quy tắc vàng cho AI Planner: "Directly Actionable Stories"

Khi tôi thiết kế thuật toán phân rã kế hoạch (Planner Prompt) cho Huddle60 để team mình sử dụng, tôi đặt ra một nguyên tắc bất di bất dịch cho AI:

> **Quy tắc Story Trực Diện (Directly Actionable Stories):**
> Nếu yêu cầu của PO là một tính năng gắn kết, khép kín (như một màn hình chào mừng, thêm nút xuất file Excel, hay form đổi mật khẩu), AI **TUYỆT ĐỐI KHÔNG ĐƯỢC PHÉP SINH RA CÁC TASK CON VỤN VẶT**.
> 
> Nghiêm cấm sinh các task thừa thãi kiểu: *"Tạo giao diện"*, *"Đảm bảo responsive"*, *"Viết unit test"*, *"Tối ưu hiệu năng"*. Tất cả những tiêu chuẩn chất lượng đó phải thuộc về chính bộ tiêu chí nghiệm thu (Acceptance Criteria) nằm ngay bên trong Story đó.

Chỉ chia nhỏ thành các task con khi và chỉ khi tính năng đó chứa **nhiều kịch bản người dùng thực sự độc lập với nhau** (ví dụ: Task A làm luồng đăng nhập bình thường; Task B làm luồng khôi phục khi quên mật khẩu).

---

## 6. Kết quả: Tốc độ tăng tốc thực sự

Khi chuyển từ chia task ngang sang Lát cắt dọc:
- **Số lượng Pull Request giảm 60%**, nhưng chất lượng mỗi PR tăng gấp bội.
- **Thời gian tích hợp giảm về 0**, vì không còn tình trạng code chờ nhau.
- **AI Coding Agent phát huy 100% công lực:** Khi bạn dán đặc tả của một Vertical Slice vào Cursor, con AI sẽ tự động tạo migration, viết route, vẽ component và viết file test tương ứng chỉ trong 1 phiên làm việc.

Bạn không còn quản lý một mớ hỗn độn các mảnh ghép rời rạc. Bạn đang vận hành một dây chuyền sản xuất những chiếc xe hoàn chỉnh nối đuôi nhau rời xưởng.

*Ở Bài 5, chúng ta sẽ trả lời một câu hỏi kiến trúc hóc búa nhất của các CTO thời AI: Tại sao Monorepo lại đang đánh bại Multi-repo một cách áp đảo trong kỷ nguyên của các AI Coding Agent?*

