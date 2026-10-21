#!/usr/bin/env node
// Interactive 30 FPS live prototype & offline probe for integrating `ascii-magic-art` into Epi TUI.
//
// Usage:
//   ./scripts/probes/ascii-tui-prototype.mjs           # Starts live 30 FPS animation in terminal!
//   ./scripts/probes/ascii-tui-prototype.mjs --probe   # Runs automated assertions + static snapshot

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { createEpiTheme } from "../../dist/tui/theme.js";
import { piTui } from "../../dist/tui/pi-tui.js";

const { visibleWidth, truncateToWidth } = piTui;
const TAU = Math.PI * 2;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export const LOOKS = {
  original: { label: "Original (Shaded / Half-block)", ramp: null },
  dots: { label: "Halftone Dots (·•●)", ramp: " ·•●" },
  dither: { label: "Ordered Bayer Dither (░▒▓█)", ramp: " ░▒▓█" },
  ascii: { label: "Classic ASCII (.,-~:;=!*#$@)", ramp: " .,-~:;=!*#$@" },
  binary: { label: "Binary (01)", ramp: " 01" },
};

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function lerpRgb(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ];
}

function fgRgb([r, g, b], text) {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function fgBgRgb([tr, tg, tb], [br, bg, bb], text) {
  return `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m${text}\x1b[0m`;
}

const EPI_PALETTE = {
  bg: hexToRgb("#1c1c1c"),
  borderMuted: hexToRgb("#323237"),
  dim: hexToRgb("#585858"),
  muted: hexToRgb("#6c6c6c"),
  blue: hexToRgb("#7aa2f7"),   // syntaxFunction
  purple: hexToRgb("#bb9af7"), // accent
  cyan: hexToRgb("#7dcfff"),   // thinkingHigh
  green: hexToRgb("#9ece6a"),  // success
  amber: hexToRgb("#FFDB8D"),  // warning
  coral: hexToRgb("#f7768e"),  // error
  white: hexToRgb("#e1e1e1"),  // text
};

function gradientStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  return lerpRgb(stops[idx], stops[idx + 1], scaled - idx);
}

const PURPLE_RAMP = [EPI_PALETTE.borderMuted, EPI_PALETTE.blue, EPI_PALETTE.purple, EPI_PALETTE.white];
const CYAN_RAMP = [EPI_PALETTE.borderMuted, EPI_PALETTE.blue, EPI_PALETTE.cyan, EPI_PALETTE.white];

// -----------------------------------------------------------------------------
// 1. Depth-buffered ASCII Grid with Look Restyler (`ascii-magic-art` core)
// -----------------------------------------------------------------------------

class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.ch = new Array(cols * rows).fill(" ");
    this.rgb = new Array(cols * rows).fill(null);
    this.lum = new Float32Array(cols * rows);
    this.z = new Float32Array(cols * rows);
    this.clear();
  }

  clear() {
    this.ch.fill(" ");
    this.rgb.fill(null);
    this.lum.fill(0);
    this.z.fill(-Infinity);
  }

  set(x, y, ch, rgb, lum = 1) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.cols || iy >= this.rows) return;
    const idx = ix + iy * this.cols;
    this.ch[idx] = ch;
    this.rgb[idx] = rgb;
    this.lum[idx] = lum;
  }

  setZ(x, y, z, ch, rgb, lum = 1) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix >= this.cols || iy >= this.rows) return;
    const idx = ix + iy * this.cols;
    if (z <= this.z[idx]) return;
    this.z[idx] = z;
    this.ch[idx] = ch;
    this.rgb[idx] = rgb;
    this.lum[idx] = lum;
  }

  toLines(look = "original") {
    const ramp = LOOKS[look]?.ramp;
    const lines = [];
    for (let y = 0; y < this.rows; y += 1) {
      let line = "";
      for (let x = 0; x < this.cols; x += 1) {
        const idx = x + y * this.cols;
        let ch = this.ch[idx];
        const color = this.rgb[idx];
        const l = this.lum[idx];
        if (ch !== " " && ramp) {
          if (look === "dither") {
            const threshold = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
            ch = l > threshold * 0.75
              ? ramp[Math.min(ramp.length - 1, 1 + Math.floor(l * (ramp.length - 1)))]
              : " ";
          } else {
            ch = ramp[Math.min(ramp.length - 1, Math.max(1, Math.floor(l * ramp.length)))];
          }
        }
        line += color && ch !== " " ? fgRgb(color, ch) : ch;
      }
      lines.push(line);
    }
    return lines;
  }
}

