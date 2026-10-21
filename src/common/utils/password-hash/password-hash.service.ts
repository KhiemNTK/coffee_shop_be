import { Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';

@Injectable()
export class PasswordHashService {
  hash(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  compare(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
}
