import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import type {
  BusinessInsightSuggestions,
  BusinessInsightSnapshot,
} from '../../common/types';
import { GeminiInsightsService } from './gemini-insights.service';
import { BusinessInsightSuggestionsSchema } from './business-insight.schema';

const snapshot: BusinessInsightSnapshot = {
  schemaVersion: 2,
  asOf: '2026-10-10T00:00:00.000Z',
  currentPeriod: {
    from: '2026-10-09T00:00:00.000Z',
    to: '2026-10-10T00:00:00.000Z',
  },
  timeZone: 'Asia/Ho_Chi_Minh',
  comparisonBasis: 'PREVIOUS_EQUAL_DURATION',
  basis: {
    sales: 'INVOICE_CREATED_AT',
    refunds: 'COHORT_REFUNDS_AS_OF_SNAPSHOT',
    waste: 'WASTE_CREATED_AT',
  },
  comparisonPeriod: {
    from: '2026-10-08T00:00:00.000Z',
    to: '2026-10-09T00:00:00.000Z',
  },
  metrics: [
    {
      key: 'netReceipts',
      label: 'Thuc thu',
      value: '100000.00',
      previousValue: '90000.00',
      unit: 'VND',
    },
  ],
};
const analysis: BusinessInsightSuggestions = {
  findings: [
    {
      title: 'Thuc thu',
      kind: 'HYPOTHESIS',
      detail: 'Can doi chieu them so hoa don.',
      metricKeys: ['netReceipts'],
      action: 'Kiem tra bao cao ban hang.',
    },
  ],
  limitations: ['Chua du du lieu de ket luan nguyen nhan.'],
};

