import type { ReactNode } from 'react';
import { nf } from '../lib/format';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  wrap?: boolean; // cells don't wrap unless the column allows it (long text)
}

/** Compact data table. Rows are clickable when `onRow` is given (Enter/Space for keyboard users). */
export function DataTable<T>({ rows, columns, rowKey, onRow, caption, selected }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRow?: (r: T) => void;
  caption?: string;
  selected?: string | null;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align || 'left', width: c.width }} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = rowKey(r);
            return (
              <tr
                key={k}
                className={`${onRow ? 'clickable' : ''} ${selected === k ? 'selected' : ''}`}
                onClick={onRow ? () => onRow(r) : undefined}
                onKeyDown={onRow ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRow(r)) : undefined}
                tabIndex={onRow ? 0 : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align || 'left', whiteSpace: c.wrap ? 'normal' : undefined }}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted small">
        {total === 0 ? 'No rows' : `${nf.format(offset + 1)}–${nf.format(Math.min(offset + limit, total))} of ${nf.format(total)}`}
      </span>
      <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => onChange(0)} aria-label="First page">
        «
      </button>
      <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <span className="small">
        Page {page} / {pages}
      </span>
      <button type="button" className="btn btn-small" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
        Next
      </button>
      <button type="button" className="btn btn-small" disabled={page >= pages} onClick={() => onChange((pages - 1) * limit)} aria-label="Last page">
        »
      </button>
    </nav>
  );
}
