import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { api, type DashboardResponse } from './api';

const LiveContext = createContext(0);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/stream');
      source.addEventListener('refresh', () => {
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setVersion((value) => value + 1), 350);
      });
      source.onerror = () => {
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          window.setTimeout(connect, 3000);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (source) source.close();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);
  return <LiveContext.Provider value={version}>{children}</LiveContext.Provider>;
}

export function useLiveVersion(): number {
  return useContext(LiveContext);
}

interface DataContextValue {
  data: DashboardResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const version = useLiveVersion();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const next = await api.dashboard();
        setData(next);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = task;
    return task;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const value = useMemo(() => ({ data, loading, error, refresh }), [data, loading, error, refresh]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useAppData(): DataContextValue {
  const context = useContext(DataContext);
  if (!context) throw new Error('useAppData must be used inside DataProvider');
  return context;
}

export type ToastTone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
interface ToastContextValue {
  showToast: (message: string, tone?: ToastTone) => void;
}
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const showToast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++counter.current;
    setItems((previous) => [...previous, { id, message, tone }].slice(-4));
    window.setTimeout(() => {
      setItems((previous) => previous.filter((item) => item.id !== id));
    }, 4200);
  }, []);
  const dismiss = (id: number) => setItems((previous) => previous.filter((item) => item.id !== id));
  const value = useMemo(() => ({ showToast }), [showToast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast-item ${item.tone}`}>
            {item.tone === 'success' ? (
              <CheckCircle2 size={15} />
            ) : item.tone === 'error' ? (
              <TriangleAlert size={15} />
            ) : (
              <Info size={15} />
            )}
            <span className="grow">{item.message}</span>
            <button
              type="button"
              aria-label="关闭提示"
              style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}
              onClick={() => dismiss(item.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