// -----------------------------------------------------------------------------
// 2. Four Hero Animations for Epi Startup Page (`[h]` cycles them in live mode)
//    - Hero 1: `logo`    — Epi Pixel Logo with diagonal specular light wave + plasma halo
//    - Hero 2: `torus`   — Port of `ascii-magic-art/pieces/spinning-torus.js`
//    - Hero 3: `icosa`   — Port of `ascii-magic-art/pieces/icosahedron.js` (flat-lit 3D facets)
//    - Hero 4: `helix`   — Port of `ascii-magic-art/pieces/double-helix.js` (rotating 3D DNA)
// -----------------------------------------------------------------------------

const LOGO_PIXELS = [
  "aaaaaaaaaaaaaa....................",
  "aaaaaaaaaaaaaa....................",
  "...............................b..",
  "..................................",
  "bbbbbbbbbbbbbb....aaa..bbbb..bbb..",
  "bbbbbbbbbbbbbb...a...a.b...b...b..",
  "..bb......bb.....aaaaa.b...b...b..",
  "..bb......bb.....a.....b...b...b..",
  "..bb......bb.....a...a.b...b...b..",
  "..bb......bb......aaa..bbbb..bbbbb",
  "..bb......bb...........b..........",
  "..bb......bb...........b..........",
];

export function renderAnimatedEpiLogo(t, look = "original") {
  const rows = [];
  const wave1 = ((t * 24) % 60) - 12;
  const wave2 = 44 - (((t * 16) % 60) - 12);

  for (let y = 0; y + 1 < LOGO_PIXELS.length; y += 2) {
    const top = LOGO_PIXELS[y];
    const bottom = LOGO_PIXELS[y + 1];
    let line = "";

    for (let x = 0; x < top.length; x += 1) {
      const u = top[x];
      const l = bottom[x];
      if (u === "." && l === ".") {
        line += " ";
        continue;
      }

      const d1 = (x + y * 0.7 - wave1) / 3.8;
      const d2 = (x - y * 0.5 - wave2) / 4.5;
      const shimmer = Math.min(1, Math.exp(-d1 * d1) + 0.6 * Math.exp(-d2 * d2));
      const colorFor = (pixel, rowY) => {
        const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 - x * 0.18 + rowY * 0.3);
        if (pixel === "a") {
          const base = lerpRgb(EPI_PALETTE.purple, EPI_PALETTE.blue, pulse * 0.35);
          return lerpRgb(base, EPI_PALETTE.white, shimmer * 0.75);
        }
        const base = lerpRgb(EPI_PALETTE.blue, EPI_PALETTE.purple, pulse * 0.35);
        return lerpRgb(base, EPI_PALETTE.cyan, shimmer * 0.8);
      };

      if (look !== "original" && LOOKS[look]?.ramp) {
        const ramp = LOOKS[look].ramp;
        const density = (u !== "." && l !== "." ? 0.72 : 0.42) + shimmer * 0.28;
        const idx = Math.min(ramp.length - 1, Math.max(1, Math.floor(density * ramp.length)));
        const ch = look === "dither"
          ? (density > (BAYER4[((y >> 1) & 3) * 4 + (x & 3)] + 0.5) / 16 ? ramp[idx] : "·")
          : ramp[idx];
        const dominant = u !== "." ? u : l;
        line += fgRgb(colorFor(dominant, y), ch);
      } else if (u !== "." && l !== ".") {
        line += fgBgRgb(colorFor(u, y), colorFor(l, y + 1), "▀");
      } else if (u !== ".") {
        line += fgRgb(colorFor(u, y), "▀");
      } else {
        line += fgRgb(colorFor(l, y + 1), "▄");
      }
    }
    rows.push(line);
  }
  return rows;
}

