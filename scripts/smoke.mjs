#!/usr/bin/env node
/**
 * Dependency-free smoke test for a running Market Sentinel instance.
 *
 *   npm run smoke
 *   APP_BASE_URL=http://127.0.0.1:8787 npm run smoke
 */
const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const checks = [
  ['health', '/api/health', (body) => body.status === 'ok'],
  ['status', '/api/status', (body) => typeof body.ok === 'boolean'],
  ['dashboard', '/api/dashboard', (body) => Array.isArray(body.rules)],
  ['diagnostics', '/api/diagnostics', (body) => body.app?.ok === true],
  ['rules', '/api/rules', (body) => Array.isArray(body.rules)],
  ['events', '/api/events?limit=1', (body) => Array.isArray(body.events)],
  ['favicon', '/favicon.svg', null, 'image/svg+xml'],
  ['spa', '/', null, 'text/html'],
];

let failed = 0;
for (const [name, path, validate, expectedType] of checks) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
    const contentType = response.headers.get('content-type') || '';
    let body = null;
    if (contentType.includes('application/json')) body = await response.json();
    else await response.text();
    const typeOk = !expectedType || contentType.includes(expectedType);
    const validationOk = !validate || (body && validate(body));
    if (!response.ok || !typeOk || !validationOk) {
      failed++;
      console.error(`✗ ${name.padEnd(12)} HTTP ${response.status} ${contentType} ${path}`);
    } else {
      console.log(`✓ ${name.padEnd(12)} HTTP ${response.status} ${path}`);
    }
  } catch (error) {
    failed++;
    console.error(`✗ ${name.padEnd(12)} ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) {
  console.error(`\n${failed} smoke check(s) failed against ${base}`);
  process.exit(1);
}
console.log(`\nAll smoke checks passed against ${base}`);
