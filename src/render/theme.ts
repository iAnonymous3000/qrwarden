export const THEME_STORAGE_KEY = "qrwarden-theme";

const DARK_THEME_COLOR = "#1c1c1c";
const LIGHT_THEME_COLOR = "#fffdf8";

export type Theme = "dark" | "light";

export interface ThemeEnvironment {
  readonly loadOverride: () => string | null;
  readonly saveOverride: (theme: Theme) => void;
  readonly systemTheme: () => Theme;
  readonly watchSystemTheme: (listener: (theme: Theme) => void) => () => void;
  readonly applyTheme: (theme: Theme) => void;
}

type ThemeListener = (theme: Theme) => void;

export function parseTheme(value: string | null): Theme | null {
  return value === "dark" || value === "light" ? value : null;
}

export class ThemeController {
  readonly #environment: ThemeEnvironment;
  readonly #listeners = new Set<ThemeListener>();
  #theme: Theme;
  #followsSystem: boolean;
  #stopSystemWatch: (() => void) | null = null;

  constructor(environment: ThemeEnvironment) {
    this.#environment = environment;

    let override: Theme | null = null;
    try {
      override = parseTheme(environment.loadOverride());
    } catch {
      // Storage-restricted sessions still get a working in-memory theme.
    }

    this.#followsSystem = override === null;
    if (override !== null) {
      this.#theme = override;
    } else {
      try {
        this.#theme = environment.systemTheme();
      } catch {
        this.#theme = "dark";
      }
    }
    environment.applyTheme(this.#theme);

    if (this.#followsSystem) {
      try {
        this.#stopSystemWatch = environment.watchSystemTheme((theme) => {
          if (this.#followsSystem) this.#setTheme(theme);
        });
      } catch {
        // A missing media-query event API does not prevent manual toggling.
      }
    }
  }

  get theme(): Theme {
    return this.#theme;
  }

  get followsSystem(): boolean {
    return this.#followsSystem;
  }

  subscribe(listener: ThemeListener): () => void {
    this.#listeners.add(listener);
    listener(this.#theme);
    return () => this.#listeners.delete(listener);
  }

  toggle(): Theme {
    const next = this.#theme === "dark" ? "light" : "dark";
    this.#followsSystem = false;
    this.#stopSystemWatch?.();
    this.#stopSystemWatch = null;
    try {
      this.#environment.saveOverride(next);
    } catch {
      // Keep the explicit choice for this session when storage is unavailable.
    }
    this.#setTheme(next);
    return next;
  }

  dispose(): void {
    this.#stopSystemWatch?.();
    this.#stopSystemWatch = null;
    this.#listeners.clear();
  }

  #setTheme(theme: Theme): void {
    if (theme === this.#theme) return;
    this.#theme = theme;
    this.#environment.applyTheme(theme);
    this.#listeners.forEach((listener) => listener(theme));
  }
}

export function createBrowserThemeController(): ThemeController {
  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    // Dark is the branded fallback when media queries are unavailable.
  }

  return new ThemeController({
    loadOverride: () => window.localStorage.getItem(THEME_STORAGE_KEY),
    saveOverride: (theme) => window.localStorage.setItem(THEME_STORAGE_KEY, theme),
    systemTheme: () => (media?.matches === false ? "light" : "dark"),
    watchSystemTheme: (listener) => {
      if (media === null) return () => undefined;
      const handler = (event: MediaQueryListEvent): void => {
        listener(event.matches ? "dark" : "light");
      };
      media.addEventListener("change", handler);
      return () => media?.removeEventListener("change", handler);
    },
    applyTheme: (theme) => {
      document.documentElement.dataset.theme = theme;
      document
        .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute(
          "content",
          theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
        );
    },
  });
}
