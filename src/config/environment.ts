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
    CSRF_ENABLED: BooleanEnvSchema.default(true),
    COOKIE_SECURE: BooleanEnvSchema.default(false),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    SWAGGER_ENABLED: BooleanEnvSchema.optional(),
    JSON_BODY_LIMIT: z
      .string()
      .regex(/^\d+(kb|mb)$/i)
      .default('1mb'),
    TRUST_PROXY: z.string().min(1).default('loopback'),
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
  if (environment.NODE_ENV !== 'production') return environment;

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'FE_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
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
  if (environment.AUTH_SIGNUP_ENABLED) {
    throw new Error('AUTH_SIGNUP_ENABLED cannot be enabled in production');
  }
  if (!environment.CSRF_ENABLED) {
    throw new Error('CSRF_ENABLED must be enabled in production');
  }
  if (!environment.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be enabled in production');
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

  return environment;
}
