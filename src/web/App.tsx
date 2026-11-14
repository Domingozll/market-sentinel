import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  CircleDot,
  LayoutDashboard,
  Settings,
  SlidersHorizontal,
  WifiOff,
} from 'lucide-react';
import { formatClockCst } from './lib/format';
import { NOTIFICATION_CHANNEL_LABEL } from '../shared/types';
import { useAppData } from './context';
import { DashboardPage } from './pages/DashboardPage';
import { RulesPage } from './pages/RulesPage';
import { RuleEditorPage } from './pages/RuleEditorPage';
import { EventsPage } from './pages/EventsPage';
import { SettingsPage } from './pages/SettingsPage';

const navItems = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/rules', label: '规则', icon: SlidersHorizontal },
  { to: '/events', label: '事件', icon: Bell },
  { to: '/settings', label: '设置', icon: Settings },
];

function pageTitle(pathname: string): string {
  if (pathname === '/') return '总览';
  if (pathname === '/rules') return '规则';
  if (pathname === '/rules/new') return '新建规则';
  if (/^\/rules\/[^/]+\/edit$/.test(pathname)) return '编辑规则';
  if (pathname === '/events') return '事件';
  if (pathname === '/settings') return '设置';
  return '行情哨兵';
}

function topbarState(wsState: string | undefined, wsConnected: boolean | undefined) {
  if (wsConnected) return { text: '行情正常', className: 'market-state', dot: 'green-dot' };
  if (wsState === 'idle') return { text: '行情待机', className: 'market-state', dot: 'warn-dot' };
  if (wsState === 'connecting') return { text: '连接中', className: 'market-state', dot: 'blue-dot' };
  return { text: '行情中断', className: 'market-state', dot: 'red-dot' };
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data, loading } = useAppData();
  const title = pageTitle(location.pathname);
  const rulesActive = location.pathname.startsWith('/rules');
  const ws = topbarState(data?.status.wsState, data?.status.wsConnected);
  const activeRules = data?.stats.activeRules ?? 0;
  const todayEvents = data?.stats.todayEvents ?? 0;
  const notificationsConfigured = data?.settings.notificationsConfigured ?? false;
  const notificationChannel = data?.settings.notificationChannel ?? 'discord';

  useEffect(() => {
    document.title = `${title} · 行情哨兵`;
  }, [title]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => navigate('/')} role="button" tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter') navigate('/'); }}>
          <BrandMark />
          <div>
            <div className="brand-name">行情哨兵</div>
            <div className="brand-sub">MARKET SENTINEL</div>
          </div>
        </div>
        <div className="nav-group">
          <div className="nav-label">工作台</div>
          <nav aria-label="主导航">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.end ? location.pathname === item.to : item.to === '/rules' ? rulesActive : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={`nav-item${active ? ' active' : ''}`}
                  end={item.end}
                >
                  <Icon size={17} strokeWidth={1.8} />
                  <span>{item.label}</span>
                  {item.to === '/rules' && activeRules > 0 ? <span className="nav-count">{activeRules}</span> : null}
                  {item.to === '/events' && todayEvents > 0 ? <span className="nav-count">{todayEvents}</span> : null}
                </NavLink>
              );
            })}
          </nav>
        </div>
        <div className="sidebar-spacer" />
        <div className="side-status">
          <div className="side-status-head">
            {data?.status.wsConnected ? <span className="green-dot" /> : <WifiOff size={11} color="#d7a96a" />}
            {data?.status.wsConnected ? 'OKX 行情已连接' : 'OKX 行情未连接'}
          </div>
          <div className="side-status-meta">
            <span>WS · 公共业务频道</span>
            <span>{data?.stats.marketLatencyMs !== null && data?.stats.marketLatencyMs !== undefined ? `${data.stats.marketLatencyMs} ms` : '—'}</span>
          </div>
        </div>
        <div className="side-foot">
          <span>仅提醒，不自动下单</span>
          <span className="version">v{data?.status.version ?? '1.0.0'}</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <BrandMark />
            <span>行情哨兵</span>
          </div>
          <div className="crumb">
            工作台 <span className="sep">/</span> <b>{title}</b>
            <ChevronRight size={11} color="#3b4c5d" />
            <span>{loading ? '同步中…' : '实时同步'}</span>
          </div>
          <div className="top-right">
            <div className={ws.className}>
              <span className={ws.dot} /> {ws.text}
              <span className="latency">
                {data?.stats.marketLatencyMs !== null && data?.stats.marketLatencyMs !== undefined
                  ? `${data.stats.marketLatencyMs} ms`
                  : data?.status.wsState === 'idle'
                    ? '暂无订阅'
                    : '—'}
              </span>
            </div>
            <div className="discord-state">
              <span className={notificationsConfigured ? 'green-dot' : 'warn-dot'} />
              {NOTIFICATION_CHANNEL_LABEL[notificationChannel]} {notificationsConfigured ? '已配置' : '未配置'}
            </div>
            <LiveClock />
            <div className="avatar" title="本地运行">
              <CircleDot size={13} />
            </div>
          </div>
        </header>

        <main className="content">
          {data?.status.wsState === 'disconnected' ? (
            <div className="error-banner" role="status">
              行情连接中断，正在重连。数据恢复后会重建规则基线，不会补发旧信号。
            </div>
          ) : null}
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/rules" element={<RulesPage />} />
            <Route path="/rules/new" element={<RuleEditorPage />} />
            <Route path="/rules/:id/edit" element={<RuleEditorPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
        <circle cx="12" cy="12" r="5.1" stroke="currentColor" strokeWidth="1.3" opacity=".7" />
        <circle cx="12" cy="12" r="1.8" fill="currentColor" />
        <path d="M12 12 18.6 5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="page-wrap">
      <div className="empty-state" style={{ marginTop: 40 }}>
        <div className="es-title">页面不存在</div>
        <div className="es-desc">这个地址没有对应的页面。</div>
        <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
          返回总览
        </button>
      </div>
    </div>
  );
}


function LiveClock() {
  const [clock, setClock] = useState(() => formatClockCst());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(formatClockCst()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="clock">{clock}</span>;
}
