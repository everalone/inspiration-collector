/** Crop geometry for a 0~1000 normalized box. Pure so it can be tested without sharp. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/**
 * Converts a normalized bbox to pixel coordinates, adding breathing room so glyph
 * edges and block borders are not cut. The box is never allowed outside the image.
 */
export function cropRect(box: number[], width: number, height: number): CropRect {
  const pad = Math.max(10, Math.round(Math.min(width, height) * 0.015));
  const left = clamp(Math.round((box[0] / 1000) * width) - pad, width - 10);
  const top = clamp(Math.round((box[1] / 1000) * height) - pad, height - 10);
  const right = clamp(Math.round((box[2] / 1000) * width) + pad, width);
  const bottom = clamp(Math.round((box[3] / 1000) * height) + pad, height);
  return {
    left,
    top,
    width: Math.max(10, right - left),
    height: Math.max(10, bottom - top),
  };
}
