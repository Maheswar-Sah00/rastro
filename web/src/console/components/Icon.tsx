// One small stroke icon set (24px grid, 1.6 stroke) so every icon in the console looks alike.
const PATHS: Record<string, string> = {
  overview: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  ranch: 'M3 11 12 4l9 7M5 10v10h14V10M10 20v-6h4v6',
  movement: 'M4 7h13l-3-3M20 17H7l3 3',
  shipment: 'M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-.01M17 19a2 2 0 1 0 0-.01',
  investigation: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  certificate: 'M6 3h12v14l-6 4-6-4zM9 9h6M9 13h4',
  ledger: 'M4 5h16v4H4zM4 11h16v4H4zM4 17h16v2H4z',
  evaluation: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  sources: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  close: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 3 2 20h20zM12 10v4M12 17v.01',
  check: 'M4 12l5 5L20 6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7v.01',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17l10 5 10-5',
  chevron: 'M9 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};

export function Icon({ name, size = 16, title }: { name: keyof typeof PATHS | string; size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className="icon"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name] || PATHS.info} />
    </svg>
  );
}
