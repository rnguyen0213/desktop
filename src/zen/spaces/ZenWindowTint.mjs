/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Window tint presets and the pixel math used to draw them. This module has no
// DOM or XPCOM dependencies so it can be imported from the tint worker and
// from tests alike.

/**
 * The tints offered in the theme picker. Stops are spread evenly from the top
 * left corner of the window to the bottom right one, and the whole layer is
 * drawn at `opacity`. A preset without stops draws nothing.
 */
export const TINT_PRESETS = Object.freeze([
  { id: "midnight", stops: ["#0F172A", "#1E3A8A", "#312E81"], opacity: 0.6 },
  { id: "blue-violet", stops: ["#1F5FBF", "#6D28D9"], opacity: 0.5 },
  { id: "navy-teal", stops: ["#0A1A3A", "#0E6E6E"], opacity: 0.6 },
  { id: "charcoal-blue", stops: ["#1F1F1F", "#1E3A5F"], opacity: 0.55 },
  { id: "blue", stops: ["#1F5FBF"], opacity: 0.5 },
  { id: "dark-blue", stops: ["#0A1A3A"], opacity: 0.7 },
  { id: "grey", stops: ["#5A5A5A"], opacity: 0.45 },
  { id: "dark-grey", stops: ["#121212"], opacity: 0.6 },
  { id: "none", stops: [], opacity: 0 },
]);

export const DEFAULT_TINT_PRESET = "midnight";

export function getTintPreset(id) {
  return TINT_PRESETS.find(preset => preset.id === id) ?? null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Parses "#RGB", "#RRGGBB", "#RRGGBBAA" and "rgb()/rgba()" strings.
 *
 * @param {string} color
 * @returns {Array<number>|null} [r, g, b, a] with r, g, b in 0..255 and a in 0..1
 */
export function parseTintColor(color) {
  if (typeof color !== "string") {
    return null;
  }
  color = color.trim();
  let match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
  if (match) {
    let hex = match[1];
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map(c => c + c)
        .join("");
    }
    const value = n => parseInt(hex.substring(n, n + 2), 16);
    return [
      value(0),
      value(2),
      value(4),
      hex.length === 8 ? value(6) / 255 : 1,
    ];
  }
  match = /^rgba?\(([^)]*)\)$/i.exec(color);
  if (match) {
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) {
      return null;
    }
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return null;
}

/**
 * Builds what the renderer needs to draw a preset: the stops with the layer
 * opacity folded into their alpha.
 *
 * @param {object} preset One of TINT_PRESETS.
 * @param {number} opacity Layer opacity, 0..1.
 * @returns {object|null} null when there is nothing to draw.
 */
export function createTintSpec(preset, opacity) {
  if (!preset?.stops.length || !(opacity > 0)) {
    return null;
  }
  const count = preset.stops.length;
  const stops = preset.stops.map((color, index) => {
    const [r, g, b, a] = parseTintColor(color);
    return {
      position: count === 1 ? 0 : index / (count - 1),
      a: a * opacity,
      r,
      g,
      b,
    };
  });
  return {
    key: `${preset.id}@${opacity}`,
    solid: count === 1,
    stops,
  };
}

/**
 * Gecko premultiplies straight-alpha ImageData on putImageData using
 * `p = (x + (x >> 8)) >> 8` with `x = c * a + 255` (gfx/2d/Swizzle.cpp, also
 * used by its SSE2/NEON paths). There is no API to hand it premultiplied
 * pixels, so this table maps every premultiplied target (a, p), p <= a, to a
 * straight value c that premultiplies back to exactly p.
 *
 * @returns {Uint8Array} Indexed by a * 256 + p.
 */
export function buildUnpremultiplyTable() {
  const table = new Uint8Array(256 * 256);
  for (let a = 0; a < 256; a++) {
    let filled = -1;
    for (let c = 0; c < 256; c++) {
      const x = c * a + 255;
      const p = (x + (x >> 8)) >> 8;
      if (p > filled) {
        table[a * 256 + p] = c;
        filled = p;
      }
    }
  }
  return table;
}

