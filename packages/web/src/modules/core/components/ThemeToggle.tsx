import { MoonIcon, SunIcon } from 'lucide-react';

import { Button } from '@repo/ui/shadcn/button';

// index.html reads this key before first paint so a reload never flashes the other theme.
export const THEME_STORAGE_KEY = 'cc-theme';

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
  } catch {
    // Blocked storage only loses persistence; the theme still switches for this page.
  }
}

export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label="Toggle theme"
      data-testid="theme-toggle"
    >
      <SunIcon className="dark:hidden" />
      <MoonIcon className="hidden dark:block" />
    </Button>
  );
}
