import { validateEnvironment } from './environment';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  FE_URL: 'https://coffee.example.com',
  JWT_SECRET: 'strong-access-secret-with-more-than-32-characters',
  JWT_REFRESH_SECRET: 'strong-refresh-secret-with-more-than-32-characters',
  TURNSTILE_SECRET_KEY: 'strong-turnstile-secret-with-more-than-32-characters',
  ONLINE_REORDER_SECRET: 'strong-reorder-secret-with-more-than-32-characters',
  PASSWORD_RESET_URL: 'https://coffee.example.com/reset-password',
  AUTH_SIGNUP_ENABLED: 'false',
  CSRF_ENABLED: 'true',
  COOKIE_SECURE: 'true',
  METRICS_TOKEN: 'strong-metrics-token-with-more-than-32-characters',
  MAIL_HOST: 'smtp.example.com',
  MAIL_PORT: '587',
  MAIL_USER: 'mailer',
  MAIL_PASS: 'password',
  MAIL_FROM: 'noreply@example.com',
  VNPAY_TMN_CODE: 'COFFEE01',
  VNPAY_HASH_SECRET: 'strong-vnpay-secret-with-more-than-32-characters',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_API_URL: 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
  VNPAY_SERVER_IP: '203.0.113.10',
  VNPAY_RETURN_URL: 'https://coffee.example.com/payment/vnpay/return',
} as const;

describe('validateEnvironment', () => {
  it('provides safe development defaults', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
    });

    expect(environment.AUTH_SIGNUP_ENABLED).toBe(false);
    expect(environment.CSRF_ENABLED).toBe(true);
    expect(environment.APP_PREFIX).toBe('/api/v1');
    expect(environment.HOST).toBe('0.0.0.0');
    expect(environment.SWAGGER_ENABLED).toBe(true);
    expect(environment.METRICS_ENABLED).toBe(true);
  });

  it('treats blank optional identity credentials as unconfigured locally', () => {
    const environment = validateEnvironment({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
      GOOGLE_CLIENT_ID: '',
      TURNSTILE_SECRET_KEY: '  ',
    });
    expect(environment.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(environment.TURNSTILE_SECRET_KEY).toBeUndefined();
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        TURNSTILE_SECRET_KEY: '',
      }),
    ).toThrow('Missing required production environment variables');
  });

  it('treats blank MoMo credentials as disabled and rejects partial setup', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
    };
    const blank = validateEnvironment({
      ...base,
      MOMO_PARTNER_CODE: '',
      MOMO_ACCESS_KEY: ' ',
      MOMO_SECRET_KEY: '',
      MOMO_REDIRECT_URL: '',
      MOMO_IPN_URL: '',
    });
    expect(blank.MOMO_PARTNER_CODE).toBeUndefined();
    expect(() =>
      validateEnvironment({ ...base, MOMO_PARTNER_CODE: 'TESTSHOP' }),
    ).toThrow('MoMo requires partner code');
  });

  it('rejects sandbox MoMo gateway when MoMo is enabled in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        MOMO_PARTNER_CODE: 'PRODSHOP',
        MOMO_ACCESS_KEY: 'prod-access-key',
        MOMO_SECRET_KEY: 'strong-momo-secret-with-more-than-32-characters',
        MOMO_REDIRECT_URL: 'https://coffee.example.com/payment/momo/return',
        MOMO_IPN_URL: 'https://api.example.com/api/v1/payments/momo/ipn',
      }),
    ).toThrow('MoMo production endpoints');
  });

  it('rejects invalid boolean values instead of silently disabling security', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://localhost/test',
        CSRF_ENABLED: 'treu',
      }),
    ).toThrow();
  });

  it('requires valid local hours when scheduled pickup is enabled', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
    };
    expect(() =>
      validateEnvironment({ ...base, ONLINE_PICKUP_SLOT_CAPACITY: '4' }),
    ).toThrow('Online pickup requires aligned opening and closing times.');
    expect(() =>
      validateEnvironment({
        ...base,
        ONLINE_PICKUP_SLOT_CAPACITY: '4',
        ONLINE_PICKUP_OPEN_LOCAL: '07:10',
        ONLINE_PICKUP_CLOSE_LOCAL: '22:00',
      }),
    ).toThrow('Online pickup requires aligned opening and closing times.');
    expect(
      validateEnvironment({
        ...base,
        ONLINE_PICKUP_SLOT_CAPACITY: '4',
        ONLINE_PICKUP_OPEN_LOCAL: '07:00',
        ONLINE_PICKUP_CLOSE_LOCAL: '22:00',
      }).ONLINE_PICKUP_SLOT_CAPACITY,
    ).toBe(4);
  });

  it('requires all Telegram settings together', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
      TELEGRAM_BOT_TOKEN: '123456789:fake-test-token',
    };
    expect(() => validateEnvironment(base)).toThrow(
      'Telegram requires bot token, username and webhook secret.',
    );
    expect(
      validateEnvironment({
        ...base,
        TELEGRAM_BOT_USERNAME: 'coffee_test_bot',
        TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
      }).TELEGRAM_BOT_USERNAME,
    ).toBe('coffee_test_bot');
  });

  it('treats blank Telegram settings as disabled, not as partial credentials', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_USERNAME: ' ',
      TELEGRAM_WEBHOOK_SECRET: '',
    };
    expect(validateEnvironment(base)).toMatchObject({
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_BOT_USERNAME: undefined,
      TELEGRAM_WEBHOOK_SECRET: undefined,
    });
    expect(() =>
      validateEnvironment({
        ...base,
        TELEGRAM_BOT_TOKEN: '123456789:fake-test-token',
      }),
    ).toThrow('Telegram requires bot token, username and webhook secret.');
  });

  it('rejects incomplete production configuration', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
      }),
    ).toThrow('Missing required production environment variables');
  });

  it('requires a distinct reorder secret in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        ONLINE_REORDER_SECRET: productionEnvironment.JWT_SECRET,
      }),
    ).toThrow('ONLINE_REORDER_SECRET must be a distinct strong secret');
  });

  it('rejects Cloudflare testing secrets in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      }),
    ).toThrow('TURNSTILE_SECRET_KEY must be a production secret');
  });

  it('rejects public sign-up in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        AUTH_SIGNUP_ENABLED: 'true',
      }),
    ).toThrow('AUTH_SIGNUP_ENABLED cannot be enabled in production');
  });

  it('rejects insecure VNPay endpoints in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        VNPAY_PAYMENT_URL: 'http://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      }),
    ).toThrow('VNPAY_PAYMENT_URL must use HTTPS in production');

    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        VNPAY_API_URL:
          'http://sandbox.vnpayment.vn/merchant_webapi/api/transaction',
      }),
    ).toThrow('VNPAY_API_URL must use HTTPS in production');
  });

  it('requires a strong metrics token in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        METRICS_TOKEN: 'short-production-token',
      }),
    ).toThrow('METRICS_TOKEN must be a strong non-placeholder secret');
  });

  it('rejects a placeholder metrics token in production', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        METRICS_TOKEN: 'development-metrics-token-change-before-production',
      }),
    ).toThrow('METRICS_TOKEN must be a strong non-placeholder secret');
  });

  it('does not allow the production outbox dispatcher to be disabled', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        OUTBOX_POLL_INTERVAL_MS: '0',
      }),
    ).toThrow('OUTBOX_POLL_INTERVAL_MS cannot be disabled in production');
  });

  it('requires an OTLP endpoint when tracing is enabled', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        OTEL_ENABLED: 'true',
      }),
    ).toThrow('OTEL_EXPORTER_OTLP_ENDPOINT is required');
  });
});
