import http from 'k6/http';
import { check } from 'k6';

const API_BASE_URL = (
  __ENV.API_BASE_URL || 'http://localhost:3000/api/v1'
).replace(/\/$/, '');
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || '';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    api_reads: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PREALLOCATED_VUS || 300),
      maxVUs: Number(__ENV.MAX_VUS || 1200),
      stages: [
        { target: 250, duration: '1m' },
        { target: 250, duration: '3m' },
        { target: 500, duration: '30s' },
        { target: 250, duration: '1m' },
        { target: 0, duration: '30s' },
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    dropped_iterations: ['count<1'],
    'http_req_duration{name:menu.items}': ['p(95)<300'],
    'http_req_duration{name:dining-tables}': ['p(95)<300'],
    'http_req_duration{name:order-sessions}': ['p(95)<300'],
  },
};

export function setup() {
  if (!ACCESS_TOKEN) {
    throw new Error('ACCESS_TOKEN is required for the load test');
  }

  const response = http.get(`${API_BASE_URL}/health/ready`, {
    tags: { name: 'setup.readiness' },
  });
  if (response.status !== 200) {
    throw new Error(
      `API readiness check failed with status ${response.status}`,
    );
  }
}

export default function () {
  const selector = Math.random();
  const target =
    selector < 0.6
      ? { name: 'menu.items', path: '/menu/items' }
      : selector < 0.85
        ? { name: 'dining-tables', path: '/dining-tables' }
        : { name: 'order-sessions', path: '/orders/sessions' };

  const response = http.get(`${API_BASE_URL}${target.path}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    tags: { name: target.name },
  });

  check(response, {
    [`${target.name} returns 200`]: (result) => result.status === 200,
  });
}
