/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Computes a band of rows of the window tint bitmap. See ZenWindowTintLayer.

import {
  buildUnpremultiplyTable,
  computeTintRows,
  toImageDataPixels,
} from "resource:///modules/zen/ZenWindowTint.mjs";

let unpremultiplyTable = null;

self.onmessage = ({ data }) => {
  const { id, width, rowStart, rowEnd, params } = data;
  unpremultiplyTable ??= buildUnpremultiplyTable();
  const pixels = new Uint8ClampedArray(width * (rowEnd - rowStart) * 4);
  computeTintRows(pixels, width, rowStart, rowEnd, params);
  toImageDataPixels(pixels, unpremultiplyTable);
  self.postMessage({ id, rowStart, rowEnd, buffer: pixels.buffer }, [
    pixels.buffer,
  ]);
};
