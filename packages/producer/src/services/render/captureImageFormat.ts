import type { EngineConfig, MotionBlurOptions } from "@hyperframes/engine";

/**
 * The format a render captures its frames in.
 *
 * Two independent reasons force PNG, and conflating them is how the encoder ends up
 * hunting for `frame_%06d.jpg` against files written as `.png`:
 *
 * - the output container keeps alpha, which JPEG cannot carry;
 * - motion blur is on, because the sub-frame samples are averaged pixel by pixel and
 *   JPEG samples would be averaged after a lossy quantization.
 *
 * Every consumer of "is this render PNG" reads the resolved capture format rather than
 * re-deriving it from one of the reasons.
 */
export function resolveCaptureImageFormat(input: {
  needsAlpha: boolean;
  motionBlur: MotionBlurOptions | undefined;
}): "jpeg" | "png" {
  return input.needsAlpha || input.motionBlur ? "png" : "jpeg";
}

/**
 * Below 100, Chrome's JPEG turns graded colour and grain into 8x8 chroma blotches that survive
 * the final encode. Draft keeps the smaller, faster frames.
 *
 * `HYPERFRAMES_CAPTURE_JPEG_QUALITY` (1-100) overrides the non-draft value for hosts where
 * quality-100 frames make capture the bottleneck; unset keeps 100.
 */
export function resolveCaptureJpegQuality(
  quality: EngineConfig["quality"],
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (quality === "draft") return 80;
  const override = Number(env.HYPERFRAMES_CAPTURE_JPEG_QUALITY);
  return Number.isInteger(override) && override >= 1 && override <= 100 ? override : 100;
}
