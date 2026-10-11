import { Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const toKebabCase = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-zA-Z0-9\s-_]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase();

@Injectable()
export class StringUtilService {
  removeSpace(value: string) {
    return value.replace(/\s+/g, '_');
  }

  toSlug(text: string): string {
    return toKebabCase(text);
  }

  async hash(value: string) {
    return bcrypt.hash(value, 12);
  }

  async compare(value: string, valueHashed: string) {
    return bcrypt.compare(value, valueHashed);
  }

  random(length = 6): string {
    return crypto
      .randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  }
}
