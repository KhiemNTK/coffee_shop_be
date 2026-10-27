import { ConfigService } from '@nestjs/config';
import { createServer, type Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { createMailOptions, smtpTransportOptions } from './mail-util.module';

describe('SMTP transport security', () => {
  it.each([465, 587, 2525])('requires TLS in production on port %s', (port) => {
    const options = smtpTransportOptions(
      new ConfigService({ NODE_ENV: 'production', MAIL_PORT: port }),
    );
    expect(options).toMatchObject({
      port,
      secure: port === 465,
      requireTLS: true,
    });
    expect(options).not.toHaveProperty('tls.rejectUnauthorized', false);
  });

  it('keeps test mail in memory and permits a local development SMTP relay', async () => {
    expect(
      await createMailOptions(new ConfigService({ NODE_ENV: 'test' })),
    ).toEqual({ transport: { jsonTransport: true } });
    expect(
      smtpTransportOptions(
        new ConfigService({ NODE_ENV: 'development', MAIL_PORT: 1025 }),
      ),
    ).toMatchObject({ secure: false, requireTLS: false });
  });

  it('refuses a real plaintext SMTP server before sending credentials', async () => {
    const commands: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.write('220 fixture.example.test ESMTP\r\n');
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf('\r\n')) >= 0) {
          const command = buffer.slice(0, end).split(' ')[0];
          buffer = buffer.slice(end + 2);
          commands.push(command);
          socket.write(
            command === 'EHLO'
              ? '250-fixture.example.test\r\n250 AUTH PLAIN\r\n'
              : '454 TLS unavailable\r\n',
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing SMTP test address');
    const options = smtpTransportOptions(
      new ConfigService({
        NODE_ENV: 'production',
        MAIL_HOST: '127.0.0.1',
        MAIL_PORT: address.port,
        MAIL_USER: 'fixture',
        MAIL_PASS: 'not-a-real-password',
      }),
    );
    const transport = nodemailer.createTransport({
      ...options,
      connectionTimeout: 1000,
      greetingTimeout: 1000,
      socketTimeout: 1000,
    });
    try {
      await expect(transport.verify()).rejects.toMatchObject({ code: 'ETLS' });
      expect(commands).toContain('STARTTLS');
      expect(commands).not.toContain('AUTH');
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
