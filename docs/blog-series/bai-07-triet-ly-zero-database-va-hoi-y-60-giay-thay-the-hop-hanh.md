# Bài 7: Triết Lý "Zero-Database" Và Cuộc Hội Ý 60 Giây Thay Thế Hàng Giờ Họp Hành

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Nỗi khổ "Bội thực SaaS" của các Startup hiện đại

Có bao giờ bạn ngồi tính xem một startup công nghệ 10 người đang phải trả tiền và phân tán sự chú ý cho bao nhiêu công cụ quản lý dự án chưa?
- Jira để theo dõi ticket và sprint.
- Confluence hoặc Notion để viết tài liệu PRD.
- Slack để cãi nhau xem ai đã sửa tài liệu trên Notion.
- GitHub để lưu mã nguồn và mở Pull Request.
- Thêm một cơ sở dữ liệu PostgreSQL hoặc Redis riêng của công ty chỉ để lưu trữ trạng thái phê duyệt nội bộ.

Và kết quả của mớ bòng bong này là gì? **Sự phân mảnh của Sự Thật (Fragmentation of Truth):**
- Trên Jira thì ticket đã chuyển sang cột `Done`.
- Trên Notion thì tài liệu vẫn ghi `Draft`.
- Trong code thực tế trên GitHub thì tính năng... chưa hề được merge!
- Và để đồng bộ giữa ba nơi này, chúng ta lại đẻ ra thêm một cuộc họp: *"Daily Standup 30 phút"* và *"Sprint Retrospective 2 tiếng"* để các kỹ sư ngồi báo cáo lại những gì công cụ không tự làm được.

17 năm làm kỹ thuật đã dạy tôi một nguyên lý cốt tử: **Càng nhiều nơi lưu trữ dữ liệu, hệ thống càng dễ mục ruỗng từ bên trong.**

---

## 2. Triết lý "Zero-Database" (Không Cơ Sở Dữ Liệu Riêng) Là Gì?

Khi tôi bắt tay viết công cụ Huddle60 cho team mình, quyết định dứt khoát nhất mà tôi đưa ra là: **Tuyệt đối không dựng bất kỳ một cơ sở dữ liệu riêng biệt nào (No PostgreSQL, No MySQL, No MongoDB).**

Thay vào đó, chúng tôi tận dụng chính **GitHub** — nền tảng mà mọi lập trình viên đều tương tác hàng ngày — để làm Cơ sở dữ liệu duy nhất (Single Source of Truth):

```
┌─────────────────────────────────────────────────────────────────┐
│                      HỆ SINH THÁI GITHUB                        │
├───────────────────────┬─────────────────────────────────────────┤
│ THÀNH PHẦN GITHUB     │ ĐÓNG VAI TRÒ DỮ LIỆU                    │
├───────────────────────┼─────────────────────────────────────────┤
│ 1. GitHub Issues      │ Kho lưu trữ Yêu cầu & Đặc tả AC         │
│ 2. Issue Comments     │ Kênh truyền lệnh (/huddle60 approve...) │
│ 3. Git Tree / Branch  │ Sổ cái bằng chứng kiểm toán bất biến    │
│ 4. GitHub Actions     │ Động cơ xử lý quy tắc nghiệp vụ (CI/CD) │
│ 5. Pull Requests      │ Nơi bàn giao giá trị & cổng kiểm định   │
└───────────────────────┴─────────────────────────────────────────┘
```

Mọi trạng thái của dự án đều là những thực thể Git thuần túy:
- Khi PO duyệt yêu cầu: Hệ thống gửi comment `/huddle60 approve`.
- Khi DEV sẵn sàng nhận việc: Hệ thống gửi comment `/huddle60 ready`.
- Khi cần lưu bằng chứng kiểm toán: Bot commit một file JSON snapshot vào nhánh mồ côi `huddle60-evidence`.

### Lợi ích to lớn của Zero-Database:
1. **Chi phí vận hành bằng 0 đồng:** Bạn không cần duy trì server database, không cần lo backup dữ liệu, không lo rò rỉ cơ sở dữ liệu nội bộ.
2. **Không bao giờ lệch dữ liệu:** Yêu cầu nằm ngay trên GitHub Issue, code nằm trên GitHub PR. Không thể có chuyện code một nơi, ticket một ngả.
3. **Quyền sở hữu tuyệt đối:** Toàn bộ dữ liệu nằm 100% trong repo GitHub của công ty bạn. Bạn không bị phụ thuộc (Vendor lock-in) vào bất kỳ dịch vụ SaaS đóng kín nào.

