# Bài 6: Hiểm Họa "Sửa Trộm Requirement" Và Giải Pháp Khóa Cứng Bằng Mật Mã (Hash-Lock)

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Vụ án "Ai đã sửa cái ticket này?"

Hãy hình dung một kịch bản quá đỗi quen thuộc:

Thứ Ba, PO và DEV ngồi lại với nhau. PO bảo: *"Chúng ta chỉ cho phép người dùng đăng nhập bằng tài khoản Google công ty (@mycompany.com) thôi nhé"*. DEV gật đầu, về bàn mở Cursor lên code miệt mài 2 ngày, viết test đàng hoàng.

Thứ Năm, DEV mở Pull Request. Đột nhiên PO nhảy vào review và comment: *"Ủa em, hôm qua chị có vào ticket cập nhật thêm là cho phép cả email đối tác @partner.com nữa mà, sao trong code em chặn mất của chị rồi?"*

DEV mở to mắt vào xem lại ticket Jira/Notion: Quả nhiên, dòng chữ `@partner.com` nằm lù lù ở đó, nhưng ticket ghi: *"Edited 18 hours ago"*. 

DEV không hề nhận được thông báo. DEV code dựa trên một **ngữ cảnh đã chết (Stale Context)**. 
Và hậu quả là gì? 
- DEV ấm ức vì công sức 2 ngày qua bị lãng phí một phần.
- PO bực mình vì tiến độ bị chậm lại.
- Niềm tin giữa hai bên bị xói mòn.

Trong ngành phần mềm, chúng tôi gọi hiện tượng này là **Requirement Drift (Sự trôi dạt yêu cầu)** hay **Stale Baseline (Đặc tả đã hết hạn)**.

---

## 2. Trong thời đại AI, "Requirement Drift" là liều thuốc độc

Khi bạn làm việc với một con AI Agent, việc đặc tả bị thay đổi âm thầm giữa chừng còn nguy hiểm gấp 10 lần:
- AI không có linh tính của con người để nghi ngờ: *"Hình như hôm nay cái spec này khác hôm qua?"*.
- AI sẽ nuốt chửng cái spec cũ mà bạn đưa cho nó, sinh ra hàng ngàn dòng code dựa trên giả định cũ.
- Khi merge vào hệ thống, các bài test cũ vẫn xanh (vì viết theo spec cũ), nhưng trên thực tế tính năng đã bị lệch hoàn toàn so với mong muốn mới của PO.

Ở các công ty truyền thống, người ta cố gắng giải quyết bài toán này bằng... **Họp hành nhiều hơn, gửi email thông báo, hoặc bắt ký tá biên bản**. Nhưng càng họp nhiều thì càng chậm, và con người thì luôn quên!

Chúng ta không thể giải quyết một vấn đề về sự thiếu chính xác bằng những giải pháp cảm tính. Chúng ta cần **Toán học và Mật mã học**.

---

## 3. Khóa cứng yêu cầu bằng mật mã: Cơ chế Hash-Lock (RFC 8785)

Làm sao để đảm bảo rằng: **Một khi PO đã bấm DUYỆT (Approve) một yêu cầu, không một ai (kể cả chính PO, DEV hay sếp tổng) có thể âm thầm sửa đổi dù chỉ một dấu phẩy mà hệ thống không phát hiện ra?**

Đó là lúc chúng ta áp dụng cơ chế **Hash-Lock (Khóa băm)** vào quy trình phát triển:

```
[Issue Yêu cầu trên GitHub]
├── Mục tiêu (Goal)
├── Phạm vi (Scope)
├── Tiêu chí nghiệm thu (ACs)
└── Tham chiếu kỹ thuật (Links & Files)
       │
       ▼ (Chuẩn hóa thứ tự & khoảng trắng theo RFC 8785)
[JSON Canonical Form]
       │
       ▼ (Hàm băm một chiều SHA-256)
Khóa Hash: sha256:7636bca2d5d9dd0deccceb067a67016f4774c81b5a8ccb707f08a05367a7ef77
```

