import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Check,
  Database,
  Globe,
  Loader2,
  MessageCircle,
  Plug,
  RefreshCw,
  Save,
  ShieldCheck,
  TriangleAlert,
  Wifi,
} from 'lucide-react';
import { NOTIFICATION_CHANNEL_LABEL, type DiagnosticInfo, type NotificationChannel, type PublicSettings } from '../../shared/types';
import { api } from '../api';
import { useAppData, useLiveVersion, useToast } from '../context';
import {
  formatCompact,
  MARKET_STATE_LABEL,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatTime,
} from '../lib/format';
import {
  ConfirmDialog,
  ErrorBanner,
  LoadingBlock,
  PageHeader,
  StatusPill,
} from '../components/ui';

interface TestFeedback {
  type: 'okx-direct' | 'okx-proxy' | 'discord' | 'pushplus';
  ok: boolean;
  message: string;
}

export function SettingsPage() {
  const { data, refresh } = useAppData();
  const liveVersion = useLiveVersion();
  const { showToast } = useToast();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webhookInput, setWebhookInput] = useState('');
  const [clearWebhookOpen, setClearWebhookOpen] = useState(false);
  const [notificationChannel, setNotificationChannel] = useState<NotificationChannel>('discord');
  const [pushplusTokenInput, setPushplusTokenInput] = useState('');
  const [pushplusTopic, setPushplusTopic] = useState('');
  const [clearPushplusOpen, setClearPushplusOpen] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [useProxyForDiscord, setUseProxyForDiscord] = useState(true);
  const [cooldownMinutes, setCooldownMinutes] = useState(5);
  const [retentionDays, setRetentionDays] = useState(90);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testFeedback, setTestFeedback] = useState<TestFeedback | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.settings(), api.diagnostics()])
      .then(([settingsResult, diagnosticsResult]) => {
        if (!active) return;
        setSettings(settingsResult.settings);
        setDiagnostics(diagnosticsResult);
        setNotificationChannel(settingsResult.settings.notificationChannel);
        setPushplusTopic(settingsResult.settings.pushplusTopic);
        setProxyUrl(settingsResult.settings.proxyUrl);
        setUseProxyForDiscord(settingsResult.settings.useProxyForDiscord);
        setCooldownMinutes(Math.round(settingsResult.settings.defaultCooldownSec / 60));
        setRetentionDays(settingsResult.settings.eventRetentionDays);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    api.diagnostics()
      .then((result) => {
        if (active) setDiagnostics(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [liveVersion]);

  const webhookConfigured = Boolean(settings?.discordConfigured);
  const pushplusConfigured = Boolean(settings?.pushplusConfigured);
  const deliveryQueue = diagnostics?.deliveryQueue;
  const status = data?.status ?? diagnostics?.app;
  const marketPairs = diagnostics?.marketPairs ?? data?.marketPairs ?? [];

  const testResultText = useMemo(() => {
    if (!testFeedback) return null;
    return testFeedback.message;
  }, [testFeedback]);

  async function saveSettings() {
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Record<string, unknown> = {
        notificationChannel,
        proxyUrl: proxyUrl.trim(),
        useProxyForDiscord,
        defaultCooldownSec: Math.max(0, Math.min(86_400, Math.round(cooldownMinutes * 60))),
        eventRetentionDays: Math.max(1, Math.min(3650, Math.round(retentionDays))),
      };
      if (webhookInput.trim()) payload.discordWebhookUrl = webhookInput.trim();
      if (clearWebhookOpen) payload.discordWebhookUrl = null;
      payload.pushplusTopic = pushplusTopic.trim();
      if (pushplusTokenInput.trim()) payload.pushplusToken = pushplusTokenInput.trim();
      const result = await api.saveSettings(payload);
      setSettings(result.settings);
      setWebhookInput('');
      setClearWebhookOpen(false);
      setPushplusTokenInput('');
      setNotificationChannel(result.settings.notificationChannel);
      setPushplusTopic(result.settings.pushplusTopic);
      setProxyUrl(result.settings.proxyUrl);
      setUseProxyForDiscord(result.settings.useProxyForDiscord);
      setCooldownMinutes(Math.round(result.settings.defaultCooldownSec / 60));
      setRetentionDays(result.settings.eventRetentionDays);
      await refresh();
      showToast(payload.proxyUrl !== undefined ? '设置已保存，若代理发生变化行情会自动重连。' : '设置已保存。', 'success');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testOkx(mode: 'direct' | 'proxy') {
    setTesting(mode);
    setTestFeedback(null);
    try {
      const result = await api.testOkx(mode === 'direct' ? '' : proxyUrl.trim());
      setTestFeedback({
        type: mode === 'direct' ? 'okx-direct' : 'okx-proxy',
        ok: true,
        message: `OKX REST 连通 · ${formatLatency(result.latencyMs)} · 服务器时间 ${formatDateTime(result.serverNow)}`,
      });
    } catch (error) {
      setTestFeedback({
        type: mode === 'direct' ? 'okx-direct' : 'okx-proxy',
        ok: false,
        message: `OKX 连接失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTesting(null);
    }
  }

  async function testPushplus() {
    setTesting('pushplus');
    setTestFeedback(null);
    try {
      const result = await api.testPushplus(pushplusTokenInput.trim() || undefined, pushplusTopic.trim() || undefined);
      setTestFeedback({
        type: 'pushplus',
        ok: true,
        message: `PushPlus 已受理测试消息 · HTTP ${result.httpStatus}${result.messageId ? ` · 流水号 ${result.messageId}` : ''}，请在微信确认`,
      });
    } catch (error) {
      setTestFeedback({
        type: 'pushplus',
        ok: false,
        message: `PushPlus 测试失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTesting(null);
    }
  }

  async function testDiscord() {
    setTesting('discord');
    setTestFeedback(null);
    try {
      const result = await api.testDiscord(webhookInput.trim() || undefined);
      setTestFeedback({
        type: 'discord',
        ok: true,
        message: `Discord 测试消息已发送 · HTTP ${result.httpStatus}${result.messageId ? ` · 消息 ${result.messageId}` : ''}`,
      });
    } catch (error) {
      setTestFeedback({
        type: 'discord',
        ok: false,
        message: `Discord 测试失败：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setTesting(null);
    }
  }

  async function clearPushplusToken() {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.saveSettings({ pushplusToken: null });
      setSettings(result.settings);
      setPushplusTokenInput('');
      setClearPushplusOpen(false);
      await refresh();
      showToast('PushPlus Token 已移除。后续触发事件只会记录。', 'info');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function clearWebhook() {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.saveSettings({ discordWebhookUrl: null });
      setSettings(result.settings);
      setClearWebhookOpen(false);
      setWebhookInput('');
      await refresh();
      showToast('Webhook 已移除。后续触发事件只会记录，不会发送。', 'info');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !settings) return <LoadingBlock text="正在加载设置…" />;

  return (
    <div className="page-wrap">
      {loadError ? <ErrorBanner message={loadError} /> : null}
      {saveError ? <ErrorBanner message={saveError} /> : null}
      <PageHeader
        eyebrow="工作台"
        title="设置"
        subtitle="通知、网络与本地数据。所有配置只保存在本机。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => void saveSettings()} disabled={saving} data-testid="save-settings">
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            {saving ? '保存中…' : '保存设置'}
          </button>
        }
      />

      <section className="settings-block channel-selector">
        <div className="settings-block-head">
          <div>
            <div className="settings-block-title"><MessageCircle size={14} /> 通知渠道</div>
            <div className="settings-block-sub">Discord 与微信 PushPlus 二选一；同一时间只向一个渠道发送。</div>
          </div>
          <StatusPill tone={settings?.notificationsConfigured ? 'success' : 'warn'}>
            {settings?.notificationsConfigured ? '通道就绪' : '未配置'}
          </StatusPill>
        </div>
        <div className="settings-block-body">
          <div className="channel-grid" role="radiogroup" aria-label="通知渠道">
            <button
              type="button"
              role="radio"
              aria-checked={notificationChannel === 'discord'}
              className={`channel-option${notificationChannel === 'discord' ? ' selected' : ''}`}
              data-testid="notification-channel-discord"
              onClick={() => setNotificationChannel('discord')}
            >
              <span className="channel-option-icon"><Bell size={15} /></span>
              <span className="channel-option-copy">
                <strong>Discord</strong>
                <small>Webhook · Embed 消息</small>
              </span>
              <span className={`channel-badge${webhookConfigured ? ' on' : ''}`}>{webhookConfigured ? '已配置' : '未配置'}</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={notificationChannel === 'pushplus'}
              className={`channel-option${notificationChannel === 'pushplus' ? ' selected' : ''}`}
              data-testid="notification-channel-pushplus"
              onClick={() => setNotificationChannel('pushplus')}
            >
              <span className="channel-option-icon"><MessageCircle size={15} /></span>
              <span className="channel-option-copy">
                <strong>微信 PushPlus</strong>
                <small>微信公众号 · 文本推送</small>
              </span>
              <span className={`channel-badge${pushplusConfigured ? ' on' : ''}`}>{pushplusConfigured ? '已配置' : '未配置'}</span>
            </button>
          </div>
          <div className="muted-small" style={{ marginTop: 9 }}>
            当前使用：{NOTIFICATION_CHANNEL_LABEL[notificationChannel]}。切换后新事件使用新渠道；已排队事件保留触发时的渠道。
          </div>
        </div>
      </section>

      <div className="settings-columns">
        <div className="settings-stack">
          <section className="settings-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><Bell size={14} /> Discord Webhook</div>
                <div className="settings-block-sub">触发消息以 Embed 形式发送；保存后 URL 不再明文显示。</div>
              </div>
              <StatusPill tone={webhookConfigured ? 'success' : 'warn'}>{webhookConfigured ? '已配置' : '未配置'}</StatusPill>
            </div>
            <div className="settings-block-body">
              {webhookConfigured ? (
                <div className="masked-value" style={{ marginBottom: 8 }}>
                  <ShieldCheck size={13} />
                  <span>{settings?.discordWebhookMasked}</span>
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="webhook-input">{webhookConfigured ? '更换 Webhook URL（留空保持不变）' : 'Webhook URL'}</label>
                <input
                  id="webhook-input"
                  data-testid="webhook-input"
                  className="input input-mono"
                  type="password"
                  autoComplete="off"
                  value={webhookInput}
                  placeholder="https://discord.com/api/webhooks/…"
                  onChange={(event) => {
                    setWebhookInput(event.target.value);
                    setClearWebhookOpen(false);
                  }}
                />
                <span className="form-hint">只接受 Discord 官方域名。Webhook 被视为本机秘密，不写入日志或诊断导出。</span>
              </div>
              <div className="inline-actions" style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" data-testid="test-discord" onClick={() => void testDiscord()} disabled={testing !== null}>
                  {testing === 'discord' ? <Loader2 size={12} className="spin" /> : <Plug size={12} />}
                  发送测试消息
                </button>
                {webhookConfigured ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearWebhookOpen(true)} disabled={saving}>
                    移除 Webhook
                  </button>
                ) : null}
              </div>
              {testFeedback?.type === 'discord' ? (
                <div className={`test-feedback ${testFeedback.ok ? 'ok' : 'bad'}`}>{testFeedback.message}</div>
              ) : (
                <div className="test-feedback">
                  测试消息会发送到已保存或当前输入框中的 Webhook，但不会写入事件记录。
                </div>
              )}
            </div>
          </section>

          <section className="settings-block" data-testid="pushplus-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><MessageCircle size={14} /> 微信 PushPlus</div>
                <div className="settings-block-sub">通过 PushPlus 的微信通道接收纯文本提醒；Token 仅保存在本机。</div>
              </div>
              <StatusPill tone={pushplusConfigured ? 'success' : 'warn'}>{pushplusConfigured ? '已配置' : '未配置'}</StatusPill>
            </div>
            <div className="settings-block-body">
              {pushplusConfigured ? (
                <div className="masked-value" style={{ marginBottom: 8 }}>
                  <ShieldCheck size={13} />
                  <span>{settings?.pushplusTokenMasked}</span>
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="pushplus-token">{pushplusConfigured ? '更换 PushPlus Token（留空保持不变）' : 'PushPlus Token'}</label>
                <input
                  id="pushplus-token"
                  data-testid="pushplus-token"
                  className="input input-mono"
                  type="password"
                  autoComplete="off"
                  value={pushplusTokenInput}
                  placeholder="在 pushplus.plus 获取的 Token"
                  onChange={(event) => setPushplusTokenInput(event.target.value)}
                />
                <span className="form-hint">Token 不会出现在日志、诊断或 API 响应中；PushPlus 请使用微信扫码登录后获取。</span>
              </div>
              <div className="form-field" style={{ marginTop: 10 }}>
                <label htmlFor="pushplus-topic">群组编码（可选）</label>
                <input
                  id="pushplus-topic"
                  data-testid="pushplus-topic"
                  className="input input-mono"
                  value={pushplusTopic}
                  placeholder="一对多推送时填写 topic"
                  onChange={(event) => setPushplusTopic(event.target.value)}
                />
                <span className="form-hint">不填则发送到 Token 对应的默认微信接收人；最多 64 个字符。</span>
              </div>
              <div className="inline-actions" style={{ display: 'flex', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" data-testid="test-pushplus" onClick={() => void testPushplus()} disabled={testing !== null || (!pushplusConfigured && !pushplusTokenInput.trim())}>
                  {testing === 'pushplus' ? <Loader2 size={12} className="spin" /> : <Plug size={12} />}
                  发送测试消息
                </button>
                {pushplusConfigured ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearPushplusOpen(true)} disabled={saving}>
                    移除 Token
                  </button>
                ) : null}
              </div>
              {testFeedback?.type === 'pushplus' ? (
                <div className={`test-feedback ${testFeedback.ok ? 'ok' : 'bad'}`}>{testFeedback.message}</div>
              ) : (
                <div className="test-feedback">
                  PushPlus 测试消息不会写入事件记录。未配置 Token 时触发事件仍会记录，但状态为“未通知”。
                </div>
              )}
            </div>
          </section>

          <section className="settings-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><Globe size={14} /> 网络与 OKX 数据源</div>
                <div className="settings-block-sub">OKX 公共行情不需要 API Key；当前 WebSocket 使用 443 端口的业务频道。</div>
              </div>
              <StatusPill tone={status?.wsConnected ? 'success' : 'warn'}>{status?.wsConnected ? '连接正常' : '未连接'}</StatusPill>
            </div>
            <div className="settings-block-body">
              <div className="form-field">
                <label htmlFor="proxy-url">HTTP 代理（可选）</label>
                <div className="row">
                  <input
                    id="proxy-url"
                    data-testid="proxy-url"
                    className="input input-mono grow"
                    value={proxyUrl}
                    onChange={(event) => setProxyUrl(event.target.value)}
                    placeholder="http://127.0.0.1:7890"
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void testOkx('proxy')} disabled={testing !== null || !proxyUrl.trim()}>
                    {testing === 'proxy' ? <Loader2 size={12} className="spin" /> : '测试代理'}
                  </button>
                </div>
              </div>
              <label className="checkbox-line" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={useProxyForDiscord} onChange={(event) => setUseProxyForDiscord(event.target.checked)} />
                Discord 请求复用同一代理
              </label>
              <div className="inline-actions" style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void testOkx('direct')} disabled={testing !== null}>
                  {testing === 'direct' ? <Loader2 size={12} className="spin" /> : <Wifi size={12} />}
                  测试 OKX 直连
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setProxyUrl(''); setTestFeedback(null); }}>
                  清空代理
                </button>
              </div>
              {testFeedback?.type === 'okx-direct' || testFeedback?.type === 'okx-proxy' ? (
                <div className={`test-feedback ${testFeedback.ok ? 'ok' : 'bad'}`}>{testFeedback.message}</div>
              ) : null}
              <div className="endpoint-lines">
                <div><span className="k">REST</span><span className="v">{settings?.okxRestBase}</span></div>
                <div><span className="k">WS</span><span className="v">{settings?.okxWsUrl}</span></div>
                <div><span className="k">最近收盘</span><span className="v">{status?.wsConnected ? '实时接收中' : '等待连接'}</span></div>
              </div>
              <div className="muted-small" style={{ marginTop: 8 }}>
                修改代理后保存，行情连接会在后台重建，并重新建立规则基线，不会补发断线期间的旧信号。
              </div>
            </div>
          </section>

          <section className="settings-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><Database size={14} /> 数据与监控默认值</div>
                <div className="settings-block-sub">事件保留和新建规则的默认冷却时间。</div>
              </div>
            </div>
            <div className="settings-block-body">
              <div className="form-grid">
                <div className="form-field span-6">
                  <label htmlFor="retention-days">事件保留天数</label>
                  <input
                    id="retention-days"
                    className="input input-mono"
                    type="number"
                    min={1}
                    max={3650}
                    value={retentionDays}
                    onChange={(event) => setRetentionDays(Number(event.target.value))}
                  />
                  <span className="form-hint">默认 90 天；删除只影响本地事件记录，不删除规则。</span>
                </div>
                <div className="form-field span-6">
                  <label htmlFor="default-cooldown">新建规则默认冷却（分钟）</label>
                  <input
                    id="default-cooldown"
                    className="input input-mono"
                    type="number"
                    min={0}
                    max={1440}
                    value={cooldownMinutes}
                    onChange={(event) => setCooldownMinutes(Number(event.target.value))}
                  />
                  <span className="form-hint">只影响新建规则；既有规则保留自己的冷却时间。</span>
                </div>
              </div>
              <div className="data-number-grid" style={{ marginTop: 12 }}>
                <div className="diag-cell"><div className="k">事件总数</div><div className="v">{diagnostics?.dataCounts.events ?? '—'}</div></div>
                <div className="diag-cell"><div className="k">K 线缓存</div><div className="v">{diagnostics ? formatCompact(diagnostics.dataCounts.candles) : '—'}</div></div>
                <div className="diag-cell"><div className="k">数据库大小</div><div className="v">{diagnostics ? `${(diagnostics.dataCounts.databaseBytes / 1024 / 1024).toFixed(1)} MB` : '—'}</div></div>
              </div>
              <div className="muted-small" style={{ marginTop: 10 }}>
                数据保存在本机 <span className="mono">data/</span> 目录。1m K 线缓存保留 7 天，其他周期保留不少于 90 天。
              </div>
            </div>
          </section>
        </div>

        <div className="settings-stack">
          <section className="settings-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><ShieldCheck size={14} /> 运行诊断</div>
                <div className="settings-block-sub">数据源健康、发送队列和最近错误。</div>
              </div>
              <button type="button" className="icon-btn" title="刷新诊断" onClick={() => api.diagnostics().then(setDiagnostics).catch(() => undefined)}>
                <RefreshCw size={13} />
              </button>
            </div>
            <div className="settings-block-body">
              <div className="diag-grid">
                <div className="diag-cell"><div className="k">WebSocket</div><div className="v">{status?.wsConnected ? 'OK' : '断开'}</div></div>
                <div className="diag-cell"><div className="k">延迟</div><div className="v">{formatLatency(data?.stats.marketLatencyMs)}</div></div>
                <div className="diag-cell"><div className="k">发送队列</div><div className="v">{deliveryQueue?.pending ?? 0}</div></div>
              </div>
              <div className="divider" />
              <div className="section-label">行情订阅</div>
              {marketPairs.length ? marketPairs.map((pair) => (
                <div className="pair-health" key={`${pair.instId}-${pair.timeframe}`}>
                  <span>{pair.instId} · {pair.timeframe}</span>
                  <span className="ph-right">
                    <span className={`green-dot`} style={{ opacity: pair.state === 'healthy' ? 1 : 0.25 }} />
                    {MARKET_STATE_LABEL[pair.state] ?? pair.state} · {pair.bars} bars
                  </span>
                </div>
              )) : <div className="inline-empty">还没有订阅。创建并启用规则后会自动订阅行情。</div>}
              <div className="divider" />
              <div className="status-list-item"><span className="k">发送成功</span><span className="v ok">{deliveryQueue?.sent ?? 0}</span></div>
              <div className="status-list-item"><span className="k">待发送 / 发送中</span><span className="v">{deliveryQueue?.pending ?? 0}</span></div>
              <div className="status-list-item"><span className="k">发送失败</span><span className="v warn">{deliveryQueue?.dead ?? 0}</span></div>
              <div className="status-list-item"><span className="k">未通知</span><span className="v">{deliveryQueue?.skipped ?? 0}</span></div>
              <div className="divider" />
              <div className="section-label">最近错误</div>
              {diagnostics?.recentErrors.length ? diagnostics.recentErrors.slice(-5).reverse().map((error) => (
                <div key={`${error.at}-${error.message}`} className="form-section-note" style={{ marginBottom: 5, wordBreak: 'break-word' }}>
                  <span className="mono" style={{ color: '#5e7283' }}>{formatTime(error.at)}</span> · {error.message}
                </div>
              )) : <div className="inline-empty">暂无记录 · 最近一次检查 {formatTime(Date.now())}</div>}
            </div>
          </section>

          <section className="settings-block">
            <div className="settings-block-head">
              <div>
                <div className="settings-block-title"><Plug size={14} /> 关于与安全</div>
                <div className="settings-block-sub">本地单机应用，默认只监听 loopback。</div>
              </div>
            </div>
            <div className="settings-block-body">
              <div className="status-list-item"><span className="k">应用版本</span><span className="v">v{settingsVersion(status?.version)}</span></div>
              <div className="status-list-item"><span className="k">监听地址</span><span className="v">{window.location.host}</span></div>
              <div className="status-list-item"><span className="k">通知方式</span><span className="v">{NOTIFICATION_CHANNEL_LABEL[settings?.notificationChannel ?? 'discord']} · {settings?.notificationsConfigured ? '已配置' : '未配置'}</span></div>
              <div className="status-list-item"><span className="k">时区</span><span className="v">{settings?.timezone ?? 'Asia/Shanghai'}</span></div>
              <div className="test-feedback" style={{ marginTop: 11 }}>
                <TriangleAlert size={12} style={{ display: 'inline', verticalAlign: -2, marginRight: 5 }} />
                本工具只做行情提醒与记录，不自动下单，不构成投资建议。Webhook、PushPlus Token 和代理凭据不会回传前端，也不会出现在诊断导出中。
              </div>
            </div>
          </section>
        </div>
      </div>
      <div className="page-foot">
        <span>设置保存在本机 SQLite；网络变更只影响后台连接。</span>
        <span>LOCAL ONLY · LOOPBACK</span>
      </div>

      <ConfirmDialog
        open={clearWebhookOpen}
        title="移除 Discord Webhook"
        message="移除后，后续触发事件仍会记录，但不会发送 Discord 消息。历史投递记录不会被删除。"
        confirmText="移除 Webhook"
        danger
        busy={saving}
        onConfirm={() => void clearWebhook()}
        onCancel={() => setClearWebhookOpen(false)}
      />

      <ConfirmDialog
        open={clearPushplusOpen}
        title="移除 PushPlus Token"
        message="移除后，后续微信触发事件仍会记录，但不会发送 PushPlus 消息。历史投递记录不会被删除。"
        confirmText="移除 Token"
        danger
        busy={saving}
        onConfirm={() => void clearPushplusToken()}
        onCancel={() => setClearPushplusOpen(false)}
      />
    </div>
  );
}

function settingsVersion(version: string | undefined): string {
  return version ?? '1.0.0';
}
