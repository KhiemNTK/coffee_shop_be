import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import type { ApiLocale } from '../types';

const messages: Readonly<Record<string, string>> = {
  'Voucher not found.': 'Không tìm thấy voucher trong tài khoản của bạn.',
  'Voucher campaign not found.': 'Không tìm thấy chiến dịch voucher.',
  'An authenticated customer order is required.':
    'Chỉ có thể tặng voucher từ đơn có tài khoản khách hàng.',
  'Customer is not available for voucher issuance.':
    'Tài khoản khách không thể nhận voucher.',
  'Voucher campaign is not available for issuance.':
    'Chiến dịch đã hết lượt, hết hạn hoặc tạm dừng phát hành.',
  'A reserved or redeemed voucher cannot be revoked.':
    'Không thể thu hồi voucher đang áp dụng hoặc đã dùng.',
  'Voucher changed. Reload and review.':
    'Voucher đã thay đổi. Tải lại và kiểm tra trước khi thao tác.',
  'Publish the voucher campaign first.':
    'Cần công bố chiến dịch trước khi thay đổi trạng thái phát hành.',
  'Voucher amounts must be positive.':
    'Giá trị giảm giá, mức giảm tối đa và đơn tối thiểu phải lớn hơn 0.',
  'Percentage discount must be less than 100.':
    'Phần trăm giảm giá phải nhỏ hơn 100%.',
  'Percentage vouchers require a maximum discount.':
    'Voucher phần trăm phải có mức giảm tối đa.',
  'Minimum subtotal must exceed the fixed discount.':
    'Đơn tối thiểu phải lớn hơn số tiền giảm cố định.',
  'Start date must be before end date.':
    'Thời gian bắt đầu phải trước thời gian kết thúc.',
  'Invalid issuance limit.': 'Hạn mức phát hành không hợp lệ.',
  'Stored voucher pricing does not match this order.':
    'Giá voucher đã lưu không khớp đơn. Cần quản lý kiểm tra trước khi thu tiền.',
  'Online order total changed after confirmation.':
    'Số tiền đơn đã thay đổi. Kiểm tra lại trước khi thu tiền.',
  'Order item is not ready for handoff.': 'Món chưa sẵn sàng để giao.',
  'Table items must be ready before delivery.':
    'Món phải được bếp xác nhận làm xong trước khi giao tại bàn.',
  PROMOTION_EXPIRED: 'Khuyến mãi đã hết hạn, không thể công bố trên website.',
  PROMOTION_STOREFRONT_CHANGED:
    'Khuyến mãi đã thay đổi. Tải lại trạng thái trước khi lưu công bố.',
  'Internal Server Error.': 'Dịch vụ gặp lỗi. Vui lòng thử lại sau.',
  'Internal Server Error': 'Dịch vụ gặp lỗi. Vui lòng thử lại sau.',
  'Database connection error.':
    'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.',
  'An unexpected database error occurred.':
    'Dịch vụ gặp lỗi. Vui lòng thử lại sau.',
  'Invalid database query parameters.': 'Tham số truy vấn không hợp lệ.',
  'Data already exists in the system.': 'Dữ liệu đã tồn tại trong hệ thống.',
  'Requested data not found.': 'Không tìm thấy dữ liệu yêu cầu.',
  'Invalid related data.': 'Dữ liệu liên quan không hợp lệ.',
  'Data violates database constraints.':
    'Dữ liệu không đáp ứng ràng buộc hệ thống.',
  'Operation violates data constraints.':
    'Thao tác không đáp ứng ràng buộc dữ liệu.',
  'Validation error.': 'Thông tin không hợp lệ.',
  'Quantity must have at most 14 integer digits and 4 decimal places.':
    'Số lượng có tối đa 14 chữ số phần nguyên và 4 chữ số thập phân.',
  'Money must have at most 16 integer digits and 2 decimal places.':
    'Số tiền có tối đa 16 chữ số phần nguyên và 2 chữ số thập phân.',
  'Use a decimal string for large amounts; money supports at most 2 decimal places.':
    'Số tiền có tối đa 2 chữ số thập phân. Với số tiền lớn, hãy gửi dưới dạng chuỗi.',
  'Tax rate must be between 0 and 100 with at most 2 decimal places.':
    'Thuế suất từ 0 đến 100%, có tối đa 2 chữ số thập phân.',
  'Invoice amount exceeds supported precision.':
    'Tổng tiền hóa đơn vượt giới hạn hỗ trợ.',
  Unauthorized: 'Thông tin đăng nhập không đúng hoặc phiên đã hết hạn.',
  Forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  'Not Found': 'Không tìm thấy dữ liệu yêu cầu.',
  'Bad Request': 'Thông tin yêu cầu không hợp lệ.',
  'Too Many Requests': 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.',
  'ThrottlerException: Too Many Requests':
    'Bạn thao tác quá nhanh. Vui lòng thử lại sau.',
  'Invalid credentials.': 'Thông tin đăng nhập không đúng.',
  'Invalid credentials': 'Thông tin đăng nhập không đúng.',
  'Employee not found.': 'Không tìm thấy nhân viên.',
  'Order session not found.': 'Không tìm thấy phiên phục vụ.',
  'Order request not found.':
    'Không tìm thấy đơn hoặc quyền truy cập đã hết hạn.',
  'Invoice not found.': 'Không tìm thấy hóa đơn.',
  'Invalid JSON format. Please check your request body.':
    'JSON không hợp lệ. Vui lòng kiểm tra nội dung yêu cầu.',
};