Nguyên lý hoạt động vô cùng đơn giản nhưng uy lực tuyệt đối:
1. **Chuẩn hóa (Canonicalization - RFC 8785):** Toàn bộ nội dung yêu cầu nghiệp vụ (bỏ qua những phần trang trí không liên quan) được chuẩn hóa để đảm bảo dù bạn có đổi dấu xuống dòng từ Windows sang Mac/Linux thì dữ liệu cốt lõi vẫn không đổi.
2. **Tạo mã băm SHA-256:** Chuỗi văn bản được đưa qua hàm băm SHA-256 để tạo thành một "dấu vân tay số" độc nhất vô nhị dài 64 ký tự.
3. **Đóng băng Baseline:** Khi PO bấm **Approve**, con bot sẽ lưu dấu vân tay này kèm theo phiên bản snapshot vào một nhánh Git độc lập (`huddle60-evidence`).

---

## 4. Chiếc "Cổng gác" tự động trên Pull Request

Bây giờ, hãy xem chiếc khóa này bảo vệ bạn như thế nào khi lập trình:

Khi DEV bấm nút lấy ngữ cảnh (Context) trên Huddle60 để dán vào Cursor/Claude Code, hệ thống sẽ tự động đính kèm một khối mã bảo vệ gọi là **PR Block**:

```text
<!-- BEGIN HUDDLE60 -->
issue: 9
baseline: bl-9-e188424e
hash: sha256:7636bca2d5d9dd0deccceb067a67016f4774c81b5a8ccb707f08a05367a7ef77
criteria: AC-01, AC-02, AC-03
<!-- END HUDDLE60 -->
```

Khi DEV mở Pull Request trên GitHub:
1. GitHub Actions runner tự động thức dậy, đọc lấy mã băm trong khối PR Block.
2. Nó quay lại kiểm tra Issue trên GitHub xem nội dung hiện tại có băm ra đúng cái mã đó không:
   - **Kịch bản A (Mọi thứ toàn vẹn):** Mã băm khớp 100%. GitHub Actions cấp ngay tích xanh `huddle60/baseline: success`. Cho phép merge!
   - **Kịch bản B (Có ai đó vừa sửa trộm Issue):** Dù chỉ thêm một dấu chấm hoặc sửa một chữ `@partner.com`, mã băm mới sẽ khác hoàn toàn mã băm cũ. GitHub Actions lập tức báo đỏ rực: 
     > `Check Status: FAILURE (E_STALE) — Issue đã bị thay đổi sau khi chốt baseline. Chặn merge code!`

Không cần cãi vã, không cần đổ lỗi. Hệ thống tự động ngăn chặn việc đưa code sai lệch vào nhánh chính trước khi nó kịp gây ra thảm họa!

---

## 5. Nếu PO thực sự muốn thay đổi yêu cầu thì sao?

Phần mềm là sống động, và yêu cầu nghiệp vụ đổi thay là chuyện bình thường. Nhưng trong văn hóa AI-DLC: **Bạn được quyền thay đổi, nhưng bạn phải thay đổi một cách minh bạch và có trách nhiệm.**

Nếu PO muốn thêm email `@partner.com`:
1. PO không được sửa lén. PO cập nhật lại yêu cầu.
2. Trạng thái Issue lập tức chuyển sang báo vàng: `Changed after decision` (Đã thay đổi sau khi duyệt).
3. Nút **Approve** xuất hiện trở lại để PO bấm duyệt lại phiên bản mới (Revision 2), sinh ra một mã băm mới.
4. DEV nhìn thấy mã băm mới, biết rằng yêu cầu đã đổi, bấm lấy lại Context mới cho AI cập nhật code.

---

## 6. Sự bình an trong tâm trí của người kỹ sư

Sau 17 năm làm phần mềm, tôi nhận ra thứ quý giá nhất của một kỹ sư không phải là mức lương, mà là **Sự bình an trong tâm trí (Peace of mind)**:
- Bạn ngủ ngon vì biết code của mình viết đúng 100% theo những gì đã được thỏa thuận.
- PO ngủ ngon vì biết lập trình viên không tự ý bỏ sót bất kỳ tiêu chí nghiệm thu nào.
- Và toàn bộ lịch sử thay đổi được lưu trữ bất biến trên Git, sẵn sàng cho mọi cuộc kiểm toán minh bạch nhất.

*Ở Bài 7, chúng ta sẽ tìm hiểu về triết lý "Zero-Database" — Bí quyết giúp một hệ sinh thái quản lý quy trình chạy mượt mà ngay trên hạ tầng GitHub sẵn có mà không cần tốn một xu duy trì cơ sở dữ liệu.*

