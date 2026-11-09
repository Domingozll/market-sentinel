import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestRuntime, type TestRuntime } from '../helpers/test-runtime';
import { wait } from '../helpers/fake-market';

let t: TestRuntime | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

function makeWebRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-web-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Sentinel test</title><div id="root"></div>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("ok")');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=never-serve');
  return dir;
}

describe('secure static file service', () => {
  it('serves the SPA and assets with safe headers, without traversal or dotfiles', async () => {
    const webRoot = makeWebRoot();
    t = await buildTestRuntime({ serveStatic: true, webDist: webRoot });
    const root = await t.runtime.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    expect(root.headers['x-content-type-options']).toBe('nosniff');
    expect(root.body).toContain('Sentinel test');

    const spa = await t.runtime.app.inject({ method: 'GET', url: '/rules/abc/edit' });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['cache-control']).toBe('no-store');
    expect(spa.body).toContain('Sentinel test');

    const asset = await t.runtime.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.body).toContain('console.log');

    const missingAsset = await t.runtime.app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers['content-type']).toContain('application/json');

    const hidden = await t.runtime.app.inject({ method: 'GET', url: '/.env' });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain('never-serve');

    const traversal = await t.runtime.app.inject({
      method: 'GET',
      url: '/assets/%2e%2e/%2e%2e/etc/passwd',
    });
    // Some HTTP layers normalize the path before routing; regardless, it must never
    // leave the web root. A normalized path may legitimately fall back to the SPA shell.
    expect(traversal.body).not.toContain('root:');
    if (traversal.statusCode === 200) expect(traversal.body).toContain('Sentinel test');
    else expect([400, 404]).toContain(traversal.statusCode);
    const traversalAsset = await t.runtime.app.inject({
      method: 'GET',
      url: '/assets/%2e%2e/%2e%2e/etc/secret.txt',
    });
    expect(traversalAsset.statusCode).toBe(404);
    expect(traversalAsset.body).not.toContain('never-serve');

    const api404 = await t.runtime.app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(api404.statusCode).toBe(404);
    expect(api404.body).toContain('接口不存在');

    const post404 = await t.runtime.app.inject({ method: 'POST', url: '/somewhere' });
    expect(post404.statusCode).toBe(404);

    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  it('reports 404 for frontend assets when the build is absent', async () => {
    t = await buildTestRuntime();
    const response = await t.runtime.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('前端资源尚未构建');
  });
});

describe('SSE stream', () => {
  it('sends the initial event and forwards refresh notifications', async () => {
    t = await buildTestRuntime();
    await t.runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const address = t.runtime.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.includes(needle)) return true;
      }
      return false;
    };
    expect(await readUntil('event: refresh')).toBe(true);
    expect(buffer).toContain('connected');
    t.runtime.bus.emit('refresh', { type: 'test-refresh', at: Date.now() });
    expect(await readUntil('test-refresh')).toBe(true);
    controller.abort();
    await wait(20);
  });
});
