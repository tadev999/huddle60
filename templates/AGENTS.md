# Hướng dẫn cho AI agent

1. Trước khi code, lấy baseline đã chốt:
   `npx huddle60 context --issue <số>` (hoặc DEV dán nội dung từ nút **context** trong `huddle60 ui`).
   Chỉ làm theo nội dung trong đầu ra. Nếu lệnh báo chưa ready hoặc có cảnh báo WARNING, dừng lại và hỏi DEV.
2. Chỉ sửa file trong phạm vi Task. Không sửa `.github/`, `AGENTS.md` hoặc policy trừ khi Task yêu cầu rõ.
3. Gắn mã AC vào tên test, ví dụ `[AC-01] từ chối mật khẩu sai`.
4. Mô tả PR phải chứa khối `<!-- ai-dlc:begin -->` do lệnh trên sinh ra. Dùng `Refs #<số>`,
   không dùng `Closes`, `Fixes`, `Resolves`.
5. Ghi rõ phần chưa kiểm tra và giả định. Không viết rằng CI đã pass khi chưa có kết quả CI.
6. Không chạy `/ai-dlc approve`, `ready`, `accept`, `create-plan` và không bấm các nút tương ứng trong `huddle60 ui`;
   đó là quyết định của con người.