---

## 3. Cuộc "Hội Ý 60 Giây" (The 60-Second Huddle)

Tên gọi **Huddle60** bắt nguồn từ một thuật ngữ trong bóng bầu dục Mỹ (*Huddle*): Trước mỗi đợt tấn công, toàn đội tụm lại trong vòng vài chục giây ngắn ngủi để nghe đội trưởng phổ biến đúng một chiến thuật duy nhất, rồi lập tức tản ra thực thi với tốc độ cao nhất.

Trong quy trình phát triển phần mềm thời đại AI, chúng tôi thay thế toàn bộ những buổi họp hành lê thê bằng **Cuộc hội ý 60 giây bất đồng bộ**:

```
00:00 - 00:20 (20 giây đầu): 
PO gõ yêu cầu tự nhiên vào giao diện, dán kèm link Figma/Docs hoặc ảnh phác thảo.

00:20 - 00:30 (10 giây tiếp theo): 
AI Planner tự động đọc cấu trúc Codebase hiện tại, phân tích yêu cầu 
và trả về đúng 1 Story Lát cắt dọc với các tiêu chí Given/When/Then ACs rõ ràng.

00:30 - 00:50 (20 giây tiếp theo): 
PO đọc lướt qua AC. Nếu cần chỉnh sửa gì thì phản hồi thêm 1 câu.

00:50 - 01:00 (10 giây cuối cùng): 
PO bấm "Approve" (Khóa Hash-lock) -> DEV bấm "Ready" (Nhận việc). 
Xong! Hết 60 giây!
```

---

## 4. Tại sao chúng ta có thể làm được điều đó trong 60 giây?

Ngày xưa, chúng ta phải họp lâu vì con người phải làm những việc rất mệt mỏi:
- Ngồi tự nghĩ xem cần tạo những bảng nào trong database.
- Ngồi tranh luận xem API nên trả về JSON cấu trúc ra sao.
- Ngồi chia nhỏ các task kỹ thuật cho từng người.

Ngày nay, **AI Codebase-Aware đã làm hộ chúng ta 90% khối lượng công việc nhàm chán đó trong vài giây**. 
Nó đọc hiểu codebase của bạn, nó biết bạn đang dùng Prisma hay TypeORM, nó biết bạn viết API bằng Next.js route hay Express. Nó tự giác đề xuất một cấu trúc hoàn hảo.

Con người (PO và DEV) chỉ cần giữ lại 10% phần việc quan trọng nhất: **Đưa ra quyết định kinh doanh và xác nhận tiêu chí nghiệm thu.**

---

## 5. Từ bỏ "Văn hóa Họp Hành" để bước vào "Văn hóa Giao Hàng"

Một lập trình viên kỳ cựu từng nói với tôi: *"Cách tốt nhất để hủy hoại năng lượng của một kỹ sư tài năng là bắt anh ta tham gia 3 cuộc họp mỗi ngày."*

Khi các cuộc họp bị triệt tiêu và thay thế bằng các giao thức chuẩn mực như Huddle60:
- Lập trình viên có những khối thời gian sâu (Deep Work) từ 4 đến 6 tiếng liên tục để phối hợp cùng AI sinh code chất lượng cao.
- Product Owner không bị biến thành những "thư ký ghi chép ticket" trên Jira. Họ dành trọn thời gian để nghiên cứu thị trường, nói chuyện với khách hàng và phân tích số liệu kinh doanh.
- Và sản phẩm thì liên tục được cập nhật lên môi trường chạy thật sau mỗi vài giờ đồng hồ.

*Ở Bài 8, tôi sẽ giới thiệu chi tiết về Huddle60 — công cụ nhỏ tôi viết cho team mình để vận hành quy trình AI-DLC ngay trên GitHub: Nó là gì, tôi đã làm nó như thế nào và cách bạn có thể lấy về dùng thử cho team của mình.*

