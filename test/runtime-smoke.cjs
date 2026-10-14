const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { get } = require('node:http');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const cwd = resolve(__dirname, '..');
const composeArgs = [
  'compose',
  '--project-name',
  'coffee-shop-runtime-test',
  '-f',
  'test/compose.runtime.yml',
];
const docker = (...args) =>
  execFileSync('docker', args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
const compose = (...args) => docker(...composeArgs, ...args);

async function seedRuntimeFixture() {
  const assert = require('node:assert/strict');
  const { randomUUID, randomBytes, createHash } = require('node:crypto');
  const { JwtService } = require('@nestjs/jwt');
  const { PrismaClient } = require('@prisma/client');
  const { PermissionKeys } = require('./dist/common/consts/permission-keys');
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.hostname, 'postgres');
  assert.equal(database.pathname, '/coffee_shop_runtime_test');
  const prisma = new PrismaClient();
  try {
    const position = await prisma.position.create({
      data: { name: 'Runtime fixture', salary: 0 },
    });
    const role = await prisma.role.create({
      data: { name: 'RUNTIME_FIXTURE' },
    });
    const permission = await prisma.permission.create({
      data: {
        name: 'Runtime kitchen read',
        key: PermissionKeys.KITCHEN_TICKETS_READ,
      },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const employee = await prisma.employee.create({
      data: {
        email: 'runtime-fixture@example.com',
        username: 'runtime-fixture',
        fullName: 'Runtime fixture',
        password: 'not-a-login-password',
        positionId: position.id,
        employeeRoles: { create: { roleId: role.id } },
      },
    });
    const session = await prisma.authSession.create({
      data: {
        employeeId: employee.id,
        familyId: randomUUID(),
        refreshTokenHash: createHash('sha256')
          .update(randomBytes(32))
          .digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const token = new JwtService().sign(
      {
        sub: employee.id,
        email: employee.email,
        sid: session.id,
        tokenType: 'access',
      },
      {
        secret: process.env.JWT_SECRET,
        expiresIn: '10m',
      },
    );
    process.stdout.write(JSON.stringify({ token }));
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  let sse;
  let disconnected;
  let endDeadline;
  try {
    compose('up', '-d', '--wait', '--wait-timeout', '60', 'postgres', 'redis');
    compose('run', '--rm', '-T', 'tooling');
    compose('up', '-d', '--wait', '--wait-timeout', '90', 'backend');
    const id = compose('ps', '-q', 'backend');
    const inspection = JSON.parse(docker('inspect', id))[0];
    assert.equal(inspection.Config.User, 'node');
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspection.HostConfig.Memory, 768 * 1024 * 1024);
    const binding = compose('port', 'backend', '3000');
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const base = `http://${binding}/api/v1`;
    const request = (path) =>
      fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    const ready = await request('/health/ready');
    assert.equal(ready.status, 200);
    assert.ok(ready.headers.get('x-request-id'));
    assert.equal((await ready.json()).data.status, 'ready');

    compose('stop', 'redis');
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/auth/me')).status, 503);
    const params = new URLSearchParams(
      Object.entries({
        vnp_TmnCode: 'SMOKEPOS',
        vnp_TxnRef: 'SMOKE-NO-SUCH-ATTEMPT',
        vnp_Amount: '100000',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TransactionNo: 'SMOKE-1',
      }).sort(([left], [right]) => left.localeCompare(right)),
    );
    params.set(
      'vnp_SecureHash',
      createHmac('sha512', 'smoke-vnpay-key-only-for-isolated-container-tests')
        .update(params.toString())
        .digest('hex'),
    );
    const callback = await request(`/payments/vnpay/ipn?${params}`);
    assert.equal(callback.status, 200);
    assert.equal((await callback.json()).RspCode, '01');
    const stored = compose(
      'exec',
      '-T',
      'backend',
      'node',
      '-e',
      "const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); p.paymentWebhookEvent.count({where:{merchantReference:'SMOKE-NO-SUCH-ATTEMPT'}}).then(n=>process.stdout.write(String(n))).finally(()=>p.$disconnect());",
    );
    assert.equal(stored, '1');
    compose('up', '-d', '--wait', '--wait-timeout', '30', 'redis');
    let recovered = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await request('/health/ready')).status === 200) {
        recovered = true;
        break;
      }
      await delay(200);
    }
    assert.equal(recovered, true, 'Readiness must recover after Redis returns');
    const fixture = JSON.parse(
      compose(
        'exec',
        '-T',
        'backend',
        'node',
        '-e',
        `(${seedRuntimeFixture.toString()})().catch(e=>{console.error(e.message);process.exitCode=1;});`,
      ),
    );
    await new Promise((resolveOpen, rejectOpen) => {
      const deadline = setTimeout(
        () => rejectOpen(new Error('Authenticated SSE did not open')),
        5_000,
      );
      sse = get(
        `${base}/kitchen/events`,
        { agent: false, headers: { Authorization: `Bearer ${fixture.token}` } },
        (response) => {
          clearTimeout(deadline);
          try {
            assert.equal(response.statusCode, 200);
            assert.match(
              response.headers['content-type'],
              /text\/event-stream/,
            );
            disconnected = new Promise((resolveEnd, rejectEnd) => {
              endDeadline = setTimeout(
                () => rejectEnd(new Error('SSE did not drain')),
                15_000,
              );
              response.once('end', resolveEnd);
              response.once('aborted', () =>
                rejectEnd(new Error('SSE was forcibly aborted')),
              );
            });
            disconnected.catch(() => undefined);
            response.resume();
            resolveOpen();
          } catch (error) {
            response.resume();
            rejectOpen(error);
          }
        },
      );
      sse.once('error', rejectOpen);
    });
    compose('stop', '--timeout', '15', 'backend');
    await disconnected;
    const state = JSON.parse(docker('inspect', id))[0].State;
    assert.equal(state.ExitCode, 0);
    assert.equal(state.OOMKilled, false);
    const logs = compose('logs', '--no-color', 'backend');
    assert.match(logs, /application\.shutdown\.completed/);
    assert.doesNotMatch(logs, /Graceful shutdown timed out/);
    console.log(
      'Production runtime smoke passed: boot, Redis outage, durable IPN, authorized SSE and SIGTERM.',
    );
  } catch (error) {
    console.error(compose('logs', '--no-color', '--tail', '80', 'backend'));
    throw error;
  } finally {
    if (endDeadline) clearTimeout(endDeadline);
    sse?.destroy();
    compose('down', '--volumes', '--remove-orphans');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
