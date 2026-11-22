import type { ObsyncTheme } from '../storage/types';

export interface ThemeMeta {
  id: ObsyncTheme;
  label: string;
  description: string;
  isDark: boolean;
  themeColor: string;
}

export const OBSYNC_THEMES: ThemeMeta[] = [
  {
    id: 'obsync',
    label: 'Obsync Dark',
    description: 'Neutral obsidian charcoal with restrained steel accent',
    isDark: true,
    themeColor: '#0d0d0e',
  },
  {
    id: 'night',
    label: 'Night',
    description: 'Midnight slate with cool cyan highlights',
    isDark: true,
    themeColor: '#0f172a',
  },
  {
    id: 'dracula',
    label: 'Dracula',
    description: 'Classic high-contrast developer palette',
    isDark: true,
    themeColor: '#282a36',
  },
  {
    id: 'dim',
    label: 'Dim',
    description: 'Soft muted charcoal for long sessions',
    isDark: true,
    themeColor: '#2a303c',
  },
  {
    id: 'nord',
    label: 'Nord Light',
    description: 'Clean arctic light palette',
    isDark: false,
    themeColor: '#eceff4',
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Crisp high-contrast daylight theme',
    isDark: false,
    themeColor: '#ffffff',
  },
];

export const VALID_THEME_IDS = new Set<ObsyncTheme>(
  OBSYNC_THEMES.map((t) => t.id)
);

export function resolveTheme(theme?: string): ObsyncTheme {
  if (theme && VALID_THEME_IDS.has(theme as ObsyncTheme)) {
    return theme as ObsyncTheme;
  }
  return 'obsync';
}

export function applyThemeToDocument(theme: ObsyncTheme): void {
  if (typeof document === 'undefined') return;
  const meta =
    OBSYNC_THEMES.find((t) => t.id === theme) ?? OBSYNC_THEMES[0];
  const root = document.documentElement;
  root.setAttribute('data-theme', meta.id);
  root.classList.toggle('dark', meta.isDark);

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', meta.themeColor);
  }
}
