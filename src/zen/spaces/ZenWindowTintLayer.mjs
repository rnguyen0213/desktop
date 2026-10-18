/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  buildUnpremultiplyTable,
  computeTintRows,
  toImageDataPixels,
} from "resource:///modules/zen/ZenWindowTint.mjs";

const WORKER_URL = "resource:///modules/zen/ZenWindowTintWorker.mjs";

// Compute a new bitmap once the size has been stable for this long. Until
// then the previous bitmap is stretched to fit.
const RESIZE_SETTLE_MS = 150;
const MAX_WORKERS = 8;
// Bitmaps kept around so switching back and forth between two spaces doesn't
// recompute them. At 4K each one is ~33MB.
const MAX_CACHED_BITMAPS = 2;

/**
 * Draws the window tint behind the browser UI.
 *
 * A gradient this dark and slow bands visibly at 8 bits per channel, so
 * instead of a CSS gradient we compute a dithered, premultiplied bitmap at the
 * window's device pixel size and show it 1:1 in a canvas. Solid tints are
 * plain fills.
 *
 * There are two canvases, "current" and "old", mirroring the ::after and
 * ::before layers of .zen-browser-generic-background so that tints cross-fade
 * with --zen-background-opacity when switching spaces.
 */
export class nsZenWindowTintLayer {
  #container;
  #layers;
  #workers = null;
  #workersFailed = false;
  #pendingJobs = new Map();
  #nextJobId = 0;
  #cache = new Map();
  #unpremultiplyTable = null;

  #observer;
  #settleTimer = null;
  #containerSize = null;
  #windowSize = null;
  #renderedResolution = null;

