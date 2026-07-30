// Types for demo/timeline.json — the contract between reconcile.mjs and this project.
//
// Everything here is generated. If a value looks wrong, fix it in the storyboard or in
// reconcile.mjs and re-reconcile; hand-editing timeline.json is a dead end because the
// next /demo-render overwrites it.

export type CameraKind = 'static' | 'kenburns' | 'zoomTo' | 'punchIn';
export type Surface = 'web' | 'electron' | 'still' | 'code' | 'titlecard';

export interface Camera {
  kind: CameraKind;
  from: number;
  to: number;
  /** "center" | "top-left" | … | "62%,38%" */
  focus: string;
}

export interface TransitionIn {
  kind: 'cut' | 'crossfade' | 'fadeThroughBlack' | 'slide';
  seconds: number;
  /** Overlap with the previous section, already converted to frames. */
  frames: number;
}

export interface VideoTrack {
  src: string;
  measuredSeconds: number;
  playbackRate: number;
  warpRatio: number;
  /** Frames of frozen last frame appended after the clip runs out. */
  holdLastFrameFrames: number;
  /** Section frames occupied by moving video (durationInFrames minus the hold). */
  videoFrames: number;
  /** Remotion props — FRAMES, not seconds. */
  trimBefore?: number;
  trimAfter?: number;
}

export interface AudioTrack {
  src: string;
  measuredSeconds: number;
  delayFrames: number;
  volume: number;
}

export interface Caption {
  text: string;
  /** Relative to the start of the section. */
  startFrame: number;
  endFrame: number;
}

export interface Section {
  id: string;
  beat: string;
  title: string;
  surface: Surface;
  startFrame: number;
  durationInFrames: number;
  camera: Camera;
  transitionIn: TransitionIn;
  video?: VideoTrack;
  audio?: AudioTrack;
  captions?: Caption[];
  lowerThird?: { text: string; inFrame: number; outFrame: number };
  still?: string;
  code?: { file: string; lines?: string; language?: string; highlight?: string; content?: string };
  titlecard?: { title: string; subtitle?: string };
}

export interface Music {
  src: string;
  gainDb: number;
  duckDb: number;
  duckRanges: { startFrame: number; endFrame: number }[];
}

export interface Timeline {
  generatedBy?: string;
  title?: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  captionsMode: 'none' | 'section' | 'word';
  sections: Section[];
  music?: Music;
  report?: {
    targetSeconds: number;
    actualSeconds: number;
    warnings: string[];
    errors: string[];
  };
}

/** Decibels to a linear gain multiplier, for Remotion's 0..1 volume prop. */
export const dbToGain = (db: number): number => Math.min(1, 10 ** (db / 20));

/**
 * transform-origin for a camera focus point.
 *
 * The storyboard writes a focus point comma-separated ("22%,45%"); CSS transform-origin
 * is space-separated. Passing the comma through produces a value the browser rejects
 * outright, which silently falls back to 50% 50% — a centred zoom that crops both edges,
 * looking exactly like a mis-chosen focus rather than a syntax error.
 */
export const focusToOrigin = (focus: string): string => {
  if (/^\d+(\.\d+)?%\s*,\s*\d+(\.\d+)?%$/.test(focus)) return focus.replace(/\s*,\s*/, ' ');
  const map: Record<string, string> = {
    center: '50% 50%',
    'top-left': '20% 20%',
    top: '50% 15%',
    'top-right': '80% 20%',
    left: '15% 50%',
    right: '85% 50%',
    'bottom-left': '20% 80%',
    bottom: '50% 85%',
    'bottom-right': '80% 80%',
  };
  return map[focus] ?? '50% 50%';
};
