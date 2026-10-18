/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  TINT_PRESETS,
  buildUnpremultiplyTable,
  computeTintRows,
  createTintSpec,
  getTintPreset,
  toImageDataPixels,
} = ChromeUtils.importESModule("resource:///modules/zen/ZenWindowTint.mjs", {
  global: "current",
});

const DARK = 0;
const LIGHT = 1;

// A literal transcription of the dithering spec, to check computeTintRows()
// against. Returns [A, R, G, B] per pixel.
function referenceTint(width, height, preset, opacity) {
  const hex = c => [1, 3, 5].map(i => parseInt(c.substr(i, 2), 16));
  const stops = preset.stops.map((c, i, all) => ({
    t: all.length === 1 ? 0 : i / (all.length - 1),
    a: opacity,
    rgb: hex(c),
  }));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fract = v => v - Math.floor(v);
  const [sx, sy] = [0, 0];
  const [dx, dy] = [width - sx, height - sy];
  const L2 = dx * dx + dy * dy;
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = clamp(((x + 0.5 - sx) * dx + (y + 0.5 - sy) * dy) / L2, 0, 1);
      let i = 0;
      while (i < stops.length - 2 && t > stops[i + 1].t) {
        i++;
      }
      const s0 = stops[i];
      const s1 = stops[Math.min(i + 1, stops.length - 1)];
      const u = s1.t > s0.t ? (t - s0.t) / (s1.t - s0.t) : 0;
      const a = s0.a + (s1.a - s0.a) * u;
      const rgb = s0.rgb.map((c, k) => c + (s1.rgb[k] - c) * u);
      const noise = fract(52.9829189 * fract(0.06711056 * x + 0.00583715 * y));
      const A = clamp(Math.floor(a * 255 + noise), 0, 255);
      out.push(A, ...rgb.map(c => clamp(Math.floor(c * a + noise), 0, A)));
    }
  }
  return out;
}

async function setWindowScheme(scheme) {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.view.window.scheme", scheme]],
  });
  gZenThemePicker.updateCurrentWorkspace();
}

function currentTintCanvas() {
  return document.querySelector(
    "#zen-browser-background > .zen-window-tint[data-slot='current']"
  );
}

add_task(async function test_TintPixelsMatchTheSpec() {
  for (const preset of TINT_PRESETS.filter(p => p.stops.length > 1)) {
    const width = 61;
    const height = 37;
    const spec = createTintSpec(preset, preset.opacity);
    const pixels = new Uint8ClampedArray(width * height * 4);
    computeTintRows(pixels, width, 0, height, {
      stops: spec.stops,
      windowWidth: width,
      windowHeight: height,
    });
    Assert.deepEqual(
      Array.from(pixels),
      referenceTint(width, height, preset, preset.opacity),
      `${preset.id} matches the reference`
    );
  }
});

add_task(async function test_TintRowBandsMatchTheWholeBitmap() {
  const width = 40;
  const height = 30;
  const params = {
    stops: createTintSpec(getTintPreset("midnight"), 0.6).stops,
    windowWidth: width,
    windowHeight: height,
  };
  const whole = new Uint8ClampedArray(width * height * 4);
  computeTintRows(whole, width, 0, height, params);
  const band = new Uint8ClampedArray(width * 10 * 4);
  computeTintRows(band, width, 10, 20, params);
  Assert.deepEqual(
    Array.from(band),
    Array.from(whole.subarray(width * 10 * 4, width * 20 * 4)),
    "A band of rows equals the same rows of the whole bitmap"
  );
});