/** Port of `ascii-magic-art/pieces/spinning-torus.js` with Epi dual-tone lighting. */
export function renderEpiTorusHero(t, look = "original", cols = 34, rows = 11) {
  const g = new Grid(cols, rows);
  const R1 = 0.95, R2 = 1.95, K2 = 5.5;
  const K1 = (cols * K2 * 0.36) / (R1 + R2);
  const A = t * 1.15, B = t * 0.6;
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
  const ramp = ".,-~:;=!*#$@";

  for (let th = 0; th < TAU; th += 0.09) {
    const ct = Math.cos(th), st = Math.sin(th);
    for (let ph = 0; ph < TAU; ph += 0.035) {
      const cp = Math.cos(ph), sp = Math.sin(ph);
      const h = R2 + R1 * ct;
      const x = h * (cB * cp + sA * sB * sp) - R1 * st * cA * sB;
      const y = h * (sB * cp - sA * cB * sp) + R1 * st * cA * cB;
      const z = K2 + cA * h * sp + R1 * st * sA;
      const ooz = 1 / z;
      const nx = ct * (cB * cp + sA * sB * sp) - st * cA * sB;
      const ny = ct * (sB * cp - sA * cB * sp) + st * cA * cB;
      const nz = cA * ct * sp + st * sA;
      const lum = Math.max(0.08, Math.min(1, nx * -0.45 + ny * 0.65 - nz * 0.6 + 0.3));
      const ch = ramp[Math.min(ramp.length - 1, Math.floor(lum * ramp.length))];
      const stops = Math.sin(ph * 2 + t) >= 0 ? PURPLE_RAMP : CYAN_RAMP;
      g.setZ(cols / 2 + K1 * ooz * x, rows / 2 - K1 * 0.48 * ooz * y, ooz, ch, gradientStops(stops, lum), lum);
    }
  }
  return g.toLines(look);
}

/** Port of `ascii-magic-art/pieces/icosahedron.js` (20-faceted flat-shaded 3D polyhedron). */
const ICOSA_GEO = (() => {
  const p = (1 + Math.sqrt(5)) / 2;
  const s0 = 1 / Math.hypot(1, p);
  const verts = [];
  for (const a of [-1, 1]) {
    for (const b of [-p, p]) {
      verts.push([0, a * s0, b * s0], [a * s0, b * s0, 0], [b * s0, 0, a * s0]);
    }
  }
  const faces = [];
  const d2 = (u, v) => (u[0] - v[0]) ** 2 + (u[1] - v[1]) ** 2 + (u[2] - v[2]) ** 2;
  const target = 4 * s0 * s0;
  for (let i = 0; i < 12; i += 1) {
    for (let j = i + 1; j < 12; j += 1) {
      for (let k = j + 1; k < 12; k += 1) {
        if (
          Math.abs(d2(verts[i], verts[j]) - target) < 1e-4 &&
          Math.abs(d2(verts[j], verts[k]) - target) < 1e-4 &&
          Math.abs(d2(verts[i], verts[k]) - target) < 1e-4
        ) {
          faces.push([i, j, k]);
        }
      }
    }
  }
  return { verts, faces };
})();

