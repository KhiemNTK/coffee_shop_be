import { runAiSmoke } from './ai-smoke';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('operator Gemini smoke command', () => {
  const environment = {
    GEMINI_API_KEY: 'fixture-key-never-printed-in-output',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_DATA_POLICY_ACKNOWLEDGED: 'true',
  };
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requires an explicit live flag and policy acknowledgement before any outbound call', async () => {
    expect(await runAiSmoke([], {})).toMatchObject({ status: 'SKIPPED' });
    await expect(
      runAiSmoke(['--live'], {
        ...environment,
        GEMINI_DATA_POLICY_ACKNOWLEDGED: 'false',
      }),
    ).rejects.toThrow();
    await expect(
      runAiSmoke(['--live', '--case', 'no-sales'], environment),
    ).rejects.toThrow('AI_SMOKE_CASE_INVALID');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes exactly one fixture call, validates it and prints neither credentials nor narrative', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        {
                          title: 'Fixture hypothesis',
                          kind: 'HYPOTHESIS',
                          detail: 'Private narrative not printed',
                          metricKeys: ['netReceipts'],
                          action: 'Check the report.',
                        },
                      ],
                      limitations: ['Human review required.'],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { totalTokenCount: 25 },
        }),
      ),
    );
    const result = await runAiSmoke(['--live'], environment);
    expect(result).toMatchObject({
      status: 'PASSED',
      reportedTokens: 25,
      findingCount: 1,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('Private narrative');
    expect(JSON.stringify(result)).not.toContain(environment.GEMINI_API_KEY);
  });

  it('does not retry provider failures and exposes only a bounded error code', async () => {
    fetchSpy.mockResolvedValue(
      new Response('secret error body', { status: 429 }),
    );
    const result = await runAiSmoke(['--live'], environment);
    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('writes only an explicitly requested synthetic review artifact and refuses overwrite before a second call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coffee-ai-smoke-'));
    const path = join(directory, 'review.json');
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      findings: [
                        {
                          title: 'Hypothesis',
                          kind: 'HYPOTHESIS',
                          detail: 'Check the cohort.',
                          metricKeys: ['netReceipts'],
                          action: 'Review receipts.',
                        },
                      ],
                      limitations: ['No cause verified.'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    try {
      expect(
        await runAiSmoke(['--live', '--review-file', path], environment),
      ).toMatchObject({ status: 'PASSED' });
      const artifact = JSON.parse(await readFile(path, 'utf8')) as {
        syntheticDataOnly: boolean;
        humanReview: { approved: boolean };
      };
      expect(artifact.syntheticDataOnly).toBe(true);
      expect(artifact.humanReview.approved).toBe(false);
      expect(JSON.stringify(artifact)).not.toContain(
        environment.GEMINI_API_KEY,
      );
      await expect(
        runAiSmoke(['--live', '--review-file', path], environment),
      ).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await unlink(path).catch(() => {});
      await rmdir(directory);
    }
  });
});
