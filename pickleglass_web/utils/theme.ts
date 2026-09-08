/**
 * Theme preference for the web GUI.
 *
 * Three states rather than a light/dark switch: "system" follows the OS, which is what actually
 * solves "too bright at night" for anyone whose Mac already switches appearance on a schedule.
 * The explicit choices are for everyone else, and for overriding the OS on one machine.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * Where the choice is stored.
 *
 * localStorage is keyed by origin, so this only survives because the web GUI now binds a stable
 * port - back when the port was assigned per launch, every restart was a new origin and the
 * preference would have been lost each time.
 */
export const THEME_STORAGE_KEY = 'glass.theme'

export const THEME_OPTIONS: ThemePreference[] = ['system', 'light', 'dark']

/**
 * Reads the stored preference.
 *
 * Storage throws in private mode and where site data is blocked, and the stored value can be
 * anything, so both failures fall back to "system" - the state that needs no stored value.
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/** Persists the preference. A storage failure must not stop the theme from being applied. */
export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* the theme still applies for this page view */
  }
}

/** Whether a preference resolves to dark right now. */
export function resolvesToDark(preference: ThemePreference): boolean {
  if (preference === 'dark') return true
  if (preference === 'light') return false
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Applies a preference to the document.
 *
 * Tailwind is configured with `darkMode: 'class'`, so the whole theme hangs off this one class.
 * `color-scheme` is set alongside it so form controls, scrollbars and the canvas behind the page
 * follow too - without it, a dark page keeps light scrollbars.
 */
export function applyTheme(preference: ThemePreference): void {
  const dark = resolvesToDark(preference)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
