// Theme presets. Our own design. Both players map player.theme {token: value} to
// --cf-<token> on their root element; theme.apply writes one of these token sets there.
// Every preset sets the same full set of tokens (both players' chrome plus the slide stage), so switching presets never
// leaves a stale colour. The stage stays light in every preset: authored slide colours and the white question panels of
// cf-player.css assume a light stage. Presets are explicit schemes: inline tokens beat the players'
// prefers-color-scheme rules, so `auto` (no tokens) uses the selected player style or, when absent/classic, the device setting.

const LIGHT_SHADOW = '0 1px 2px rgba(28, 31, 36, .06), 0 10px 28px -14px rgba(28, 31, 36, .22)';
const DARK_SHADOW = '0 1px 2px rgba(0, 0, 0, .3), 0 12px 30px -14px rgba(0, 0, 0, .6)';

export const PRESETS = {
  auto: { label: 'Default (player style or device setting)', scheme: 'auto', tokens: {} },
  light: { label: 'Light', scheme: 'light', tokens: {
    bg: '#f6f5f1', side: '#ecebe5', surface: '#ffffff', ink: '#1c1f24', muted: '#555a62', line: '#d6d4cc', field: '#767b85',
    accent: '#34449c', 'accent-ink': '#ffffff', 'accent-soft': '#e5e8f6', focus: '#c2410c',
    ok: '#1d6b41', 'ok-soft': '#e2f1e7', bad: '#a3281f', 'bad-soft': '#f8e5e2', warn: '#8a5300', shadow: LIGHT_SHADOW,
    'stage-bg': '#ffffff', 'stage-ink': '#1c1f24', 'stage-accent': '#34449c', 'stage-line': '#c9cbd3',
    'stage-focus': '#c2410c', 'stage-muted': '#555a62',
  } },
  charcoal: { label: 'Charcoal (dark)', scheme: 'dark', tokens: {
    bg: '#1d2025', side: '#23272d', surface: '#2a2e35', ink: '#eeede8', muted: '#b3b7bf', line: '#40454e', field: '#8e949e',
    accent: '#9db8ff', 'accent-ink': '#0f1526', 'accent-soft': '#2e3a57', focus: '#ffb27a',
    ok: '#86d9a8', 'ok-soft': '#1c3527', bad: '#ffa197', 'bad-soft': '#40231f', warn: '#f3c46b', shadow: DARK_SHADOW,
    'stage-bg': '#ffffff', 'stage-ink': '#1c1f24', 'stage-accent': '#2f4596', 'stage-line': '#c9cbd3',
    'stage-focus': '#c2410c', 'stage-muted': '#555a62',
  } },
  ocean: { label: 'Ocean', scheme: 'light', tokens: {
    bg: '#f0f6f9', side: '#e1edf3', surface: '#ffffff', ink: '#0f2431', muted: '#45606e', line: '#c6d8e1', field: '#678190',
    accent: '#0b5c78', 'accent-ink': '#ffffff', 'accent-soft': '#dbebf2', focus: '#b5400c',
    ok: '#17663e', 'ok-soft': '#ddf0e4', bad: '#a2291e', 'bad-soft': '#f8e3e0', warn: '#7d5000', shadow: LIGHT_SHADOW,
    'stage-bg': '#ffffff', 'stage-ink': '#0f2431', 'stage-accent': '#0b5c78', 'stage-line': '#c2d4dd',
    'stage-focus': '#b5400c', 'stage-muted': '#45606e',
  } },
  forest: { label: 'Forest', scheme: 'light', tokens: {
    bg: '#f3f5ef', side: '#e4e9dd', surface: '#ffffff', ink: '#1a251c', muted: '#4e5c4f', line: '#ced7c6', field: '#6d7b6d',
    accent: '#2e6838', 'accent-ink': '#ffffff', 'accent-soft': '#e0ecdc', focus: '#b5400c',
    ok: '#1b6640', 'ok-soft': '#dff0e3', bad: '#a2291e', 'bad-soft': '#f8e3e0', warn: '#7d5000', shadow: LIGHT_SHADOW,
    'stage-bg': '#ffffff', 'stage-ink': '#1a251c', 'stage-accent': '#2e6838', 'stage-line': '#c8d2c2',
    'stage-focus': '#b5400c', 'stage-muted': '#4e5c4f',
  } },
  'high-contrast': { label: 'High contrast (dark)', scheme: 'dark', tokens: {
    bg: '#000000', side: '#000000', surface: '#0d0d0d', ink: '#ffffff', muted: '#e6e6e6', line: '#ffffff', field: '#ffffff',
    accent: '#ffd60a', 'accent-ink': '#000000', 'accent-soft': '#332b00', focus: '#00e5ff',
    ok: '#7dff9e', 'ok-soft': '#00290f', bad: '#ff8a80', 'bad-soft': '#330400', warn: '#ffd60a', shadow: 'none',
    'stage-bg': '#ffffff', 'stage-ink': '#000000', 'stage-accent': '#0033a0', 'stage-line': '#000000',
    'stage-focus': '#b00020', 'stage-muted': '#333333',
  } },
};
export const PRESET_TOKENS = Object.keys(PRESETS.light.tokens);

// System font stacks only: nothing is downloaded or bundled. `system` = the players' defaults (no token).
export const FONTS = {
  system: { label: 'System sans (default)', stack: null },
  serif: { label: 'Serif', stack: '"Iowan Old Style", Charter, "Sitka Text", Cambria, Georgia, serif' },
  rounded: { label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif' },
  mono: { label: 'Monospace', stack: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
};

/** Which preset and font a player.theme matches ('custom' when its preset tokens or font match none). */
export function themeOf(theme = {}) {
  const preset = Object.keys(PRESETS).find((n) => PRESET_TOKENS.every((k) => theme[k] === PRESETS[n].tokens[k])) ?? 'custom';
  const font = Object.keys(FONTS).find((n) => theme.font === (FONTS[n].stack ?? undefined) && theme.serif === (FONTS[n].stack ?? undefined)) ?? 'custom';
  return { preset, font };
}
