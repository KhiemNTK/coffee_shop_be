import { z } from 'zod';

export const EmployeeEmailSchema = z.email('Invalid email address').max(255);

export const EmployeePhoneNumberSchema = z
  .string()
  .trim()
  .min(10, 'Phone number must be at least 10 characters')
  .max(15, 'Phone number is too long');

export const EmployeeFullNameSchema = z
  .string()
  .trim()
  .min(1, 'Full name is required')
  .max(100, 'Full name is too long');

export const EmployeeAddressSchema = z.string().trim().max(500);

export const EmployeeUsernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(50);