  constructor(container) {
    this.#container = container;
    this.#layers = ["old", "current"].map(slot => {
      const canvas = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      canvas.className = "zen-window-tint";
      canvas.setAttribute("data-slot", slot);
      canvas.hidden = true;
      return { canvas, spec: null, renderedKey: null, generation: 0 };
    });
    // "current" paints above "old", like ::after over ::before.
    container.prepend(...this.#layers.map(layer => layer.canvas));

    this.#observer = new ResizeObserver(entries => this.#onResize(entries));
    this.#observer.observe(container, { box: "device-pixel-content-box" });
    this.#observer.observe(document.documentElement, {
      box: "device-pixel-content-box",
    });
    window.addEventListener("unload", () => this.destroy(), { once: true });
  }

  /**
   * @param {"current"|"old"} slot
   * @param {object|null} spec From createTintSpec(), null for no tint.
   */
  setTint(slot, spec) {
    const layer = this.#layer(slot);
    if (layer.spec?.key === spec?.key) {
      return;
    }
    layer.spec = spec;
    this.#render(layer);
  }

  /**
   * Moves what the current layer shows into the old one, for a cross-fade to
   * whatever is set as current next.
   */
  copyCurrentToOld() {
    // The current bitmap is the most recently used entry of the cache, so
    // this normally paints synchronously without recomputing anything.
    const current = this.#layer("current");
    const old = this.#layer("old");
    old.spec = current.spec;
    old.renderedKey = null;
    this.#render(old);
  }

  /**
   * Frees the old layer once a cross-fade is over, it is only needed while
   * --zen-background-opacity is below 1.
   */
  releaseOld() {
    const opacity = parseFloat(
      getComputedStyle(this.#container).getPropertyValue(
        "--zen-background-opacity"
      )
    );
    if (opacity >= 1) {
      this.setTint("old", null);
    }
  }

  destroy() {
    this.#observer?.disconnect();
    this.#observer = null;
    clearTimeout(this.#settleTimer);
    for (const worker of this.#workers ?? []) {
      worker.terminate();
    }
    this.#workers = null;
    this.#pendingJobs.clear();
    this.#cache.clear();
  }

  #layer(slot) {
    return this.#layers[slot === "old" ? 0 : 1];
  }

  #onResize(entries) {
    for (const entry of entries) {
      const box = entry.devicePixelContentBoxSize?.[0];
      if (!box) {
        continue;
      }
      const size = {
        width: Math.round(box.inlineSize),
        height: Math.round(box.blockSize),
      };
      if (entry.target === this.#container) {
        this.#containerSize = size;
      } else {
        this.#windowSize = size;
      }
    }
    // Render right away the first time and when the resolution changes (e.g.
    // the window moved to a monitor with a different scale). Otherwise the
    // window is being resized: let the canvases stretch the last bitmap and
    // wait for the size to settle.
    const resolution = window.devicePixelRatio;
    clearTimeout(this.#settleTimer);
    if (this.#renderedResolution !== resolution) {
      this.#renderAll();
      return;
    }
    this.#settleTimer = setTimeout(() => this.#renderAll(), RESIZE_SETTLE_MS);
  }

  #renderAll() {
    this.#settleTimer = null;
    for (const layer of this.#layers) {
      this.#render(layer);
    }
  }

  #geometry() {
    if (!this.#containerSize || !this.#windowSize) {
      return null;
    }
    const { width, height } = this.#containerSize;
    if (!width || !height) {
      return null;
    }
    const resolution = window.devicePixelRatio;
    const bounds = window.windowUtils.getBoundsWithoutFlushing(this.#container);
    return {
      width,
      height,
      resolution,
      offsetX: Math.round(bounds.left * resolution),
      offsetY: Math.round(bounds.top * resolution),
      windowWidth: this.#windowSize.width,
      windowHeight: this.#windowSize.height,
    };
  }

  #render(layer) {
    const generation = ++layer.generation;
    const { spec, canvas } = layer;
    if (!spec) {
      canvas.hidden = true;
      // Drop the (possibly window sized) bitmap.
      canvas.width = 1;
      canvas.height = 1;
      layer.renderedKey = null;
      return;
    }

    if (spec.solid) {
      // A single colour needs no dithering: a 1x1 bitmap stretched over the
      // window is a plain fill and never needs recomputing on resize.
      if (layer.renderedKey !== spec.key) {
        const [{ r, g, b, a }] = spec.stops;
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        context.fillRect(0, 0, 1, 1);
        layer.renderedKey = spec.key;
      }
      canvas.hidden = false;
      return;
    }

    const geometry = this.#geometry();
    if (!geometry) {
      return;
    }
    const key = [
      spec.key,
      geometry.width,
      geometry.height,
      geometry.offsetX,
      geometry.offsetY,
      geometry.windowWidth,
      geometry.windowHeight,
    ].join("|");
    if (layer.renderedKey === key) {
      canvas.hidden = false;
      return;
    }

    const cached = this.#cache.get(key);
    if (cached) {
      // Keep the cache in least-recently-used order.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      this.#paint(layer, key, cached, geometry.resolution);
      return;
    }

    this.#computeBitmap(spec, geometry).then(imageData => {
      // Drop results that were superseded while computing.
      if (!imageData || layer.generation !== generation) {
        return;
      }
      this.#cache.set(key, imageData);
      while (this.#cache.size > MAX_CACHED_BITMAPS) {
        this.#cache.delete(this.#cache.keys().next().value);
      }
      this.#paint(layer, key, imageData, geometry.resolution);
    }, console.error);
  }

  #paint(layer, key, imageData, resolution) {
    const { canvas } = layer;
    // Resizing clears the canvas, so do it right before drawing the new
    // bitmap, in the same task, so the stretched old one stays up until then.
    if (canvas.width !== imageData.width) {
      canvas.width = imageData.width;
    }
    if (canvas.height !== imageData.height) {
      canvas.height = imageData.height;
    }
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    canvas.hidden = false;
    layer.renderedKey = key;
    this.#renderedResolution = resolution;
  }

  async #computeBitmap(spec, geometry) {
    const { width, height } = geometry;
    const params = {
      stops: spec.stops,
      windowWidth: geometry.windowWidth,
      windowHeight: geometry.windowHeight,
      offsetX: geometry.offsetX,
      offsetY: geometry.offsetY,
    };
    const imageData = new ImageData(width, height);
    const workers = this.#getWorkers();
    if (!workers) {
      this.#unpremultiplyTable ??= buildUnpremultiplyTable();
      computeTintRows(imageData.data, width, 0, height, params);
      toImageDataPixels(imageData.data, this.#unpremultiplyTable);
      return imageData;
    }

    // Split the rows into one band per worker.
    const bandHeight = Math.ceil(height / workers.length);
    const bands = [];
    for (let i = 0; i < workers.length; i++) {
      const rowStart = i * bandHeight;
      const rowEnd = Math.min(height, rowStart + bandHeight);
      if (rowStart >= rowEnd) {
        break;
      }
      bands.push(this.#runJob(workers[i], { width, rowStart, rowEnd, params }));
    }
    for (const { rowStart, buffer } of await Promise.all(bands)) {
      imageData.data.set(new Uint8ClampedArray(buffer), rowStart * width * 4);
    }
    return imageData;
  }

  #runJob(worker, job) {
    const id = this.#nextJobId++;
    return new Promise((resolve, reject) => {
      this.#pendingJobs.set(id, { resolve, reject });
      worker.postMessage({ id, ...job });
    });
  }

  #getWorkers() {
    if (this.#workers || this.#workersFailed) {
      return this.#workers;
    }
    const count = Math.max(
      1,
      Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 1)
    );
    try {
      this.#workers = [];
      for (let i = 0; i < count; i++) {
        const worker = new Worker(WORKER_URL, { type: "module" });
        worker.onmessage = ({ data }) => {
          const job = this.#pendingJobs.get(data.id);
          this.#pendingJobs.delete(data.id);
          job?.resolve(data);
        };
        worker.onerror = event => this.#onWorkerError(event);
        this.#workers.push(worker);
      }
    } catch (e) {
      console.error("Window tint workers unavailable, computing inline", e);
      this.#onWorkerError();
    }
    return this.#workers;
  }

  #onWorkerError(event) {
    event?.preventDefault();
    for (const worker of this.#workers ?? []) {
      worker.terminate();
    }
    this.#workers = null;
    this.#workersFailed = true;
    const jobs = [...this.#pendingJobs.values()];
    this.#pendingJobs.clear();
    for (const job of jobs) {
      job.reject(new Error("Window tint worker failed"));
    }
    // Redo whatever was in flight on the main thread.
    for (const layer of this.#layers) {
      layer.renderedKey = null;
    }
    this.#renderAll();
  }
}