/**
 * Premultiplies like Gecko does, see buildUnpremultiplyTable().
 *
 * @param {number} c Straight channel value, 0..255.
 * @param {number} a Alpha, 0..255.
 * @returns {number} The premultiplied channel value.
 */
export function geckoPremultiply(c, a) {
  const x = c * a + 255;
  return (x + (x >> 8)) >> 8;
}

/**
 * Computes premultiplied, dithered tint pixels for the rows
 * [rowStart, rowEnd) of a bitmap `width` pixels wide.
 *
 * The gradient runs from the window's top left corner (0, 0) to its bottom
 * right corner (windowWidth, windowHeight). (offsetX, offsetY) is where the
 * bitmap's origin sits inside the window, in device pixels.
 *
 * Writes [A, R, G, B] premultiplied per pixel into `out` (4 bytes per pixel,
 * in that order) so callers can choose the byte layout they need.
 *
 * @param {Uint8ClampedArray} out Receives (rowEnd - rowStart) rows.
 * @param {number} width Bitmap width in device pixels.
 * @param {number} rowStart First row to compute.
 * @param {number} rowEnd Row to stop before.
 * @param {object} params
 * @param {Array<object>} params.stops From createTintSpec().
 * @param {number} params.windowWidth Window width in device pixels.
 * @param {number} params.windowHeight Window height in device pixels.
 * @param {number} [params.offsetX] Bitmap origin inside the window.
 * @param {number} [params.offsetY] Bitmap origin inside the window.
 */
export function computeTintRows(out, width, rowStart, rowEnd, params) {
  const { stops, windowWidth, windowHeight, offsetX = 0, offsetY = 0 } = params;
  const dx = windowWidth;
  const dy = windowHeight;
  const lengthSquared = dx * dx + dy * dy;
  const lastStop = stops.length - 1;
  let i = 0;
  for (let row = rowStart; row < rowEnd; row++) {
    const y = row + offsetY;
    for (let column = 0; column < width; column++, i += 4) {
      const x = column + offsetX;
      const t = lengthSquared
        ? clamp(((x + 0.5) * dx + (y + 0.5) * dy) / lengthSquared, 0, 1)
        : 0;

      let a, r, g, b;
      if (lastStop === 0) {
        ({ a, r, g, b } = stops[0]);
      } else {
        let segment = 0;
        while (segment < lastStop - 1 && t > stops[segment + 1].position) {
          segment++;
        }
        const from = stops[segment];
        const to = stops[segment + 1];
        const span = to.position - from.position;
        const u = span > 0 ? (t - from.position) / span : 0;
        a = from.a + (to.a - from.a) * u;
        r = from.r + (to.r - from.r) * u;
        g = from.g + (to.g - from.g) * u;
        b = from.b + (to.b - from.b) * u;
      }

      // Interleaved gradient noise, the same value for every channel.
      const inner = 0.06711056 * x + 0.00583715 * y;
      const outer = 52.9829189 * (inner - Math.floor(inner));
      const noise = outer - Math.floor(outer);

      const A = clamp(Math.floor(a * 255 + noise), 0, 255);
      out[i] = A;
      out[i + 1] = clamp(Math.floor(r * a + noise), 0, A);
      out[i + 2] = clamp(Math.floor(g * a + noise), 0, A);
      out[i + 3] = clamp(Math.floor(b * a + noise), 0, A);
    }
  }
}

/**
 * Converts [A, R, G, B] premultiplied pixels (as written by computeTintRows)
 * in place into straight-alpha RGBA for ImageData, such that Gecko's
 * putImageData premultiplies them back to exactly the original values.
 *
 * @param {Uint8ClampedArray} pixels Converted in place.
 * @param {Uint8Array} unpremultiplyTable From buildUnpremultiplyTable().
 */
export function toImageDataPixels(pixels, unpremultiplyTable) {
  for (let i = 0; i < pixels.length; i += 4) {
    const A = pixels[i];
    const row = A * 256;
    const R = unpremultiplyTable[row + pixels[i + 1]];
    const G = unpremultiplyTable[row + pixels[i + 2]];
    const B = unpremultiplyTable[row + pixels[i + 3]];
    pixels[i] = R;
    pixels[i + 1] = G;
    pixels[i + 2] = B;
    pixels[i + 3] = A;
  }
}
