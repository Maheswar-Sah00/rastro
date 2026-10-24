import type { ReactNode } from 'react';

// Plain-language note under each section and console page, saying what it shows. Temporary: set SHOW_EXPLAIN
// to false to hide every note at once, or delete the <Explain> lines (grep "<Explain") and this file.
export const SHOW_EXPLAIN = true;

export function Explain({ children }: { children: ReactNode }) {
  if (!SHOW_EXPLAIN) return null;
  return (
    <p className="explain">
      <em>{children}</em>
    </p>
  );
}
