import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import type { ApiLocale } from '../types';

const messages: Readonly<Record<string, string>> = {
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
