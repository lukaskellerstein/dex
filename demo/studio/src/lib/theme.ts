// Visual system for the overlay layer (lower-thirds, captions, title cards).
//
// Deliberately restrained: the app UI is the subject, and overlays that compete with it
// make a demo look like a template. Everything here is system fonts, so the project has
// no font dependency and renders identically on any machine.
//
// To match a product's brand, change these values — nothing else needs to know.

export const theme = {
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, ui-sans-serif, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  color: {
    ink: "#0B0D10",
    surface: "rgba(12, 14, 18, 0.82)",
    surfaceSolid: "#0C0E12",
    text: "#FFFFFF",
    textMuted: "rgba(255, 255, 255, 0.68)",
    accent: "#5B8CFF",
    // Same hue as accent, as a bare triple so components can animate the alpha.
    accentRgb: "91, 140, 255",
    // Dex's own violet (--primary in src/renderer/styles/theme.css), used where the
    // product's identity is the subject rather than the overlay layer: the logo bloom
    // and the title-card rule. Kept separate from `accent` so the neutral overlay
    // system stays neutral over captured footage.
    brand: "#7C3AED",
    brandRgb: "124, 58, 237",
    panel: "#111318",
    letterbox: "#07080A",
  },
  radius: { sm: 8, md: 14, lg: 22 },
  // Captions and lower-thirds sit inside this margin so they survive any crop.
  safeArea: { x: 88, bottom: 72 },
  caption: {
    fontSize: 34,
    lineHeight: 1.28,
    maxWidth: 1180,
    paddingX: 22,
    paddingY: 12,
  },
  lowerThird: {
    // Monospace, small and muted — deliberately a different *kind* of element from the
    // caption. At 30px semi-bold white on a filled pill it was the caption's twin: same
    // colour, same weight, same shape, four pixels apart in size. Viewers read the pair
    // as one message shown twice, no matter how the wording differs. A caption is speech;
    // this is an annotation, so it takes the register the app itself uses — mono, quiet,
    // outlined rather than filled.
    fontSize: 22,
    // Roughly two-thirds the caption's weight on screen: enough to read, not enough to
    // compete for the eye while the caption is running.
    color: "rgba(255, 255, 255, 0.86)",
    background: "rgba(9, 11, 15, 0.72)",
    border: "1px solid rgba(255, 255, 255, 0.11)",
    // Distance from the frame bottom. A captured desktop app fills the frame edge to
    // edge, so the plate cannot simply sit in a margin — it has to occupy the one strip
    // the app leaves empty. Measured across all five captured sections, that strip is
    // the bottom-right corner; 190 puts the plate above a two-line caption (which tops
    // out around y=897) and below the lowest app row in any section.
    bottom: 190,
  },
  titleCard: {
    titleSize: 88,
    subtitleSize: 32,
  },
} as const;

/** Standard ease for overlay motion — quick in, settled out. */
export const EASE_OUT = [0.22, 0.61, 0.36, 1] as const;