const codedMessages: Readonly<Record<string, string>> = {
  ONLINE_ORDER_QUOTE_CHANGED:
    'Giá hoặc voucher đã thay đổi. Kiểm tra lại báo giá và xác nhận trước khi gửi đơn.',
  VOUCHER_EXPIRED:
    'Voucher đã hết hạn. Chọn voucher khác hoặc bỏ voucher để tiếp tục.',
  VOUCHER_REVOKED: 'Voucher đã được thu hồi, không thể sử dụng.',
  VOUCHER_RESERVED:
    'Voucher đang áp dụng cho một đơn khác. Kiểm tra đơn đang chờ trước khi tiếp tục.',
  VOUCHER_USED: 'Voucher đã được sử dụng.',
  VOUCHER_MIN_SUBTOTAL: 'Tiền hàng chưa đạt mức tối thiểu của voucher.',
  VOUCHER_NOT_ACTIVE:
    'Voucher chưa đến thời gian sử dụng hoặc không áp dụng được cho đơn này.',
  VOUCHER_ZERO_TOTAL: 'Voucher phải để lại số tiền cần thanh toán lớn hơn 0.',
  VOUCHER_CHANGED:
    'Voucher đã thay đổi. Tải lại và kiểm tra trước khi thao tác.',
  VOUCHER_CAMPAIGN_CHANGED:
    'Chiến dịch đã thay đổi. Tải lại và kiểm tra trước khi lưu.',
  VOUCHER_ISSUANCE_UNAVAILABLE:
    'Chiến dịch đã hết lượt, hết hạn hoặc tạm dừng phát hành.',
  VOUCHER_INVOICE_NOT_PAID:
    'Chưa thể xác nhận dùng voucher khi hóa đơn chưa thu tiền.',
  REFUND_SELF_RECONCILIATION:
    'Cần nhân viên khác kiểm tra và xác nhận bằng chứng hoàn tiền.',
  REFUND_REVIEW_CHANGED:
    'Yêu cầu hoàn tiền đã thay đổi. Đọc lại trạng thái trước khi xác nhận.',
  BANK_EXCEL_INVALID:
    'Dữ liệu Excel chưa hợp lệ. Kiểm tra ánh xạ cột, khoảng dòng, ngày và số tiền.',
  VNPAY_NOT_CONFIGURED: 'VNPay chưa được cấu hình đầy đủ cho môi trường này.',
  VNPAY_API_TIMEOUT:
    'VNPay chưa phản hồi trong thời gian cho phép. Kiểm tra trạng thái giao dịch trước khi thử lại.',
  VNPAY_API_NETWORK_ERROR:
    'Chưa kết nối được VNPay. Không thanh toán lại khi kết quả giao dịch chưa rõ.',
  VNPAY_API_HTTP_ERROR:
    'VNPay trả về phản hồi HTTP không thành công. Cần kiểm tra lại giao dịch.',
  VNPAY_API_INVALID_PAYLOAD:
    'Phản hồi VNPay không đúng định dạng. Chưa thể xác nhận kết quả thanh toán.',
  VNPAY_API_SIGNATURE_MISSING:
    'Phản hồi VNPay thiếu chữ ký xác minh. Chưa thể xác nhận kết quả thanh toán.',
  VNPAY_API_SIGNATURE_INVALID:
    'Chữ ký phản hồi VNPay không hợp lệ. Cần đối soát trước khi xử lý tiếp.',
  VNPAY_API_RESPONSE_MISMATCH:
    'Phản hồi VNPay không khớp yêu cầu đối soát. Cần kiểm tra thủ công.',
  SHIFT_CLOSE_PENDING_EXPENSES:
    'Ca còn phiếu chi chờ duyệt. Duyệt, từ chối hoặc hủy phiếu trước khi đóng ca.',
  SHIFT_CLOSE_PENDING_PAYMENTS:
    'Ca còn thanh toán chưa có kết quả cuối. Đối soát thanh toán trước khi đóng ca.',
  SHIFT_CLOSE_ACTIVE_SESSIONS:
    'Ca còn phiên phục vụ chưa hoàn tất. Xử lý các đơn còn mở trước khi đóng ca.',
  SHIFT_CLOSING_NOTE_REQUIRED:
    'Chênh lệch tiền mặt cần giải trình. Bổ sung ghi chú trước khi đóng ca.',
  KITCHEN_SPLIT_REQUIRES_UNPRINTED:
    'Phiếu bếp đã được máy in nhận hoặc đang chờ đối soát. Chỉ chuyển cả dòng món, không tách một phần số lượng.',
  EMPLOYEE_PROFILE_CHANGED:
    'Hồ sơ nhân viên đã thay đổi. Đọc lại hồ sơ trước khi lưu.',
  MENU_CONFIGURATION_CHANGED:
    'Công thức hoặc tùy chọn món đã thay đổi. Đọc lại cấu hình trước khi lưu.',
  AUTH_ORIGIN_NOT_ALLOWED:
    'Không thể đăng nhập từ địa chỉ này. Vui lòng mở trang web chính thức hoặc liên hệ quản trị viên.',
  AUTH_JSON_REQUIRED: 'Yêu cầu đăng nhập không đúng định dạng được hỗ trợ.',
  GOOGLE_UNAVAILABLE:
    'Đăng nhập Google tạm thời không khả dụng. Vui lòng thử lại sau.',
  GOOGLE_EMAIL_MISMATCH:
    'Vui lòng chọn tài khoản Google trùng với email nhân viên.',
  GOOGLE_ALREADY_LINKED:
    'Tài khoản Google đã được liên kết. Tải lại thông tin tài khoản hoặc liên hệ quản lý.',
  GOOGLE_LINK_CHANGED:
    'Liên kết Google đã thay đổi. Tải lại thông tin tài khoản trước khi thử lại.',
  SERVICE_DRAINING: 'Dịch vụ đang khởi động lại. Vui lòng thử lại sau ít giây.',
  TRANSACTION_CONFLICT:
    'Dữ liệu đã thay đổi trong lúc xử lý. Tải lại và kiểm tra trước khi thử lại.',
  DATABASE_BUSY: 'Hệ thống dữ liệu đang bận. Vui lòng chờ trước khi thử lại.',
  CASH_HANDOVER_FUND_BUSY:
    'Quỹ nguồn hoặc quỹ nhận đang mở ca thu ngân. Đóng ca trước khi bàn giao.',
  DAILY_CLOSE_BLOCKED:
    'Cần xử lý các nghiệp vụ chưa hoàn tất trước khi chốt sổ ngày.',
  INVOICE_QUOTE_CHANGED:
    'Món hoặc số tiền đã thay đổi. Kiểm tra lại báo giá trước khi xác nhận thanh toán.',
  ONLINE_ORDER_PICKUP_REQUIRED:
    'Đơn online phải được xử lý tại màn hình đơn online. Không thanh toán hoặc hủy lẻ món qua POS.',
  TURNSTILE_REQUIRED: 'Vui lòng hoàn tất xác minh bảo mật trước khi tiếp tục.',
  TURNSTILE_INVALID: 'Xác minh bảo mật không hợp lệ. Vui lòng xác minh lại.',
  TURNSTILE_EXPIRED: 'Xác minh bảo mật đã hết hạn. Vui lòng xác minh lại.',
  TURNSTILE_UNAVAILABLE:
    'Dịch vụ xác minh bảo mật tạm thời không khả dụng. Vui lòng thử lại sau.',
  ONLINE_ORDER_RECOVERY_NOT_FOUND:
    'Chưa tìm thấy đơn đã gửi. Hoàn tất xác minh bảo mật rồi gửi lại đúng yêu cầu này.',
  ROLE_IN_USE:
    'Vai trò đang được gán cho nhân viên. Gán lại vai trò trước khi xóa.',
  AUTHORIZATION_CHANGED:
    'Phân quyền đã thay đổi. Tải lại và đối chiếu trước khi lưu.',
  CASHIER_SHIFT_REQUIRED:
    'Bạn chưa có ca thu ngân đang mở. Mở ca hoặc liên hệ quản lý trước khi thu tiền.',
  CASHIER_SHIFT_FUND_INVALID:
    'Quỹ tiền mặt của ca không hợp lệ. Liên hệ quản lý để kiểm tra, không mở thêm ca.',
  ONLINE_INTAKE_PAUSED: 'Quán đang tạm dừng nhận đơn mới.',
  ONLINE_INTAKE_CHANGED:
    'Trạng thái nhận đơn đã được người khác cập nhật. Làm mới trước khi thao tác tiếp.',
  RATE_LIMIT_UNAVAILABLE:
    'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.',
  ONLINE_ASAP_CLOSED:
    'Ngoài giờ nhận ngay. Vui lòng chọn khung giờ nhận món đặt trước.',
  PAYMENT_LINK_UNAVAILABLE:
    'Không thể mở liên kết này. Kiểm tra hoặc đối soát phiên hiện có; không tạo lần thanh toán khác.',
  INVENTORY_UNIT_IMMUTABLE: 'Không thể đổi đơn vị tính của nguyên liệu đã tạo.',
  INVENTORY_UNIT_IN_USE:
    'Không thể đổi tên đơn vị đã được dùng cho nguyên liệu.',
  INVENTORY_INSUFFICIENT_STOCK:
    'Không đủ nguyên liệu khả dụng. Kiểm tra tồn kho và các đơn đang giữ chỗ trước khi thử lại.',
  INVENTORY_STOCKTAKE_COUNTS_CHANGED:
    'Số đếm đã thay đổi. Tải lại phiếu và xác nhận số đếm mới.',
  INVENTORY_PURCHASE_RECEIPT_CHANGED:
    'Phiếu nhập đã thay đổi. Tải lại và kiểm tra số lượng, đơn giá mới trước khi ghi sổ.',
  INVENTORY_STOCKTAKE_RESERVED_STOCK:
    'Số đếm thực tế thấp hơn lượng đang giữ chỗ. Kiểm tra và xử lý các đơn liên quan trước khi ghi sổ; tạo phiếu mới không giải phóng giữ chỗ.',
  INVENTORY_STOCKTAKE_SNAPSHOT_STALE:
    'Tồn kho đã thay đổi. Hủy phiếu nháp, tạo phiếu mới rồi đếm lại.',
  ORDER_SESSION_NOT_COMPLETE:
    'Tất cả món chưa hủy phải được thanh toán và giao trước khi trả bàn.',
};

