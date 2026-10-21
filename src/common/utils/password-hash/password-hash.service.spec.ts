import bcrypt from 'bcrypt';
import { PasswordHashService } from './password-hash.service';

describe('PasswordHashService', () => {
  it('uses bcrypt cost 12 and accepts only the matching password', async () => {
    const service = new PasswordHashService();
    const hash = await service.hash('test-password');
    expect(hash).not.toBe('test-password');
    expect(bcrypt.getRounds(hash)).toBe(12);
    await expect(service.compare('test-password', hash)).resolves.toBe(true);
    await expect(service.compare('wrong-password', hash)).resolves.toBe(false);
  });
});
