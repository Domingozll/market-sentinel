import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';

export class NetworkContext {
  private proxyUrl = '';
  private dispatcher: Dispatcher | undefined;
  private wsAgent: HttpsProxyAgent<string> | undefined;

  updateProxy(proxyUrl: string): boolean {
    const normalized = proxyUrl.trim();
    if (normalized === this.proxyUrl) return false;
    this.proxyUrl = normalized;
    this.dispose();
    return true;
  }

  getProxyUrl(): string {
    return this.proxyUrl;
  }

  getDispatcher(): Dispatcher | undefined {
    if (!this.proxyUrl) return undefined;
    if (!this.dispatcher) {
      this.dispatcher = new ProxyAgent(this.proxyUrl);
    }
    return this.dispatcher;
  }

  getWebSocketAgent(): HttpsProxyAgent<string> | undefined {
    if (!this.proxyUrl) return undefined;
    if (!this.wsAgent) {
      this.wsAgent = new HttpsProxyAgent(this.proxyUrl);
    }
    return this.wsAgent;
  }

  async fetch(url: string, init: Omit<RequestInit, 'dispatcher'> = {}): Promise<Response> {
    const dispatcher = this.getDispatcher();
    return undiciFetch(url, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
    } as any) as unknown as Promise<Response>;
  }

  dispose(): void {
    if (this.dispatcher) {
      void Promise.resolve(this.dispatcher.close()).catch(() => undefined);
      this.dispatcher = undefined;
    }
    if (this.wsAgent) {
      try {
        this.wsAgent.destroy();
      } catch {
        // ignore
      }
      this.wsAgent = undefined;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateProxyUrl(value: string): string | null {
  if (!value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '代理地址不是合法 URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '代理地址必须以 http:// 或 https:// 开头';
  if (parsed.username || parsed.password) {
    // Credentials in URLs are supported by the agent, but must not be echoed to logs.
  }
  return null;
}
