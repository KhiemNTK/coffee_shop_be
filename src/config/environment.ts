import { z } from 'zod';

const BooleanEnvSchema = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}, z.boolean());

const CorsOriginsSchema = z.string().refine(
  (value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .every((origin) => z.url().safeParse(origin).success),
  'FE_URL must contain comma-separated absolute URLs',
);

const OptionalCredentialSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(20).optional(),
);

const optionalBlank = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    schema.optional(),
  );

const EnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    APP_PREFIX: z.string().startsWith('/').default('/api/v1'),
    APP_NAME: z.string().min(1).default('coffee_shop_be'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.url().optional(),
    FE_URL: CorsOriginsSchema.default('http://localhost:3001'),
    JWT_SECRET: z
      .string()
      .default('development-access-secret-change-before-production'),
    JWT_REFRESH_SECRET: z
      .string()
      .default('development-refresh-secret-change-before-production'),
    PASSWORD_RESET_URL: z.url().default('http://localhost:3001/reset-password'),
    AUTH_SIGNUP_ENABLED: BooleanEnvSchema.default(false),
    GOOGLE_CLIENT_ID: OptionalCredentialSchema,
    TURNSTILE_SECRET_KEY: OptionalCredentialSchema,
    CSRF_ENABLED: BooleanEnvSchema.default(true),
    COOKIE_SECURE: BooleanEnvSchema.default(false),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    SWAGGER_ENABLED: BooleanEnvSchema.optional(),
    JSON_BODY_LIMIT: z
      .string()
      .regex(/^\d+(kb|mb)$/i)
      .default('1mb'),
    TRUST_PROXY: z.string().min(1).default('loopback'),
    METRICS_ENABLED: BooleanEnvSchema.default(true),
    METRICS_TOKEN: z.string().trim().min(16).optional(),
    OUTBOX_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(1_000),
    ONLINE_PICKUP_SLOT_CAPACITY: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .optional(),
    ONLINE_PICKUP_OPEN_LOCAL: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    ONLINE_PICKUP_CLOSE_LOCAL: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    ONLINE_PICKUP_MIN_LEAD_MINUTES: z.coerce
      .number()
      .int()
      .min(15)
      .max(180)
      .default(45),
    ONLINE_PICKUP_DAYS_AHEAD: z.coerce.number().int().min(1).max(14).default(7),
    ONLINE_REORDER_SECRET: z.string().min(32).optional(),
    TELEGRAM_BOT_TOKEN: OptionalCredentialSchema,
    TELEGRAM_BOT_USERNAME: optionalBlank(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_]{5,32}$/),
    ),
    TELEGRAM_WEBHOOK_SECRET: optionalBlank(
      z
        .string()
        .min(32)
        .max(256)
        .regex(/^[A-Za-z0-9_-]+$/),
    ),
    SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(60_000)
      .default(10_000),
    OTEL_ENABLED: BooleanEnvSchema.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),
    THROTTLE_TTL: z.coerce.number().int().positive().default(60000),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
    MAIL_HOST: z.string().optional(),
    MAIL_PORT: z.coerce.number().int().positive().optional(),
    MAIL_USER: z.string().optional(),
    MAIL_PASS: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    VNPAY_TMN_CODE: z.string().trim().min(1).max(32).optional(),
    VNPAY_HASH_SECRET: z.string().min(8).optional(),
    VNPAY_PAYMENT_URL: z
      .url()
      .default('https://sandbox.vnpayment.vn/paymentv2/vpcpay.html'),
    VNPAY_API_URL: z
      .url()
      .default('https://sandbox.vnpayment.vn/merchant_webapi/api/transaction'),
    VNPAY_SERVER_IP: z.string().trim().min(7).max(45).default('127.0.0.1'),
    VNPAY_API_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(15_000)
      .default(5_000),
    VNPAY_RETURN_URL: z.url().optional(),
    VNPAY_ATTEMPT_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(60)
      .default(15),
    MOMO_PARTNER_CODE: optionalBlank(z.string().trim().min(1).max(50)),
    MOMO_ACCESS_KEY: optionalBlank(z.string().trim().min(1)),
    MOMO_SECRET_KEY: optionalBlank(z.string().min(16)),
    MOMO_API_URL: z.url().default('https://test-payment.momo.vn'),
    MOMO_REDIRECT_URL: optionalBlank(z.url()),
    MOMO_IPN_URL: optionalBlank(z.url()),
    MOMO_API_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(60_000)
      .default(30_000),
    MOMO_ATTEMPT_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(60)
      .default(15),
  })
  .passthrough();

