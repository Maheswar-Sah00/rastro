import { switchTheme, useTheme } from '../lib/theme';

/** Light/dark toggle shared by the landing page and the console; the choice is remembered across both. */
export function ThemeButton() {
  const [theme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="theme-btn"
      onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        switchTheme(next, b.left + b.width / 2, b.top + b.height / 2);
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.8v2.2M12 19v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.8 12h2.2M19 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}