export function renderEpiIcosahedronHero(t, look = "original", cols = 34, rows = 11) {
  const g = new Grid(cols, rows);
  const rx = ([x, y, z], a) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  const ry = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
  const V = ICOSA_GEO.verts.map((v) => rx(ry(v, t * 0.85), 0.4 + t * 0.45));
  const D = 4.2;
  const scaleX = cols * 0.92;
  const scaleY = rows * 0.92;
  const S = V.map(([x, y, z]) => {
    const k = 1 / (D - z);
    return [cols / 2 + x * k * scaleX, rows / 2 - y * k * scaleY, k];
  });
  const ramp = ".:-=+*#%@@";

  for (let f = 0; f < ICOSA_GEO.faces.length; f += 1) {
    const [i0, i1, i2] = ICOSA_GEO.faces[f];
    const v0 = V[i0], v1 = V[i1], v2 = V[i2];
    const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
    const vx = v2[0] - v0[0], vy = v2[1] - v0[1], vz = v2[2] - v0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const cx = (v0[0] + v1[0] + v2[0]) / 3, cy = (v0[1] + v1[1] + v2[1]) / 3, cz = (v0[2] + v1[2] + v2[2]) / 3;
    if (nx * cx + ny * cy + nz * cz < 0) { nx = -nx; ny = -ny; nz = -nz; }

    const lum = Math.max(0.12, Math.min(1, 0.18 + Math.max(0, -0.6 * nx + 0.55 * ny + 0.58 * nz) * 0.85));
    const ch = ramp[Math.min(ramp.length - 1, Math.floor(lum * ramp.length))];
    const rgb = gradientStops(f % 2 === 0 ? PURPLE_RAMP : CYAN_RAMP, lum);

    const a = S[i0], b = S[i1], c = S[i2];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-5) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(cols - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(rows - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        g.setZ(x, y, w0 * a[2] + w1 * b[2] + w2 * c[2], ch, rgb, lum);
      }
    }
  }
  return g.toLines(look);
}

/** Port of `ascii-magic-art/pieces/double-helix.js` (twisting 3D DNA strands + base-pair rungs). */
export function renderEpiHelixHero(t, look = "original", cols = 34, rows = 11) {
  const g = new Grid(cols, rows);
  const spin = t * 1.6;
  const steps = 90;
  const ramp = ".:-=+*#%@";

  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const yWorld = -1.6 + f * 3.2;
    const angle = yWorld * 2.1 + spin;
    const sy = rows / 2 - (yWorld / 1.75) * (rows * 0.44);

    const x1 = Math.cos(angle), z1 = Math.sin(angle);
    const x2 = Math.cos(angle + Math.PI), z2 = Math.sin(angle + Math.PI);
    const sx1 = cols / 2 + x1 * (cols * 0.34);
    const sx2 = cols / 2 + x2 * (cols * 0.34);

    // Base pair rung every 9 steps
    if (i % 9 === 0) {
      const rungSteps = 14;
      for (let r = 1; r < rungSteps; r += 1) {
        const rf = r / rungSteps;
        const rx = sx1 + (sx2 - sx1) * rf;
        const rz = z1 + (z2 - z1) * rf;
        const lum = 0.45 + 0.35 * (rz * 0.5 + 0.5);
        const rgb = rf < 0.5 ? EPI_PALETTE.cyan : EPI_PALETTE.amber;
        g.setZ(rx, sy, rz - 0.1, "═", lerpRgb(EPI_PALETTE.borderMuted, rgb, lum), lum);
      }
    }

    const lum1 = Math.max(0.2, Math.min(1, 0.55 + 0.45 * z1));
    const lum2 = Math.max(0.2, Math.min(1, 0.55 + 0.45 * z2));
    const ch1 = ramp[Math.min(ramp.length - 1, Math.floor(lum1 * ramp.length))];
    const ch2 = ramp[Math.min(ramp.length - 1, Math.floor(lum2 * ramp.length))];
    g.setZ(sx1, sy, z1, ch1, gradientStops(PURPLE_RAMP, lum1), lum1);
    g.setZ(sx1 + 1, sy, z1, ch1, gradientStops(PURPLE_RAMP, lum1), lum1);
    g.setZ(sx2, sy, z2, ch2, gradientStops(CYAN_RAMP, lum2), lum2);
    g.setZ(sx2 + 1, sy, z2, ch2, gradientStops(CYAN_RAMP, lum2), lum2);
  }
  return g.toLines(look);
}