const WEAK_SECRET_MARKERS = [
  'change-before-production',
  'changeme',
  'replace-me',
  'your-secret',
  'default-secret',
];

export function validateEnvironment(raw: Record<string, unknown>) {
  const parsed = EnvironmentSchema.parse(raw);
  const environment = {
    ...parsed,
    SWAGGER_ENABLED: parsed.SWAGGER_ENABLED ?? parsed.NODE_ENV !== 'production',
  };
  if (environment.ONLINE_PICKUP_SLOT_CAPACITY) {
    const open = environment.ONLINE_PICKUP_OPEN_LOCAL;
    const close = environment.ONLINE_PICKUP_CLOSE_LOCAL;
    const minute = (time: string) =>
      Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (
      !open ||
      !close ||
      minute(open) >= minute(close) ||
      minute(open) % 15 ||
      minute(close) % 15
    ) {
      throw new Error(
        'Online pickup requires aligned opening and closing times.',
      );
    }
  }
  const telegram = [
    environment.TELEGRAM_BOT_TOKEN,
    environment.TELEGRAM_BOT_USERNAME,
    environment.TELEGRAM_WEBHOOK_SECRET,
  ];
  if (telegram.some(Boolean) && telegram.some((value) => !value)) {
    throw new Error(
      'Telegram requires bot token, username and webhook secret.',
    );
  }
  const momo = [
    environment.MOMO_PARTNER_CODE,
    environment.MOMO_ACCESS_KEY,
    environment.MOMO_SECRET_KEY,
    environment.MOMO_REDIRECT_URL,
    environment.MOMO_IPN_URL,
  ];
  if (momo.some(Boolean) && momo.some((value) => !value)) {
    throw new Error(
      'MoMo requires partner code, access key, secret key, redirect URL and IPN URL.',
    );
  }
  if (environment.NODE_ENV !== 'production') return environment;

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'FE_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'TURNSTILE_SECRET_KEY',
    'ONLINE_REORDER_SECRET',
    'PASSWORD_RESET_URL',
    'MAIL_HOST',
    'MAIL_PORT',
    'MAIL_USER',
    'MAIL_PASS',
    'MAIL_FROM',
    'VNPAY_TMN_CODE',
    'VNPAY_HASH_SECRET',
    'VNPAY_PAYMENT_URL',
    'VNPAY_API_URL',
    'VNPAY_SERVER_IP',
    'VNPAY_RETURN_URL',
  ] as const;
  const missing = required.filter((key) => !raw[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(', ')}`,
    );
  }

  for (const [name, value] of [
    ['JWT_SECRET', environment.JWT_SECRET],
    ['JWT_REFRESH_SECRET', environment.JWT_REFRESH_SECRET],
  ] as const) {
    const weak = WEAK_SECRET_MARKERS.some((marker) =>
      value.toLowerCase().includes(marker),
    );
    if (value.length < 32 || weak) {
      throw new Error(
        `${name} must be a strong secret of at least 32 characters`,
      );
    }
  }

  if (environment.JWT_SECRET === environment.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (
    !environment.TURNSTILE_SECRET_KEY ||
    /^[123]x0{31}AA$/.test(environment.TURNSTILE_SECRET_KEY) ||
    WEAK_SECRET_MARKERS.some((marker) =>
      environment.TURNSTILE_SECRET_KEY?.toLowerCase().includes(marker),
    )
  ) {
    throw new Error('TURNSTILE_SECRET_KEY must be a production secret');
  }
  if (
    !environment.ONLINE_REORDER_SECRET ||
    WEAK_SECRET_MARKERS.some((marker) =>
      environment.ONLINE_REORDER_SECRET?.toLowerCase().includes(marker),
    ) ||
    environment.ONLINE_REORDER_SECRET === environment.JWT_SECRET ||
    environment.ONLINE_REORDER_SECRET === environment.JWT_REFRESH_SECRET
  ) {
    throw new Error('ONLINE_REORDER_SECRET must be a distinct strong secret');
  }
  if (environment.AUTH_SIGNUP_ENABLED) {
    throw new Error('AUTH_SIGNUP_ENABLED cannot be enabled in production');
  }
  if (!environment.CSRF_ENABLED) {
    throw new Error('CSRF_ENABLED must be enabled in production');
  }
  if (!environment.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be enabled in production');
  }
  if (
    environment.METRICS_ENABLED &&
    ((environment.METRICS_TOKEN?.length ?? 0) < 32 ||
      WEAK_SECRET_MARKERS.some((marker) =>
        environment.METRICS_TOKEN?.toLowerCase().includes(marker),
      ))
  ) {
    throw new Error(
      'METRICS_TOKEN must be a strong non-placeholder secret of at least 32 characters when metrics are enabled in production',
    );
  }
  if (environment.OUTBOX_POLL_INTERVAL_MS === 0) {
    throw new Error('OUTBOX_POLL_INTERVAL_MS cannot be disabled in production');
  }
  if (environment.OTEL_ENABLED && !environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_ENDPOINT is required when OpenTelemetry is enabled',
    );
  }
  const insecureOrigin = environment.FE_URL.split(',')
    .map((origin) => origin.trim())
    .find((origin) => !origin.startsWith('https://'));
  if (insecureOrigin) {
    throw new Error('FE_URL must use HTTPS in production');
  }
  if (!environment.PASSWORD_RESET_URL.startsWith('https://')) {
    throw new Error('PASSWORD_RESET_URL must use HTTPS in production');
  }
  if (!environment.VNPAY_RETURN_URL?.startsWith('https://')) {
    throw new Error('VNPAY_RETURN_URL must use HTTPS in production');
  }
  if (!environment.VNPAY_PAYMENT_URL.startsWith('https://')) {
    throw new Error('VNPAY_PAYMENT_URL must use HTTPS in production');
  }
  if (!environment.VNPAY_API_URL.startsWith('https://')) {
    throw new Error('VNPAY_API_URL must use HTTPS in production');
  }
  if (
    ['your_', 'replace-', 'changeme'].some((marker) =>
      environment.VNPAY_TMN_CODE?.toLowerCase().includes(marker),
    )
  ) {
    throw new Error('VNPAY_TMN_CODE must not use a placeholder value');
  }
  if ((environment.VNPAY_HASH_SECRET?.length ?? 0) < 32) {
    throw new Error(
      'VNPAY_HASH_SECRET must be a strong secret of at least 32 characters',
    );
  }
  if (
    ['replace-', 'development', ...WEAK_SECRET_MARKERS].some((marker) =>
      environment.VNPAY_HASH_SECRET?.toLowerCase().includes(marker),
    )
  ) {
    throw new Error('VNPAY_HASH_SECRET must not use a placeholder value');
  }

  if (environment.MOMO_PARTNER_CODE) {
    if (
      !environment.MOMO_API_URL.startsWith('https://') ||
      new URL(environment.MOMO_API_URL).hostname !== 'payment.momo.vn' ||
      !environment.MOMO_REDIRECT_URL?.startsWith('https://') ||
      !environment.MOMO_IPN_URL?.startsWith('https://')
    ) {
      throw new Error(
        'MoMo production endpoints must use HTTPS and production gateway',
      );
    }
    if (
      (environment.MOMO_SECRET_KEY?.length ?? 0) < 32 ||
      WEAK_SECRET_MARKERS.some((marker) =>
        environment.MOMO_SECRET_KEY?.toLowerCase().includes(marker),
      )
    ) {
      throw new Error('MOMO_SECRET_KEY must be a strong production secret');
    }
  }

  return environment;
}
