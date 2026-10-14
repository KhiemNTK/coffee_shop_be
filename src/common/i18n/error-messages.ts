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
    'Không đủ nguyên liệu để bắt đầu chế biến. Kiểm tra và bổ sung tồn kho.',
  INVENTORY_STOCKTAKE_COUNTS_CHANGED:
    'Số đếm đã thay đổi. Tải lại phiếu và xác nhận số đếm mới.',
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
