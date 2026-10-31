# Bài 2: Trò Chơi "Tam Sao Thất Bản" Giữa PO và DEV Trong Thời Đại AI

*Tác giả: Một lập trình viên 17 năm trong nghề nhìn về cơn sốt AI hiện tại.*

---

## 1. Màn kịch quen thuộc ở mọi buổi Demo

Hãy thành thật với nhau: Đã bao nhiêu lần bạn chứng kiến cảnh tượng này trong đời làm phần mềm?

Buổi Demo cuối Sprint. Bạn DEV hào hứng chia sẻ màn hình:
- *DEV:* "Em đã làm xong tính năng Đăng nhập cho user mới rồi ạ, có cả nút Google, lưu token vào localStorage, animation mượt mà!"
- *PO (mắt tròn xoe):* "Ơ, sao lại vào thẳng Dashboard luôn thế này? Còn bước bắt họ nhập chức danh công ty và quy mô doanh nghiệp đâu em? Trong tài liệu Notion tuần trước chị có viết một dòng cơ mà?"
- *DEV (toát mồ hôi):* "Ủa, trong ticket Jira chị chỉ ghi là 'Màn hình đăng nhập cho khách hàng mới', đâu có chữ nào về onboarding khảo sát thông tin đâu ạ?"
- *PO:* "Thì người dùng mới đăng nhập lần đầu thì hiển nhiên phải onboarding chứ em!"

Đến đây, cả phòng họp rơi vào im lặng gượng gạo. Một tính năng ngốn mất 2 tuần công sức của đội ngũ bỗng chốc trở thành đồ phế thải hoặc phải đập đi xây lại 50%.

Ngày xưa, khi code tay, chúng ta mất 2 tuần để nhận ra mình hiểu lầm nhau. Ngày nay, với AI, bạn chỉ mất **2 giờ** để sinh ra hàng ngàn dòng code dựa trên một hiểu lầm tai hại. AI không làm giảm sự hiểu lầm; **AI phóng đại sự hiểu lầm với quy mô lớn hơn và tốc độ tàn phá khủng khiếp hơn!**

---

## 2. Hai cực đoan của Product Owner (PO) khi giao việc

Trong suốt 17 năm làm việc với hàng trăm Product Owner, từ những bạn Junior chập chững đến những CPO sừng sỏ, tôi nhận thấy PO thường rơi vào 2 thái cực sai lầm:

### Thái cực 1: "Quăng một cục mơ hồ" (Under-specification)
PO ném lên Jira hoặc Slack một câu ngắn ngủn: *"Làm tính năng giỏ hàng giống Shopee"* hoặc *"Thêm xác thực người dùng"*. 
Họ nghĩ rằng lập trình viên sẽ tự động "thần giao cách cảm" để hiểu:
- Khách vãng lai chưa đăng nhập có cho thêm vào giỏ không?
- Giá sản phẩm thay đổi trong lúc chờ thanh toán thì xử lý thế nào?
- Mã giảm giá hết hạn thì báo lỗi gì?

Hậu quả là lập trình viên phải tự đoán. Mà khi kỹ sư đoán nghiệp vụ thì 99% là đoán trúng kịch bản dễ làm nhất cho họ, chứ không phải kịch bản tốt nhất cho người dùng.

### Thái cực 2: "Can thiệp quá sâu vào kỹ thuật" (Over-technical specification)
Đây là căn bệnh của những PO có chút kiến thức kỹ thuật hoặc quá lo lắng:
- PO viết vào spec: *"Tạo bảng `users_v2`, thêm API POST `/api/v1/auth/login`, dùng JWT lưu vào Redis..."*
- Khi PO cố gắng làm thay việc của kỹ sư trưởng, họ bỏ quên mất nhiệm vụ cốt lõi của mình: **Định nghĩa giá trị nghiệp vụ và tiêu chí nghiệm thu**. Họ quên không trả lời câu hỏi: *"Người dùng thực sự cần gì, và làm sao tôi biết tính năng này đã đạt yêu cầu?"*

---

## 3. Nghịch lý AI: Đừng bao giờ hỏi PO câu hỏi kỹ thuật!

Gần đây, khi tôi phát triển công cụ AI Planner cho Huddle60 để phục vụ cho anh em trong team, chúng tôi gặp phải một hiện tượng rất thú vị nhưng nguy hiểm:

Khi PO nhập yêu cầu: *"Tôi muốn làm tính năng mời thành viên qua email"*.
Mô hình AI ban đầu liền lập tức đưa ra câu hỏi chặn (blocking question) hỏi lại PO:
> *"Hệ thống hiện tại của bạn đã có sẵn bảng `organization_members` chưa? Chúng ta nên gửi email qua SendGrid hay AWS SES? API nên trả về mã 200 hay 201?"*