// -----------------------------------------------------------------------------
// 3. Sleek Animated Rule (`pulse-line`) & TurnStatus Spinners & Streaming Rail
// -----------------------------------------------------------------------------

export function renderPulseRule(width, t, look = "original") {
  const cols = Math.max(4, width);
  const g = new Grid(cols, 1);
  const span = cols + 24;
  const pa = ((t * 28) % span) - 12;
  const pb = cols - (((t * 20 + span / 2) % span) - 12);

  for (let x = 0; x < cols; x += 1) {
    const da = (x - pa) / 5.5;
    const db = (x - pb) / 5.5;
    const ia = Math.exp(-da * da);
    const ib = Math.exp(-db * db);
    const intensity = Math.max(ia, ib);
    const rgb = ia >= ib
      ? lerpRgb(EPI_PALETTE.borderMuted, EPI_PALETTE.purple, Math.min(1, intensity * 1.15))
      : lerpRgb(EPI_PALETTE.borderMuted, EPI_PALETTE.cyan, Math.min(1, intensity * 1.15));
    const ch = intensity > 0.55 ? "━" : "─";
    g.set(x, 0, ch, rgb, Math.max(0.18, intensity));
  }
  return g.toLines(look)[0];
}

const TURN_SPINNERS = {
  comet(t) {
    const width = 6;
    const pos = ((t * 8.5) % (width + 2)) - 1;
    const glyphs = ["·", "•", "●"];
    let out = "";
    for (let i = 0; i < width; i += 1) {
      const d = Math.abs(i - pos);
      const v = Math.exp(-d * d * 0.95);
      const ch = v > 0.72 ? glyphs[2] : v > 0.32 ? glyphs[1] : glyphs[0];
      const rgb = lerpRgb(EPI_PALETTE.dim, i % 2 === 0 ? EPI_PALETTE.purple : EPI_PALETTE.cyan, v);
      out += fgRgb(rgb, ch);
    }
    return out;
  },
  wave(t) {
    const bars = "▁▂▃▄▅▆▇█";
    let out = "";
    for (let i = 0; i < 6; i += 1) {
      const v = 0.5 + 0.5 * Math.sin(t * 7.5 - i * 0.85);
      const ch = bars[Math.min(bars.length - 1, Math.floor(v * bars.length))];
      const rgb = lerpRgb(EPI_PALETTE.blue, EPI_PALETTE.purple, v);
      out += fgRgb(rgb, ch);
    }
    return out;
  },
  dither(t) {
    const braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let out = "";
    for (let i = 0; i < 6; i += 1) {
      const f = Math.floor(t * 14 + i * 1.5) % braille.length;
      const v = 0.5 + 0.5 * Math.sin(t * 6 - i * 0.7);
      const rgb = lerpRgb(EPI_PALETTE.dim, EPI_PALETTE.purple, v);
      out += fgRgb(rgb, braille[f]);
    }
    return out;
  },
};

export function renderTurnStatusPrototype(theme, width, t, style = "comet") {
  const spinner = (TURN_SPINNERS[style] ?? TURN_SPINNERS.comet)(t);
  const tok = (1.2 + (t % 9) * 0.14).toFixed(1);
  const left = `${spinner} ${theme.fg("text", "Streaming response…")} ${theme.fg("muted", `${t.toFixed(1)}s`)}`;
  const right = `${theme.fg("muted", `${t.toFixed(1)}s ⇣${tok}k · 72 tok/s`)} ${theme.fg("muted", "[stop]")}`;
  const rightWidth = visibleWidth(right);
  const leftFitted = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "…");
  const gap = " ".repeat(Math.max(1, width - visibleWidth(leftFitted) - rightWidth));
  return `${leftFitted}${gap}${right}`;
}

