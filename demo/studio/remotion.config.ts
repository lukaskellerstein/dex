import { Config } from '@remotion/cli/config';

// JPEG frames render considerably faster than PNG and the difference is invisible in an
// H.264 encode of a screen recording.
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(90);
Config.setOverwriteOutput(true);

// ANGLE is the most reliable GL backend for headless Chromium on macOS.
Config.setChromiumOpenGlRenderer('angle');

// Screen recordings are already in sRGB; skipping tone mapping is faster and avoids a
// subtle colour shift between the captured UI and Remotion-rendered overlays.
Config.setColorSpace('default');