add_task(async function test_CanvasKeepsExactPremultipliedValues() {
  const width = 64;
  const height = 32;
  const spec = createTintSpec(getTintPreset("midnight"), 0.6);
  const premultiplied = new Uint8ClampedArray(width * height * 4);
  computeTintRows(premultiplied, width, 0, height, {
    stops: spec.stops,
    windowWidth: width,
    windowHeight: height,
  });
  const straight = new Uint8ClampedArray(premultiplied);
  toImageDataPixels(straight, buildUnpremultiplyTable());

  const createCanvas = () => {
    const canvas = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  const tint = createCanvas();
  tint
    .getContext("2d")
    .putImageData(new ImageData(straight, width, height), 0, 0);

  // Over opaque black, the result is the premultiplied colour itself. Over
  // opaque white it is premultiplied + 255 - A, which gives A back.
  const composite = background => {
    const canvas = createCanvas();
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(tint, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const overBlack = composite("black");
  const overWhite = composite("white");

  let mismatches = 0;
  for (let i = 0; i < premultiplied.length; i += 4) {
    const [A, R, G, B] = premultiplied.subarray(i, i + 4);
    if (
      overBlack[i] !== R ||
      overBlack[i + 1] !== G ||
      overBlack[i + 2] !== B ||
      overWhite[i] - R !== 255 - A
    ) {
      mismatches++;
    }
  }
  Assert.equal(mismatches, 0, "Every pixel keeps its exact value");
});

add_task(async function test_PickingATintPreset() {
  const workspace = gZenWorkspaces.getActiveWorkspace();
  const originalTheme = workspace.theme;
  await setWindowScheme(DARK);

  gZenThemePicker.applyTintPreset("blue-violet");
  Assert.equal(workspace.theme.tintPreset, "blue-violet", "Preset is stored");
  Assert.equal(workspace.theme.opacity, 0.5, "Preset opacity is used");
  Assert.deepEqual(
    workspace.theme.gradientColors.map(color => color.c),
    ["#1F5FBF", "#6D28D9"],
    "Preset colours are stored as custom colours"
  );
  Assert.ok(
    document.documentElement.hasAttribute("zen-window-tint"),
    "The window knows it is tinted"
  );
  Assert.equal(
    getComputedStyle(gZenThemePicker.browserBackgroundElement)
      .getPropertyValue("--zen-main-browser-background")
      .trim(),
    "transparent",
    "The CSS gradient is not used for tints"
  );

  const canvas = currentTintCanvas();
  await TestUtils.waitForCondition(
    () => !canvas.hidden && canvas.width > 1,
    "The tint bitmap gets drawn"
  );
  const { width, height } = canvas.getBoundingClientRect();
  Assert.equal(
    canvas.width,
    Math.round(width * window.devicePixelRatio),
    "The bitmap is as wide as the window in device pixels"
  );
  Assert.equal(
    canvas.height,
    Math.round(height * window.devicePixelRatio),
    "The bitmap is as tall as the window in device pixels"
  );

  await setWindowScheme(LIGHT);
  Assert.ok(canvas.hidden, "There is no tint in light mode");
  Assert.equal(
    document.documentElement.style.getPropertyValue("--toolbox-textcolor"),
    "rgba(26, 26, 26, 1)",
    "Light mode text color"
  );

  await setWindowScheme(DARK);
  Assert.equal(
    document.documentElement.style.getPropertyValue("--toolbox-textcolor"),
    "rgba(255, 255, 255, 1)",
    "Dark mode text color"
  );

  gZenThemePicker.applyTintPreset("blue");
  await TestUtils.waitForCondition(
    () => !canvas.hidden && canvas.width === 1,
    "A solid tint is a plain fill"
  );

  workspace.theme = originalTheme;
  await SpecialPowers.flushPrefEnv();
  gZenThemePicker.onWorkspaceChange(workspace);
});

add_task(async function test_EditingTheColoursLeavesTheTint() {
  const Picker = gZenThemePicker.constructor;
  const theme = Picker.getTintTheme("navy-teal");
  Assert.equal(
    Picker.getThemeTintPreset(theme)?.id,
    "navy-teal",
    "An untouched tint theme"
  );

  theme.gradientColors[1].c = "#123456";
  Assert.equal(
    Picker.getThemeTintPreset(theme),
    null,
    "Changing a colour turns it into a regular theme"
  );

  Assert.equal(
    Picker.findTintPresetForColors([
      { c: "rgb(10, 26, 58)", isCustom: true },
      { c: "rgb(14, 110, 110)", isCustom: true },
    ])?.id,
    "navy-teal",
    "A tint's colours are recognized when imported from a share"
  );
});

add_task(async function test_NewSpacesUseMidnight() {
  const previous = gZenWorkspaces.activeWorkspace;
  const created = await gZenWorkspaces.createAndSaveWorkspace(
    "Tint test",
    undefined,
    true
  );
  Assert.equal(created.theme.tintPreset, "midnight", "Midnight by default");
  Assert.equal(created.theme.opacity, 0.6, "At 60%");
  await gZenWorkspaces.removeWorkspace(created.uuid);
  Assert.equal(gZenWorkspaces.activeWorkspace, previous, "Back where we were");
});
