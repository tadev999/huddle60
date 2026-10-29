# Chính sách bảo mật

Vui lòng **không** báo cáo các lỗ hổng bảo mật qua Issues hoặc Pull Requests công khai.

## Báo cáo lỗ hổng

Sử dụng tính năng **GitHub Private Vulnerability Reporting** tại tab **Security → Report a vulnerability** của repository. 

Nếu tính năng này chưa được kích hoạt, vui lòng liên hệ trực tiếp với maintainer của repository.

Vui lòng cung cấp:
- Thành phần bị ảnh hưởng (Local App, CLI, GitHub Action).
- Các bước tái hiện chi tiết (PoC).
- Mức độ ảnh hưởng ước tính.

## Phạm vi quan tâm

- **Kiểm soát truy cập và chữ ký số:**
  - Vượt qua kiểm tra quyền hạn của PO/DEV hoặc giả mạo các quyết định (`approve`, `ready`, `accept`, `revoke`).
  - Giả mạo mã băm yêu cầu (baseline hash) hoặc khai thác sai lệch thuật toán băm chuẩn hóa (RFC 8785).
  - Giả mạo khối dữ liệu PR `<!-- huddle60:begin -->` hoặc marker ẩn của bot.
- **Bảo mật Local App (`huddle60 ui`):**
  - Trang web khác gọi API cục bộ thông qua tấn công CSRF hoặc DNS rebinding (vượt kiểm tra Host/Origin hoặc token phiên).
  - XSS từ dữ liệu Issue hoặc phản hồi của AI model.
  - Rò rỉ GitHub Token hoặc Gemini API Key từ tiến trình local app.
- **Bảo mật GitHub Actions:**
  - Khai thác workflow `pull_request_target` để thực thi mã không an toàn từ PR của người đóng góp bên ngoài.
  - Rò rỉ secret hoặc token có quyền ghi thông qua build log hoặc error log.

## Hướng dẫn thiết lập an toàn

1. **Bảo vệ bằng chứng và chính sách:**
   - Ghim phiên bản Action bằng commit SHA trong workflow.
   - Thiết lập ruleset cho branch mặc định: bắt buộc PR review và chỉ định CODEOWNERS cho thư mục `.github/**`.
   - Thiết lập ruleset chặn force-push và xoá nhánh đối với `huddle60-evidence`, chỉ cấp quyền ghi cho GitHub App.
2. **Phân quyền người dùng:**
   - Không gán vai trò (`po`, `dev`, `maintainer`) trong `.github/huddle60/policy.yml` cho các tài khoản bot hoặc công cụ AI tự động.
3. **Môi trường cục bộ:**
   - Local App chỉ lắng nghe tại `127.0.0.1`, sử dụng token ngẫu nhiên trong URL (`#token=...`) và không bao giờ chia sẻ URL này ra ngoài.
   - Trên macOS, khuyến khích lưu trữ Gemini API Key trong Keychain (`huddle60-gemini`) thay vì đặt trong file cấu hình.