export function renderStreamingBlockPrototype(theme, width, t) {
  const rawLines = [
    `${theme.fg("accent", "◆")} ${theme.fg("muted", "Thinking…")}`,
    theme.fg("thinkingText", "Inspecting TuiAltScreen frame coalescing and component invalidation…"),
    theme.fg("thinkingText", "Mapping ascii-magic-art Grid ramps onto Epi grok-night theme tokens…"),
    theme.fg("thinkingText", "Verifying visibleWidth() invariants across 40/80/108 columns…"),
  ];
  const pulseRow = ((t * 4.8) % (rawLines.length + 1.5)) - 0.5;
  return rawLines.map((content, row) => {
    const d = (row - pulseRow) / 1.1;
    const v = Math.exp(-d * d);
    const railColor = lerpRgb(EPI_PALETTE.purple, EPI_PALETTE.cyan, v);
    const railGlyph = v > 0.65 ? "┃" : "│";
    return truncateToWidth(`${fgRgb(railColor, railGlyph)}  ${content}`, width, "…");
  });
}

// -----------------------------------------------------------------------------
// 4. Full Startup Page Prototype
// -----------------------------------------------------------------------------

const HERO_MODES = ["logo", "torus", "icosa", "helix"];

export function renderFullStartupPrototype(theme, width, t, look = "original", heroMode = "logo") {
  const panelWidth = Math.max(40, Math.min(108, width));
  const available = panelWidth - 7;
  const leftW = Math.min(36, Math.floor(available * 0.4));
  const rightW = available - leftW;

  const fit = (s, w) => truncateToWidth(s, Math.max(0, w), "…", true);
  const center = (s, w) => {
    const fitted = truncateToWidth(s, Math.max(0, w), "…");
    const pad = Math.max(0, w - visibleWidth(fitted));
    const l = Math.floor(pad / 2);
    return `${" ".repeat(l)}${fitted}${" ".repeat(pad - l)}`;
  };

  let leftRows;
  if (heroMode === "logo") {
    leftRows = [
      theme.bold("Welcome back"),
      "",
      ...renderAnimatedEpiLogo(t, look),
      "",
      theme.italic(theme.fg("muted", "Compose Pi your way.")),
      "",
      theme.fg("text", "Claude Opus 4.7"),
      theme.fg("dim", "anthropic · Pi 1.1.0"),
      "",
      theme.fg("dim", `hero: ${heroMode} · look: ${look}`),
    ];
  } else {
    // Give 3D solids 10 full rows so they render with crisp aspect ratio!
    const artW = Math.min(34, leftW);
    const artRows = heroMode === "torus"
      ? renderEpiTorusHero(t, look, artW, 10)
      : heroMode === "icosa"
        ? renderEpiIcosahedronHero(t, look, artW, 10)
        : renderEpiHelixHero(t, look, artW, 10);
    leftRows = [
      theme.bold("Welcome back"),
      ...artRows,
      theme.italic(theme.fg("muted", "Compose Pi your way.")),
      theme.fg("text", "Claude Opus 4.7"),
      theme.fg("dim", `hero: ${heroMode} · look: ${look}`),
    ];
  }

  const rule = renderPulseRule(rightW, t, look);
  const label = (s) => theme.fg("dim", s.padEnd(10, " "));
  const head = (s) => theme.bold(theme.fg("accent", s));

  const rightRows = [
    head("ASSEMBLY"),
    `${label("runtime")}Pi 1.1.0`,
    `${label("identity")}${theme.fg("success", "epi:runtime active")}`,
    `${label("manifest")}${theme.fg("success", "loaded")}`,
    `${label("project")}none found`,
    `${label("resources")}rules 0 · roots 1 (1 discovered) · ext 3`,
    rule,
    head("COMPOSITION"),
    theme.fg("mdCode", "rules + skills + extensions"),
    `${theme.fg("dim", "                 └──▶ ")}${theme.bold(theme.fg("accent", "Epi"))}${theme.fg("dim", " ──▶ ")}${theme.bold("Pi")}`,
    rule,
    head("CONFIGURE"),
    theme.fg("mdCode", "~/.epi/epi.json"),
    `${theme.fg("mdCode", "/epi")} inspect · ${theme.fg("mdCode", "/login")} authenticate`,
    `${theme.fg("mdCode", "/trust")} project manifest`,
  ];

  const title = theme.fg("muted", " epi v0.1.20 ");
  const topFill = Math.max(0, panelWidth - visibleWidth(title) - 3);
  const out = [
    `${theme.fg("borderAccent", "╭─")}${title}${theme.fg("borderAccent", `${"─".repeat(topFill)}╮`)}`,
  ];

  const count = Math.max(leftRows.length, rightRows.length);
  for (let i = 0; i < count; i += 1) {
    out.push([
      theme.fg("borderMuted", "│"),
      " ",
      fit(center(leftRows[i] ?? "", leftW), leftW),
      " ",
      theme.fg("borderMuted", "│"),
      " ",
      fit(rightRows[i] ?? "", rightW),
      " ",
      theme.fg("borderMuted", "│"),
    ].join(""));
  }

  out.push(theme.fg("borderAccent", `╰${"─".repeat(leftW + 2)}┴${"─".repeat(rightW + 2)}╯`));
  return out;
}

