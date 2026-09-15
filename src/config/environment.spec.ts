import { validateEnvironment } from './environment';

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

  it('rejects incomplete production configuration', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
      }),
    ).toThrow('Missing required production environment variables');
  });

  it('rejects public sign-up in production', () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost:6379',
        FE_URL: 'https://coffee.example.com',
        JWT_SECRET: 'strong-access-secret-with-more-than-32-characters',
        JWT_REFRESH_SECRET:
          'strong-refresh-secret-with-more-than-32-characters',
        PASSWORD_RESET_URL: 'https://coffee.example.com/reset-password',
        AUTH_SIGNUP_ENABLED: 'true',
        CSRF_ENABLED: 'true',
        COOKIE_SECURE: 'true',
        MAIL_HOST: 'smtp.example.com',
        MAIL_PORT: '587',
        MAIL_USER: 'mailer',
        MAIL_PASS: 'password',
        MAIL_FROM: 'noreply@example.com',
      }),
    ).toThrow('AUTH_SIGNUP_ENABLED cannot be enabled in production');
  });
});
