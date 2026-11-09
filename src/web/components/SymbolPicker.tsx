import { useEffect, useRef, useState } from 'react';
import { api, type InstrumentInfo } from '../api';

export function SymbolPicker({
  selected,
  onChange,
  onError,
  testId = 'symbol-input',
}: {
  selected: string[];
  onChange: (symbols: string[]) => void;
  onError: (message: string) => void;
  testId?: string;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<InstrumentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      api.instruments(query)
        .then((result) => {
          if (active) {
            setSuggestions(
              result.instruments
                .filter((instrument) => !selected.includes(instrument.instId))
                .slice(0, 20),
            );
          }
        })
        .catch(() => {
          if (active) setSuggestions([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 260);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, selected]);

  const add = (symbol: string) => {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return;
    if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(normalized)) {
      onError('品种格式不合法');
      return;
    }
    if (selected.includes(normalized)) return;
    if (selected.length >= 10) {
      onError('单条规则最多选择 10 个品种');
      return;
    }
    onChange([...selected, normalized]);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="symbol-picker">
      <div className="selected-symbols" onClick={() => inputRef.current?.focus()}>
        {selected.map((symbol) => (
          <span className="sym-chip" key={symbol}>
            {symbol}
            <button
              type="button"
              aria-label={`移除 ${symbol}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(selected.filter((item) => item !== symbol));
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          data-testid={testId}
          aria-label="添加品种"
          placeholder={selected.length ? '添加品种…' : '搜索并添加 OKX 品种'}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
          onChange={(event) => {
            setQuery(event.target.value.toUpperCase());
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(query);
            }
            if (event.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      {open ? (
        <div className="suggestions">
          {loading ? <div className="suggestion-empty">正在搜索 OKX 品种…</div> : null}
          {!loading && suggestions.map((instrument) => (
            <button
              type="button"
              className="suggestion"
              key={instrument.instId}
              onMouseDown={(event) => {
                event.preventDefault();
                add(instrument.instId);
              }}
            >
              <span>{instrument.instId}</span>
              <span className="inst-type">{instrument.instType === 'SWAP' ? '永续' : '现货'}</span>
            </button>
          ))}
          {!loading && query && /^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(query) && !selected.includes(query) ? (
            <button
              type="button"
              className="suggestion"
              onMouseDown={(event) => {
                event.preventDefault();
                add(query);
              }}
            >
              <span>使用 {query}</span>
              <span className="inst-type">自定义</span>
            </button>
          ) : null}
          {!loading && !suggestions.length && !query ? (
            <div className="suggestion-empty">输入品种代码搜索，例如 BTC-USDT-SWAP</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
