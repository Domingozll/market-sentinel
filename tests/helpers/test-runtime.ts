import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, type Runtime } from '../../src/server/app';
import type { DiscordTransport } from '../../src/server/alerts/discord';
import type { PushplusTransport } from '../../src/server/alerts/pushplus';
import { FakeMarket } from './fake-market';

export interface TestRuntime {
  runtime: Runtime;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function buildTestRuntime(options: {
  market?: FakeMarket;
  transport?: DiscordTransport;
  pushplusTransport?: PushplusTransport;
  engineTiming?: { settleMs?: number; tickThrottleMs?: number; baselineDelayMs?: number };
  serveStatic?: boolean;
  webDist?: string;
} = {}): Promise<TestRuntime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-api-'));
  const market = options.market ?? new FakeMarket();
  const runtime = await createRuntime({
    dataDir: dir,
    market,
    discordTransport: options.transport,
    pushplusTransport: options.pushplusTransport,
    allowNonOfficialDiscord: true,
    serveStatic: options.serveStatic ?? false,
    logger: false,
    engineTiming: {
      settleMs: options.engineTiming?.settleMs ?? 0,
      tickThrottleMs: options.engineTiming?.tickThrottleMs ?? 0,
      baselineDelayMs: options.engineTiming?.baselineDelayMs ?? 0,
    },
    config: { dataDir: dir, ...(options.webDist ? { webDist: options.webDist } : {}) },
  });
  await runtime.engine.start();
  return {
    runtime,
    dir,
    cleanup: async () => {
      try {
        await runtime.stop();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export async function jsonRequest(
  runtime: Runtime,
  options: { method: string; url: string; payload?: unknown; headers?: Record<string, string> },
): Promise<{ statusCode: number; body: any }> {
  const response = await runtime.app.inject({
    method: options.method as any,
    url: options.url,
    payload: options.payload as any,
    headers: options.headers,
  });
  let body: unknown = null;
  try {
    body = response.body ? JSON.parse(response.body) : null;
  } catch {
    body = response.body;
  }
  return { statusCode: response.statusCode, body };
}
