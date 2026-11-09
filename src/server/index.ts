import process from 'node:process';
import { createRuntime, startRuntime } from './app';

process.umask(0o077);

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const address = await startRuntime(runtime);
  // Keep startup output free of secrets; only the local address is logged.
  console.log(`[market-sentinel] listening on ${address}`);
  console.log(`[market-sentinel] OKX REST ${runtime.config.okxRestBase}`);
  console.log(`[market-sentinel] WebSocket ${runtime.config.okxWsUrl}`);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[market-sentinel] received ${signal}, shutting down`);
    try {
      await runtime.stop();
    } catch (error) {
      console.error('[market-sentinel] shutdown error', error);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[market-sentinel] unhandled rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[market-sentinel] uncaught exception', error);
  });
}

main().catch((error) => {
  console.error('[market-sentinel] failed to start', error);
  process.exit(1);
});
