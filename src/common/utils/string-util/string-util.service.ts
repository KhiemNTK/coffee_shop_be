import { Injectable } from '@nestjs/common';
import { kebabCase } from 'es-toolkit/compat';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
@Injectable()
export class StringUtilService {
  removeSpace(value: string) {
    return value.replace(/\s+/g, '_');
  }

  toSlug(text: string): string {
    return kebabCase(
      text
        .normalize('NFD') // split VietNamese characters
        .replace(/[\u0300-\u036f]/g, '') //delete the split characters
        .replace(/[đĐ]/g, 'd'), //đ to d
    );
  }

  async hash(value: string) {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(value, salt);
  }

  async compare(value: string, valueHashed: string) {
    return await bcrypt.compare(value, valueHashed);
  }

  random(length = 6): string {
    return crypto
      .randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  }
}
