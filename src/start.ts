import 'dotenv/config';

async function start() {
  let cleanupTelemetry: (() => Promise<void>) | undefined;
  try {
    const { validateEnvironment } = await import('./config/environment.js');
    const environment = validateEnvironment(process.env);
    if (environment.OTEL_ENABLED) {
      process.env.OTEL_SERVICE_NAME ??= environment.APP_NAME;
      process.env.OTEL_TRACES_EXPORTER ??= 'otlp';
      process.env.OTEL_METRICS_EXPORTER ??= 'none';
      process.env.OTEL_LOGS_EXPORTER ??= 'none';
      process.env.OTEL_TRACES_SAMPLER ??= 'parentbased_traceidratio';
      process.env.OTEL_TRACES_SAMPLER_ARG ??= String(
        environment.OTEL_TRACES_SAMPLER_ARG,
      );
      const { shutdownTelemetry, startTelemetry } =
        await import('./instrumentation.js');
      startTelemetry();
      cleanupTelemetry = shutdownTelemetry;
    }

    const { bootstrap } = await import('./main.js');
    await bootstrap(cleanupTelemetry);
  } catch (error) {
    await cleanupTelemetry?.();
    console.error('Application bootstrap failed.', error);
    process.exitCode = 1;
  }
}

void start();
