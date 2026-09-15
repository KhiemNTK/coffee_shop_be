import { ExistingPasswordSchema, NewPasswordSchema } from './password.schema';

describe('password schemas', () => {
  it('requires new passwords to contain at least 12 characters', () => {
    expect(NewPasswordSchema.safeParse('short-pass').success).toBe(false);
    expect(NewPasswordSchema.safeParse('valid-pass-12').success).toBe(true);
  });

  it('enforces the bcrypt 72-byte input limit for UTF-8 passwords', () => {
    expect(NewPasswordSchema.safeParse('a'.repeat(72)).success).toBe(true);
    expect(NewPasswordSchema.safeParse('á'.repeat(37)).success).toBe(false);
  });

  it('allows existing accounts to authenticate before a password upgrade', () => {
    expect(ExistingPasswordSchema.safeParse('legacy').success).toBe(true);
  });
});