describe('GeminiInsightsService', () => {
  let service: GeminiInsightsService;
  let fetchSpy: jest.SpyInstance;
  const respond = (output: unknown, finishReason = 'STOP') =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason,
            content: { parts: [{ text: JSON.stringify(output) }] },
          },
        ],
        usageMetadata: { totalTokenCount: 100 },
      }),
    );

  beforeEach(() => {
    service = new GeminiInsightsService(
      new ConfigService({
        GEMINI_API_KEY: 'fixture-secret-never-in-url',
        GEMINI_TIMEOUT_MS: 1_000,
        GEMINI_MAX_OUTPUT_TOKENS: 3_000,
      }),
    );
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(respond(analysis));
  });
  afterEach(() => {
    service.stop();
    jest.restoreAllMocks();
  });

  it('sends only aggregate facts with schema, header credential and bounded output', async () => {
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).resolves.toEqual(analysis);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('fixture-secret');
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({
      'x-goog-api-key': 'fixture-secret-never-in-url',
    });
    if (typeof options.body !== 'string')
      throw new Error('Expected JSON request body');
    const payload = JSON.parse(options.body) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        maxOutputTokens: number;
        responseJsonSchema: unknown;
        thinkingConfig: { thinkingLevel: string };
      };
    };
    expect(JSON.parse(payload.contents[0].parts[0].text)).toEqual(snapshot);
    expect(payload.generationConfig.maxOutputTokens).toBe(3_000);
    expect(payload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'low',
    });
    expect(payload.generationConfig.responseJsonSchema).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('requires unique evidence while retaining JSON schema generation', async () => {
    const duplicateEvidence = {
      ...analysis,
      findings: [
        {
          ...analysis.findings[0],
          metricKeys: ['netReceipts', 'netReceipts'],
        },
      ],
    };
    expect(
      BusinessInsightSuggestionsSchema.safeParse(duplicateEvidence).success,
    ).toBe(false);
    expect(() =>
      z.toJSONSchema(BusinessInsightSuggestionsSchema),
    ).not.toThrow();
    fetchSpy.mockResolvedValue(respond(duplicateEvidence));
    const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
    await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(pending).rejects.toMatchObject({
      message: 'AI_INVALID_OUTPUT',
    });
  });

  it('rejects an unsupported model before sending aggregate data', async () => {
    await expect(service.generate(snapshot, 'gemini-fixture')).rejects.toThrow(
      'AI_PROVIDER_REJECTED',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unknown evidence',
      {
        ...analysis,
        findings: [{ ...analysis.findings[0], metricKeys: ['employeeSalary'] }],
      },
    ],
    ['invented numbers', { ...analysis, limitations: ['Doanh thu tang 50%.'] }],
    [
      'external links',
      { ...analysis, limitations: ['Mo https://outside.test de xem.'] },
    ],
    ['additional fields', { ...analysis, executeSql: 'DELETE FROM Invoice' }],
    [
      'provider observations',
      {
        ...analysis,
        findings: [
          {
            ...analysis.findings[0],
            kind: 'OBSERVATION',
            detail: 'Thuc thu giam so voi ky truoc.',
          },
        ],
      },
    ],
    [
      'provider summary',
      { ...analysis, summary: 'Thuc thu giam so voi ky truoc.' },
    ],
  ])('rejects %s without returning model content', async (_name, output) => {
    fetchSpy.mockResolvedValue(respond(output));
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toThrow('AI_INVALID_OUTPUT');
  });

  it('rejects truncation and oversized provider output', async () => {
    fetchSpy.mockResolvedValueOnce(respond(analysis, 'MAX_TOKENS'));
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    fetchSpy.mockResolvedValueOnce(new Response('x'.repeat(70_000)));
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toThrow('AI_INVALID_OUTPUT');
  });

  it.each([
    ['missing', null],
    ['empty', ''],
  ])('rejects %s response bodies permanently', async (_name, body) => {
    fetchSpy.mockResolvedValue(new Response(body));
    const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
    await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(pending).rejects.toMatchObject({
      message: 'AI_INVALID_OUTPUT',
    });
  });

  it('keeps oversized output permanent even when cancelling the body fails', async () => {
    const cancel = jest
      .fn()
      .mockRejectedValue(new Error('credential-in-cancel-error'));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(65_537));
      },
      cancel,
    });
    fetchSpy.mockResolvedValue(new Response(body));
    const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
    await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(pending).rejects.toMatchObject({
      message: 'AI_INVALID_OUTPUT',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each(['envelope', 'analysis'])(
    'rejects malformed %s JSON permanently',
    async (part) => {
      const malformed = 'credential-in-malformed-json';
      fetchSpy.mockResolvedValue(
        new Response(
          part === 'envelope'
            ? malformed
            : JSON.stringify({
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { parts: [{ text: malformed }] },
                  },
                ],
              }),
        ),
      );
      const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
      await expect(pending).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(pending).rejects.toMatchObject({
        message: 'AI_INVALID_OUTPUT',
      });
    },
  );

  it('treats a body disconnect after headers as a retryable transport failure', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(Buffer.from('{"candidates":'));
        } else {
          controller.error(new Error('credential-in-body-disconnect'));
        }
      },
    });
    fetchSpy.mockResolvedValue(new Response(body));
    const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
    await expect(pending).rejects.not.toBeInstanceOf(UnrecoverableError);
    await expect(pending).rejects.toMatchObject({
      message: 'AI_PROVIDER_UNAVAILABLE',
    });
    expect(body.locked).toBe(false);
  });

  it.each(['timeout', 'shutdown'])(
    'keeps %s during body streaming retryable',
    async (reason) => {
      const timeout = new AbortController();
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(timeout.signal);
      let reading!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      });
      fetchSpy.mockImplementation((_url: string, options: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('{'));
                options.signal?.addEventListener(
                  'abort',
                  () => controller.error(options.signal?.reason),
                  { once: true },
                );
              },
              pull() {
                reading();
              },
            }),
          ),
        ),
      );
      const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
      await readStarted;
      if (reason === 'timeout')
        timeout.abort(
          new DOMException('credential-in-timeout', 'TimeoutError'),
        );
      else service.stop();
      await expect(pending).rejects.not.toBeInstanceOf(UnrecoverableError);
      await expect(pending).rejects.toMatchObject({
        message: 'AI_PROVIDER_UNAVAILABLE',
      });
      expect(timeoutSpy).toHaveBeenCalledWith(1_000);
    },
  );

  it('sanitizes provider errors and leaves retry to the queue', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('secret-provider-body', { status: 429 }),
    );
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toThrow('AI_PROVIDER_UNAVAILABLE');
    fetchSpy.mockResolvedValueOnce(
      new Response('secret-provider-body', { status: 401 }),
    );
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toThrow('AI_PROVIDER_REJECTED');
    fetchSpy.mockRejectedValueOnce(new Error('credential-in-raw-error'));
    await expect(
      service.generate(snapshot, 'gemini-3.5-flash-lite'),
    ).rejects.toThrow('AI_PROVIDER_UNAVAILABLE');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('cancels pending provider requests on shutdown', async () => {
    fetchSpy.mockImplementation(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const pending = service.generate(snapshot, 'gemini-3.5-flash-lite');
    service.stop();
    await expect(pending).rejects.toThrow('AI_PROVIDER_UNAVAILABLE');
  });
});
