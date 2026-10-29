# Đóng góp cho AI-DLC

Cảm ơn bạn quan tâm. Dự án đang ở giai đoạn alpha; đóng góp giá trị nhất lúc này là **chạy thử trên GitHub và Gemini
thật** và báo lại những gì không khớp với thiết kế.

## Bắt đầu

```bash
npm ci
npm run check
```

`npm test` không gọi mạng: GitHub và Gemini được thay bằng `FakeGitHub`/`FakeModel` trong `tests/helpers`.

Chạy local app với repo thật: `npm run build && node dist/cli.js ui --repo owner/name` (cần `gh auth login`;
`GEMINI_API_KEY` nếu muốn soạn kế hoạch). Giao diện nằm trong `ui/` (HTML/CSS/JS thuần, không build step): chỉ dùng
`textContent`/DOM API, không `innerHTML` với dữ liệu, không script/style inline (CSP chặn).

## Việc cần giúp

| Mảng | Ví dụ |
|---|---|
| Kiểm thử thực tế | Cài App vào repo thử, chạy `huddle60 ui`: new plan → create issues → approve → ready → PR → accept, ghi lại kết quả |
| Local app | Trải nghiệm PO/DEV, lưu bản nháp qua lần khởi động, hỗ trợ GHES, khả năng truy cập (a11y) |
| Chất lượng planner | Bộ yêu cầu mẫu và đánh giá kế hoạch Gemini (độ hợp lý, câu hỏi chặn, AC) |
| Tích hợp | Hỗ trợ merge queue, reconciler định kỳ, phát hiện Issue bị sửa chủ động |
| Bảo mật | Prompt injection, vượt quyền, giả mạo webhook/marker, race khi tạo Issues |
| Tài liệu | Hướng dẫn cài đặt từng bước có ảnh, bản tiếng Anh |

## Quy tắc

- PR nhỏ, có test cho hành vi mới; giải thích phần chưa kiểm chứng.
- Logic quyết định (quyền, hash, trạng thái) phải là code xác định trong `src/core` hoặc service, **không** giao cho model.
- Local app không được tự ghi quyết định: nút chỉ đăng lệnh `/ai-dlc`, GitHub Actions kiểm tra và ghi evidence.
- Không đổi heading Issue form, label hoặc định dạng lệnh mà không cập nhật `src/core/vocabulary.ts`, `templates/`
  và `tests/templates.test.ts`; đây là contract với người dùng.
- Thay đổi schema (`plan`, `baseline`, `decision`) cần tăng version và giữ khả năng đọc dữ liệu cũ.
- Không commit secret, token, private key hay dữ liệu khách hàng; fixture phải là dữ liệu giả.
- Dùng AI để viết code được, nhưng bạn phải hiểu và chịu trách nhiệm cho diff.

## Báo lỗi

Dùng form **Bug report**, kèm mã lỗi `E_...`, event GitHub và các bước tái hiện. Lỗ hổng bảo mật: xem
[SECURITY.md](SECURITY.md).