// -----------------------------------------------------------------------------
// 5. Live 30 FPS Interactive Showcase (Default in TTY)
// -----------------------------------------------------------------------------

function runLivePreview() {
  const theme = createEpiTheme("dark");
  const lookKeys = Object.keys(LOOKS);
  let lookIdx = 0;
  let heroIdx = 0; // 0: logo, 1: torus, 2: icosahedron, 3: double-helix
  let spinnerIdx = 0;
  const spinnerKeys = ["comet", "wave", "dither"];
  const start = performance.now();

  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const cleanup = () => {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const ch = buf.toString("utf8");
      if (ch === "q" || ch === "Q" || ch === "\x03" || ch === "\x1b") cleanup();
      if (ch === "h" || ch === "H" || ch === " ") heroIdx = (heroIdx + 1) % HERO_MODES.length;
      if (ch === "s" || ch === "S") lookIdx = (lookIdx + 1) % lookKeys.length;
      if (ch === "t" || ch === "T") spinnerIdx = (spinnerIdx + 1) % spinnerKeys.length;
      if (ch === "1") heroIdx = 0;
      if (ch === "2") heroIdx = 1;
      if (ch === "3") heroIdx = 2;
      if (ch === "4") heroIdx = 3;
    });
  }

  setInterval(() => {
    const t = (performance.now() - start) / 1000;
    const cols = process.stdout.columns || 96;
    const width = Math.max(44, Math.min(96, cols - 4));
    const look = lookKeys[lookIdx];
    const heroMode = HERO_MODES[heroIdx];
    const spinnerMode = spinnerKeys[spinnerIdx];

    const controls = [
      `${theme.bg("selectedBg", theme.fg("accent", " LIVE 30 FPS "))}`,
      `${theme.fg("text", "[1-4 / Space]")} Hero: ${theme.bold(theme.fg("accent", heroMode))}`,
      `${theme.fg("text", "[s]")} Look: ${theme.bold(theme.fg("syntaxFunction", look))}`,
      `${theme.fg("text", "[t]")} Spinner: ${theme.bold(theme.fg("success", spinnerMode))}`,
      `${theme.fg("muted", "[q] Quit")}`,
    ].join("  ");

    const startupCard = renderFullStartupPrototype(theme, width, t, look, heroMode);
    const streamingRail = renderStreamingBlockPrototype(theme, width, t);
    const turnStatus = renderTurnStatusPrototype(theme, width, t, spinnerMode);

    const promptTop = `${theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`)}`;
    const promptMid = `${theme.fg("borderAccent", "│")} ${theme.fg("accent", "❯")} ${theme.fg("muted", "Press [Space] to switch 3D Hero, [s] to restyle Look, [t] to switch Spinner…")}${" ".repeat(Math.max(0, width - 81))}${theme.fg("borderAccent", "│")}`;
    const label = " Claude Opus 4.7 (high) · ⇡1.2k ⇣1.8k ";
    const botFill = Math.max(0, width - visibleWidth(label) - 4);
    const promptBot = `${theme.fg("borderAccent", `╰${"─".repeat(botFill)}`)}${theme.fg("muted", label)}${theme.fg("borderAccent", "──╯")}`;

    const frameLines = [
      "",
      `  ${truncateToWidth(controls, width)}`,
      "",
      ...startupCard.map((l) => `  ${l}`),
      "",
      ...streamingRail.map((l) => `  ${l}`),
      "",
      `  ${turnStatus}`,
      `  ${promptTop}`,
      `  ${truncateToWidth(promptMid, width + 2)}`,
      `  ${promptBot}`,
    ];

    process.stdout.write("\x1b[?2026h\x1b[H\x1b[2J" + frameLines.join("\r\n") + "\x1b[?2026l");
  }, 1000 / 30).unref();
}

// -----------------------------------------------------------------------------
// 6. Automated Probe Assertions (`--probe` or non-TTY)
// -----------------------------------------------------------------------------

async function runAutomatedProbe() {
  const theme = createEpiTheme("dark");
  const widths = [40, 80, 96];
  const looks = Object.keys(LOOKS);
  const timings = [];

  for (const look of looks) {
    for (const width of widths) {
      for (const hero of HERO_MODES) {
        const t0 = performance.now();
        const startupLines = renderFullStartupPrototype(theme, width, 1.1, look, hero);
        const statusComet = renderTurnStatusPrototype(theme, width, 1.1, "comet");
        const statusWave = renderTurnStatusPrototype(theme, width, 1.1, "wave");
        const statusDither = renderTurnStatusPrototype(theme, width, 1.1, "dither");
        const railLines = renderStreamingBlockPrototype(theme, width, 1.1);
        timings.push(performance.now() - t0);

        for (const line of [...startupLines, statusComet, statusWave, statusDither, ...railLines]) {
          const vw = visibleWidth(line);
          assert.ok(vw <= width, `visibleWidth overflow (${vw} > ${width}) for look=${look} hero=${hero}`);
        }
      }
    }
  }

  const xtermMod = await import("@xterm/headless");
  const Terminal = xtermMod.default?.Terminal ?? xtermMod.Terminal;
  const term = new Terminal({ cols: 92, rows: 30, allowProposedApi: true });
  const frame = renderFullStartupPrototype(theme, 92, 1.1, "original", "icosa");
  await new Promise((resolve) => term.write(frame.join("\r\n"), resolve));
  const row0 = term.buffer.active.getLine(0)?.translateToString(true) ?? "";
  assert.ok(row0.includes("╭─ epi v0.1.20"), `xterm row 0 rendered: ${row0}`);
  term.dispose();

  const maxMs = Math.max(...timings);
  const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(
    JSON.stringify(
      {
        checks: "width<=budget (40/80/96); 4 heroes (logo/torus/icosa/helix); 5 looks; xterm buffer: PASS",
        samplesTested: timings.length,
        avgRenderBundleMs: Number(avgMs.toFixed(3)),
        maxRenderBundleMs: Number(maxMs.toFixed(3)),
      },
      null,
      2,
    ),
  );
}

if (process.argv.includes("--probe") || !process.stdout.isTTY) {
  await runAutomatedProbe();
} else {
  runLivePreview();
}
