import { useEffect, useState, type ReactNode } from 'react';

export function FilterPanel({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <div className="filters" role="search">
      {children}
      {onReset && (
        <button type="button" className="btn btn-small btn-ghost" onClick={onReset}>
          Clear filters
        </button>
      )}
    </div>
  );
}

export function SelectFilter({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Text filter that applies after a short pause so typing doesn't fire a request per key. */
export function TextFilter({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onChange(v.trim()), 350);
    return () => clearTimeout(t);
  }, [v, value, onChange]);
  return (
    <label className="field">
      <span>{label}</span>
      <input type="search" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
    </label>
  );
}

export function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
