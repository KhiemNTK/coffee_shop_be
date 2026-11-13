import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  VnpayApiDiagnostics,
  VnpayApiFailureCode,
} from '../../common/types';

const messages: Record<VnpayApiFailureCode, string> = {
  VNPAY_NOT_CONFIGURED:
    'VNPay reconciliation API is not configured for this environment.',
  VNPAY_API_TIMEOUT: 'VNPay API request timed out.',
  VNPAY_API_NETWORK_ERROR: 'VNPay API connection failed.',
  VNPAY_API_HTTP_ERROR: 'VNPay API returned an unsuccessful HTTP response.',
  VNPAY_API_INVALID_PAYLOAD: 'VNPay API returned an invalid payload.',
  VNPAY_API_SIGNATURE_MISSING: 'VNPay API response signature is missing.',
  VNPAY_API_SIGNATURE_INVALID: 'VNPay API response signature is invalid.',
  VNPAY_API_RESPONSE_MISMATCH: 'VNPay API response does not match the request.',
};

export class VnpayApiException extends HttpException {
  constructor(
    readonly failureCode: VnpayApiFailureCode,
    readonly diagnostics: VnpayApiDiagnostics = {},
  ) {
    super(
      { code: failureCode, message: messages[failureCode] },
      failureCode === 'VNPAY_NOT_CONFIGURED'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.BAD_GATEWAY,
    );
  }

  get isTransient() {
    const status = this.diagnostics.providerHttpStatus ?? 0;
    return (
      this.failureCode === 'VNPAY_API_TIMEOUT' ||
      this.failureCode === 'VNPAY_API_NETWORK_ERROR' ||
      (this.failureCode === 'VNPAY_API_HTTP_ERROR' &&
        (status === 408 || status === 429 || status >= 500))
    );
  }
}