Bạn hãy tưởng tượng vẻ mặt của một PO (vốn xuất thân từ kinh doanh hoặc thiết kế) khi đọc những câu hỏi này! Họ sẽ hoảng loạn, đóng tab trình duyệt lại, hoặc phải gọi một bạn Senior DEV ra ngồi cạnh để "dịch hộ". 

Thế là mục tiêu tự động hóa của AI hoàn toàn sụp đổ. Chúng ta lại quay về với những cuộc họp dài bất tận.

**Nguyên tắc vàng ở đây là:**
1. **PO là người của Nghiệp vụ & Trải nghiệm:** Chỉ hỏi PO về quy tắc kinh doanh, luồng đi của người dùng và phạm vi sản phẩm (Scope). Tuyệt đối cấm AI hỏi PO về database, endpoint hay framework.
2. **Kỹ thuật là việc của AI và DEV:** Những thứ thuộc về kiến trúc nội bộ, nếu chưa chắc chắn, AI phải tự động đọc cấu trúc Codebase thực tế để suy luận, hoặc ghi thành **Giả định kỹ thuật (Assumptions)** để DEV review sau, chứ không được biến nó thành câu hỏi chặn đẩy về phía PO.

---

## 4. Giải pháp: Hợp đồng nghiệm thu dạng "Given - When - Then"

Làm sao để xóa bỏ hoàn toàn trò chơi "Tam sao thất bản"? 

Kinh nghiệm 17 năm của tôi chỉ ra rằng: Cách duy nhất để con người và AI không hiểu lầm nhau là sử dụng **Acceptance Criteria (AC) chuẩn mực theo cú pháp Gherkin (Given - When - Then)**.

Thay vì viết: *"Màn hình đăng nhập phải bảo mật và thân thiện"*, bản đặc tả phải được AI chuẩn hóa thành:

```gherkin
AC-01: Đăng nhập thành công với thông tin hợp lệ
- Given: Người dùng đã có tài khoản đang hoạt động với email "test@example.com"
- When: Người dùng nhập đúng email, đúng mật khẩu và bấm "Đăng nhập"
- Then: Hệ thống cấp phiên làm việc, chuyển hướng người dùng vào Dashboard và hiển thị lời chào.

AC-02: Khóa tạm thời khi đăng nhập sai nhiều lần
- Given: Người dùng nhập sai mật khẩu 5 lần liên tiếp
- When: Người dùng thử đăng nhập lần thứ 6
- Then: Hệ thống khóa đăng nhập trong 15 phút và hiển thị thông báo thời gian còn lại.
```

Khi tiêu chí nghiệm thu được viết tường minh như thế này:
1. **PO đọc hiểu ngay:** PO biết chính xác hệ thống sẽ hành xử thế nào trong mọi trường hợp.
2. **AI Coding Agent code chuẩn 100%:** AI (Cursor/Claude) không cần đoán mò. Nó sẽ chuyển từng dòng `Given/When/Then` này thành các bài test tự động (`it('should lock user after 5 failed attempts')`).
3. **Không còn cãi vã khi nghiệm thu:** Đúng kịch bản là Pass, sai kịch bản là Fail. Không ai có thể chối cãi.

---

## 5. Cuộc hội ý 60 giây (The 60-Second Huddle)

Thay vì tổ chức những buổi Grooming/Refinement kéo dài 2 tiếng đồng hồ mỗi tuần làm kiệt quệ năng lượng của cả team, quy trình hiện đại chỉ cần **60 giây hội ý**:

1. **PO đưa đề bài tự nhiên:** Gõ vài câu mô tả nhu cầu, kèm theo link tài liệu, Figma hoặc ảnh phác thảo trên giấy.
2. **AI Codebase-Aware phân tích trong 10 giây:** Tự động đọc cấu trúc code hiện tại của dự án, đối chiếu với yêu cầu, và trả ra một bản kế hoạch gọn gàng gồm đúng các tiêu chí AC nghiệp vụ.
3. **PO duyệt trong 30 giây:** PO đọc lướt qua các AC, nếu thấy thiếu ý gì thì gõ một câu phản hồi để AI bổ sung.
4. **Bấm Approve:** Toàn bộ yêu cầu được đóng băng và sẵn sàng để lập trình viên bấm nút triển khai.

Khi sự giao tiếp giữa PO và DEV được "chuẩn hóa bằng giao thức" thay vì phụ thuộc vào cảm xúc và trí nhớ, năng suất thực sự mới bắt đầu bùng nổ.

*Ở Bài 3, chúng ta sẽ cùng bàn về sự dịch chuyển tư duy căn bản nhất của người làm kỹ thuật: Từ một "thợ gõ code thủ công" trở thành một "kỹ sư điều phối đặc tả trong kỷ nguyên AI-DLC".*

