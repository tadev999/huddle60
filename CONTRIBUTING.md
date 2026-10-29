# Đóng góp cho huddle60

Cảm ơn bạn đã quan tâm đóng góp cho huddle60. Dự án được xây dựng theo mô hình **Zero-Infra**: Local App (`huddle60 ui`) + CLI + GitHub Actions.

## Phát triển và kiểm thử

### Cài đặt môi trường
Yêu cầu Node.js >= 20.

```bash
npm ci
npm run check      # Chạy typecheck + vitest + format:check
npm run build      # Biên dịch mã sang dist/action.js và dist/cli.js
```

### Chạy kiểm thử
Bộ test chạy ngoại tuyến (không gọi mạng):
- GitHub API và Gemini API được giả lập thông qua `FakeGitHub` và `FakeModel` trong `tests/helpers/`.
- Chạy toàn bộ test: `npm test` hoặc `npm run test:watch`.

### Chạy thử nghiệm cục bộ
Chạy Local App với repository thật:
```bash
npm run build
node dist/cli.js ui --repo owner/name
```
*Yêu cầu đã đăng nhập GitHub (`gh auth login`) và có `GEMINI_API_KEY` (dành cho PO để soạn kế hoạch).*

Giao diện người dùng nằm tại `ui/` (HTML/CSS/JS thuần, không build step):
- Sử dụng DOM API (`textContent`, `createElement`), không dùng `innerHTML` với dữ liệu không đáng tin cậy.
- Tuân thủ nghiêm ngặt Content Security Policy (CSP).

## Nguyên tắc mã nguồn

1. **Xác định và minh bạch (Deterministic):**
   - Logic kiểm tra quyền, mã băm (RFC 8785 canonical hash), tính hợp lệ của baseline và PR gate nằm hoàn toàn trong `src/core` và `src/workflow`.
   - Không phụ thuộc vào AI để đưa ra phán quyết hay cấp quyền.
2. **Quyền hạn rõ ràng:**
   - Local App không tự ý ghi bằng chứng (evidence) vào Git: mọi thao tác duyệt đều đăng lệnh `/huddle60` bằng tài khoản người dùng, để GitHub Actions kiểm tra tính hợp lệ và ghi vào nhánh `huddle60-evidence`.
3. **Tính tương thích hợp đồng (Contract Integrity):**
   - Không thay đổi cấu trúc Issue template, tên nhãn (`huddle60:*`) hoặc định dạng lệnh `/huddle60` nếu không cập nhật đồng bộ tại [src/core/vocabulary.ts](file:///Users/taduongngoc/Projects/huddle60/src/core/vocabulary.ts), `templates/` và các bài test.
4. **Bảo mật thông tin:**
   - Không commit token, secret hoặc API key thật lên kho mã nguồn. Toàn bộ test fixture phải sử dụng dữ liệu giả định.

## Báo lỗi và phản hồi

Sử dụng GitHub Issues kèm theo mã lỗi `E_...`, log thực thi và các bước tái hiện cụ thể. Đối với vấn đề bảo mật, vui lòng đọc [SECURITY.md](SECURITY.md).
