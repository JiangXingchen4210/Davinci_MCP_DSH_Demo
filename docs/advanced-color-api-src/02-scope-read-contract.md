# 02 — `scope_read` 契约（摘录）

源码：`S/scope-read.mjs`、`S/skin-match.mjs`（isSkin 复用）。

## 1. ROI 实现（`S/scope-read.mjs:81-101`）

```js
async function readPixels(pngPath, opts = {}) {
  const sharp = loadSharp();
  const maxSide = opts.maxSide ?? 480;
  try {
    let img = sharp(pngPath);
    if (opts.rect) {
      const meta = await img.metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      const x = clamp(Math.round(opts.rect.x * W), 0, Math.max(0, W - 1));
      const y = clamp(Math.round(opts.rect.y * H), 0, Math.max(0, H - 1));
      const w = clamp(Math.round(opts.rect.w * W), 1, W - x);
      const h = clamp(Math.round(opts.rect.h * H), 1, H - y);
      img = sharp(pngPath).extract({ left: x, top: y, width: w, height: h });
    }
    const out = await img.resize(maxSide, maxSide, { fit: 'inside', kernel: 'nearest' })
                     .raw().toBuffer({ resolveWithObject: true });
    return { data: out.data, ch: out.info.channels, width: out.info.width, height: out.info.height };
  } catch { return null; }
}
```

→ `rect` 是**比例 0..1**，真裁剪后再降采样；ROI 外像素不参与。读不了返回 null。

## 2. 关键常数与肤色分类器（`S/scope-read.mjs:42-75`）

```js
export const SKIN_LINE_DEG = 123;                       // vectorscope I-line
const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const cbOf = (r, g, b, y) => (b - y) / 1.8556;
const crOf = (r, g, b, y) => (r - y) / 1.5748;
import { isSkin } from './skin-match.mjs';              // 与 skin_match 同一真源

// skin-match.mjs:47-56 —— Kovac RGB 规则
export function isSkin(r, g, b, opts = {}) {
  const minR = opts.minR ?? 95, minG = opts.minG ?? 40, minB = opts.minB ?? 20;
  const minSpread = opts.minSpread ?? 15, minRG = opts.minRG ?? 15;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return r > minR && g > minG && b > minB && mx - mn > minSpread
      && Math.abs(r - g) > minRG && r > g && r > b;
}
```

## 3. 返回结构（`S/scope-read.mjs:162-256`）

```js
const chStats = (arr) => ({ mean: +mean(arr).toFixed(3), min: arr[0], max: arr[arr.length-1],
                            p1: percentile(arr,1), p50: percentile(arr,50), p99: percentile(arr,99) });
const channels = { r: chStats(R), g: chStats(G), b: chStats(B) };
const luma = chStats(L);

const parade = { rg: +(channels.r.mean - channels.g.mean).toFixed(3),
                 gb: +(channels.g.mean - channels.b.mean).toFixed(3),
                 rb: +(channels.r.mean - channels.b.mean).toFixed(3),
                 spread: +(Math.max(...means) - Math.min(...means)).toFixed(3) };

const blacks = [channels.r.p1, channels.g.p1, channels.b.p1];
const blackBalance = { r: channels.r.p1, g: channels.g.p1, b: channels.b.p1,
                       castSpread: Math.max(...blacks) - Math.min(...blacks) };

let skinLine = null;
if (nSkin > 0) {
  const cb = skinCb / nSkin, cr = skinCr / nSkin;
  const angle = (Math.atan2(cr, cb) * 180) / Math.PI;
  const distance = Math.hypot(cb, cr);
  skinLine = { angleDeg: +angle.toFixed(2), distance: +distance.toFixed(2),
               deviationDeg: +(angle - SKIN_LINE_DEG).toFixed(2),
               skinFrac: +(nSkin / nTotal).toFixed(4) };
}
const clipPct = +((100 * at255) / nTotal).toFixed(3);
const crushPct = +((100 * at0) / nTotal).toFixed(3);
const meanSat = +(satSum / nTotal).toFixed(4);

const signals = {
  lumaMedian: luma.p50, contrastRange: luma.p99 - luma.p1, meanSat,
  dominantHueDeg, hueConcentration, chromaticFrac: +(nChromatic / nTotal).toFixed(4),
  lowKey: luma.p50 < 70 && percentile(L, 75) < 128,
  monochromatic: hueConcentration >= 0.6 && meanSat > 0.08,
  lowSaturation: meanSat < 0.06,
  highContrast: contrastRange > 200,
  lowContrast: contrastRange < 60,
};

return { channels, luma, parade, blackBalance, skinLine, satHistogram: satHist,
         meanSat, clipPct, crushPct, signals, nTotal };
```

百分位是 nearest-rank（`:36-40`）：
```js
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}
```

## 4. 失败语义

- 读不了 PNG → `scopeRead` 返回 `null` → `drx` 分派抛
  `scope_read: unreadable frame '<png>' (skip-not-fake)`（`S/tools/drx.mjs:955-960`）。
- `sharp` 缺失 → 模块加载即抛
  `"scope-read needs the optional dep 'sharp' (frame stats). Install: npm i sharp"`
  （`S/scope-read.mjs:24-30`）。**本机当前就是这种状态。**
- 输入必须是 display-referred（Rec.709/sRGB）：LOG 帧的读数无意义
  （`S/scope-read.mjs:14-19` 注释；调用方负责用 `extract_frames` 的守卫）。
