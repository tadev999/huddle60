# Hướng dẫn cho AI Coding Agent (AI Engineering Standard)

1. **Trước khi code, lấy baseline đã chốt:**
   - Chạy `npx huddle60 context --issue <số>` (hoặc DEV dán nội dung từ nút **context** trong `huddle60 ui`).
   - Chỉ làm theo nội dung trong đầu ra. Nếu lệnh báo chưa `ready` hoặc có cảnh báo `WARNING`, dừng lại và hỏi DEV/PO.
2. **Triển khai lát cắt dọc có thể kiểm thử (Vertical Testable Slice):**
   - Không chia rẽ tầng công nghệ: Bạn chịu trách nhiệm hiện thực hóa tính năng hoàn chỉnh xuyên suốt từ giao diện (UI), xử lý logic/API cho đến cơ sở dữ liệu.
   - **Bắt buộc viết hoặc cập nhật bài kiểm thử tự động (Unit / Integration / E2E):** Gắn mã AC vào tên test, ví dụ `[AC-01] từ chối mật khẩu sai` hoặc `test('AC-02: redirect to dashboard on success')`.
   - Mọi tiêu chí Given/When/Then trong Baseline phải có test chứng minh chạy thành công.
3. **Phạm vi thay đổi mã nguồn:**
   - Chỉ sửa file trong phạm vi tính năng được giao. Không sửa `.github/`, `AGENTS.md` hoặc policy trừ khi Task yêu cầu rõ.
4. **Mô tả Pull Request (PR):**
   - Mô tả PR bắt buộc phải chứa khối `<!-- huddle60:begin -->` do lệnh `context` sinh ra để vượt qua gate kiểm toán.
   - Dùng `Refs #<số>` để liên kết, **không** dùng `Closes`, `Fixes`, `Resolves` (việc đóng Issue chỉ do PO nghiệm thu sau khi build trên `main` pass).
5. **Tính trung thực:**
   - Ghi rõ phần chưa kiểm tra và giả định. Tuyệt đối không bịa đặt rằng CI/test đã pass khi chưa chạy thực tế.
6. **Ranh giới quyền hạn:**
   - AI Agent tuyệt đối không tự ý chạy các lệnh phê duyệt `/huddle60 approve`, `ready`, `accept`, `create-plan` và không bấm các nút tương ứng; đó là thẩm quyền quyết định độc quyền của con người (PO & DEV).
