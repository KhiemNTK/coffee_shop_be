import { Injectable } from '@nestjs/common';
import { kebabCase } from 'es-toolkit/compat';
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
}