export function localizeApiErrors<T extends { message: string }>(
  errors: T[],
  locale: ApiLocale,
  code: string,
  exception?: unknown,
): T[] {
  if (locale === 'en') return errors;
  const validationMessages = new Map<string, string>();
  const zodError =
    exception instanceof ZodValidationException
      ? exception.getZodError()
      : undefined;
  if (zodError instanceof ZodError) {
    for (const issue of zodError.issues) {
      const translated = messages[issue.message];
      if (translated) validationMessages.set(issue.message, translated);
      else if (issue.code === 'invalid_type')
        validationMessages.set(
          issue.message,
          'Giá trị không đúng kiểu dữ liệu yêu cầu.',
        );
      else if (issue.code === 'too_small')
        validationMessages.set(
          issue.message,
          issue.inclusive === false
            ? `Giá trị hoặc độ dài phải lớn hơn ${String(issue.minimum)}.`
            : `Giá trị hoặc độ dài phải tối thiểu ${String(issue.minimum)}.`,
        );
      else if (issue.code === 'too_big')
        validationMessages.set(
          issue.message,
          issue.inclusive === false
            ? `Giá trị hoặc độ dài phải nhỏ hơn ${String(issue.maximum)}.`
            : `Giá trị hoặc độ dài không được vượt quá ${String(issue.maximum)}.`,
        );
      else if (issue.code === 'invalid_format')
        validationMessages.set(
          issue.message,
          'Giá trị không đúng định dạng yêu cầu.',
        );
      else if (issue.code === 'invalid_value' || issue.code === 'invalid_union')
        validationMessages.set(issue.message, 'Giá trị không hợp lệ.');
      // shortcut: unregistered custom validation keeps its reason; add translations as domains migrate.
    }
  }
  return errors.map((error) => ({
    ...error,
    message:
      codedMessages[code] ??
      validationMessages.get(error.message) ??
      messages[error.message] ??
      error.message,
  }));
}
