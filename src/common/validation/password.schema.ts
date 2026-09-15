import { z } from 'zod';

const BCRYPT_MAX_PASSWORD_BYTES = 72;

export const ExistingPasswordSchema = z
  .string()
  .min(1, 'Password is required')
  .max(256, 'Password is too long');

export const NewPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .refine(
    (password) =>
      Buffer.byteLength(password, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES,
    `Password must not exceed ${BCRYPT_MAX_PASSWORD_BYTES} UTF-8 bytes`,
  );
