# Bảo mật

**Không** báo lỗ hổng qua Issue, Discussion hoặc Pull Request công khai.

Khi repository được công bố, hãy dùng **GitHub Private Vulnerability Reporting** (tab Security → Report a vulnerability).
Chủ dự án cần bật tính năng này trước khi công bố. Nếu chưa bật, liên hệ riêng với maintainer.

Thông tin hữu ích: thành phần bị ảnh hưởng, cách tái hiện, tác động và commit/phiên bản.

## Phạm vi quan tâm

- Vượt kiểm tra quyền PO/DEV hoặc giả mạo quyết định (`approve`, `ready`, `accept`).
- Giả mạo webhook, endpoint worker hoặc marker của bot.
- Local app `huddle60 ui`: trang web khác gọi được API (vượt token phiên, Host/Origin check), XSS từ nội dung
  Issue/model, lộ GitHub token hoặc Gemini key.
- Prompt injection làm planner tạo Issue ngoài xác nhận của PO.
- Workflow `pull_request_target` thực thi mã của PR hoặc làm lộ secret.
- Lộ secret, token hoặc nội dung repository private qua log, comment hay model.

## Lưu ý cho người triển khai

- Secret (App private key, webhook secret, Gemini key, task token) chỉ lưu trong Secret Manager / GitHub Secrets.
- Ghim action theo commit SHA; bảo vệ `.github/**`, policy và evidence branch bằng ruleset và CODEOWNERS.
- Không cấp role trong policy cho tài khoản bot hoặc tài khoản chỉ dùng làm công cụ AI.
- Local app chỉ nghe `127.0.0.1`; không chia sẻ URL có `#token=` và không chạy app trên máy dùng chung. Trên macOS
  nên lưu Gemini key trong Keychain (`huddle60-gemini`) thay vì file `.env`.
