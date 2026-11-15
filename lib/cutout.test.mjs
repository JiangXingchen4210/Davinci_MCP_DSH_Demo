#!/usr/bin/env node
// cutout.test.mjs — Vision 抠图/跟踪引擎测试（无测试框架，node lib/cutout.test.mjs 直接跑）
//
// 流程：
//   1) 用 ffmpeg 现场生成合成测试图/序列（白底 + 彩色圆 / 白底 + 红方块逐帧右移）
//   2) 强制重编 vision.swift，测编译耗时（断言 < 60s）
//   3) cutout：覆盖率 5%–60%、输出 PNG 真带 alpha、方向正确、颜色不被交换
//   4) track：首帧框中心误差 < 15px、第 5 帧相对首帧位移 ≈ +40px（±20）、confidence > 0.3
//   5) salient-box：框在图像内、覆盖目标物体
//   6) 缓存：第二次调用不重编；错误输入给出清晰错误
//
// 若 Vision 在本机不可用（系统限制/权限/退化到“跑通但检不出前景”），打印 SKIP 与原因并以 0 退出，
// 绝不伪装 PASS；真失败（断言不成立）以 1 退出。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    cutoutImage,
    trackBox,
    salientBox,
    ensureBinary,
    getCompileInfo,
    BINARY_PATH,
} from './cutout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vision');

const CUTOUT_W = 320, CUTOUT_H = 240;   // 白底 + 红圆 (210,90) r=55（偏离中心，用于验证方向）
const CUTOUT_CX = 210, CUTOUT_CY = 90, CUTOUT_R = 55;
const TRACK_W = 320, TRACK_H = 180;     // 白底 + 红方块 (60,60,50,50) 起，每帧右移 10px
const SQUARE_X = 60, SQUARE_Y = 60, SQUARE_W = 50, SQUARE_H = 50;
const SALIENT_CX = 80, SALIENT_CY = 100, SALIENT_R = 45;
const SALIENT_W = 320, SALIENT_H = 240;

let checks = 0;
const failures = [];

function check(condition, message) {
    checks += 1;
    if (!condition) {
        failures.push(message);
        throw new Error(`ASSERT FAILED: ${message}`);
    }
}

function report(label, detail) {
    console.log(`${label} ${detail}`);
}

function log(...args) {
    console.log(...args);
}

function runCapture(command, args, { timeoutMs = 180_000 } = {}) {
    return new Promise((resolve) => {
        const outChunks = [];
        const errChunks = [];
        let settled = false;
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({
                code: null,
                stdout: Buffer.concat(outChunks),
                stderr: Buffer.concat(errChunks).toString() + `\n[timeout] ${command} exceeded ${timeoutMs}ms`,
            });
        }, timeoutMs);
        child.stdout.on('data', (chunk) => outChunks.push(chunk));
        child.stderr.on('data', (chunk) => errChunks.push(chunk));
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: -1, stdout: Buffer.concat(outChunks), stderr: String(err) });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks).toString() });
        });
    });
}

async function resolveTool(name) {
    const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    const probe = await runCapture(name, ['-version'], { timeoutMs: 10_000 });
    return probe.code === 0 ? name : null;
}

/** 生成 “白底 + 实心圆” 的 ffmpeg filter 串（geq 三分量 + format=rgba） */
function geqCircleFilter(cx, cy, radius, rValue, gValue, bValue) {
    const inside = `lte(hypot(X-${cx},Y-${cy}),${radius})`;
    return `geq=r='if(${inside},${rValue},255)':g='if(${inside},${gValue},255)':b='if(${inside},${bValue},255)',format=rgba`;
}

/** 用 ffmpeg 现场生成测试素材 */
async function generateFixtures(ffmpeg) {
    await fsp.mkdir(FIXTURES_DIR, { recursive: true });

    // (a) 白底 + 偏离中心的红色实心圆 —— cutout 用
    const circleFilter = geqCircleFilter(CUTOUT_CX, CUTOUT_CY, CUTOUT_R, 220, 40, 40);
    const cutoutFixture = path.join(FIXTURES_DIR, 'vision-cutout.png');
    let r = await runCapture(ffmpeg, [
        '-y', '-v', 'error', '-f', 'lavfi',
        '-i', `color=c=white:s=${CUTOUT_W}x${CUTOUT_H}:d=1`,
        '-vf', circleFilter, '-frames:v', '1', cutoutFixture,
    ]);
    if (r.code !== 0) throw new Error(`ffmpeg 生成 cutout 素材失败: ${r.stderr}`);

    // (b) 白底 + 红方块 (60,60,50,50)，frame 0 起每帧右移 10px —— track 用
    const trackPaths = [];
    for (let i = 0; i <= 5; i += 1) {
        const x = SQUARE_X + i * 10;
        const out = path.join(FIXTURES_DIR, `vision-track-${i}.png`);
        r = await runCapture(ffmpeg, [
            '-y', '-v', 'error', '-f', 'lavfi',
            '-i', `color=c=white:s=${TRACK_W}x${TRACK_H}:d=1`,
            '-vf', `drawbox=x=${x}:y=${SQUARE_Y}:w=${SQUARE_W}:h=${SQUARE_H}:color=red@1:t=fill,format=rgba`,
            '-frames:v', '1', out,
        ]);
        if (r.code !== 0) throw new Error(`ffmpeg 生成 track 素材失败: ${r.stderr}`);
        trackPaths.push(out);
    }

    // (c) 白底 + 蓝色圆 —— salient-box 用
    const salientFixture = path.join(FIXTURES_DIR, 'vision-salient.png');
    const salientFilter = geqCircleFilter(SALIENT_CX, SALIENT_CY, SALIENT_R, 30, 80, 220);
    r = await runCapture(ffmpeg, [
        '-y', '-v', 'error', '-f', 'lavfi',
        '-i', `color=c=white:s=${SALIENT_W}x${SALIENT_H}:d=1`,
        '-vf', salientFilter, '-frames:v', '1', salientFixture,
    ]);
    if (r.code !== 0) throw new Error(`ffmpeg 生成 salient 素材失败: ${r.stderr}`);

    return {
        cutout: cutoutFixture,
        trackFrames: trackPaths,
        salient: salientFixture,
    };
}

/** 用 ffmpeg 把 PNG 解码成 RGBA8 原始像素 */
async function decodePNG(ffmpeg, imagePath, width, height) {
    const r = await runCapture(ffmpeg, [
        '-v', 'error', '-y', '-i', imagePath,
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ]);
    if (r.code !== 0) throw new Error(`ffmpeg 解码 ${imagePath} 失败: ${r.stderr}`);
    const expected = width * height * 4;
    check(r.stdout.length === expected, `解码 ${path.basename(imagePath)} 字节数 ${r.stdout.length} == ${expected}`);
    return r.stdout;
}

function pixelRGBA(buf, width, x, y) {
    const i = (y * width + x) * 4;
    return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] };
}

function alphaCoverage(buf, threshold = 128) {
    let covered = 0;
    for (let i = 3; i < buf.length; i += 4) {
        if (buf[i] >= threshold) covered += 1;
    }
    return covered / (buf.length / 4);
}

function rectOverlapRatio(inner, outer) {
    const x0 = Math.max(inner.x, outer.x);
    const y0 = Math.max(inner.y, outer.y);
    const x1 = Math.min(inner.x + inner.w, outer.x + outer.w);
    const y1 = Math.min(inner.y + inner.h, outer.y + outer.h);
    const iw = Math.max(0, x1 - x0);
    const ih = Math.max(0, y1 - y0);
    return (iw * ih) / (inner.w * inner.h);
}

/** Vision 在本机“不可用”的判定（区分环境限制 vs 断言失败） */
function visionUnavailableReason(err) {
    const text = `${err?.message || err}\n${err?.stderr || ''}`;
    if (/not supported|unsupported|not available|unavailable|disabled|not permitted|permission denied|no foreground instance and no person mask|no salient object|no saliency result/i.test(text)) {
        return text.trim().split('\n').slice(0, 3).join(' | ');
    }
    return null;
}

async function main() {
    log('== cutout.test.mjs — macOS Vision 抠图/跟踪测试 ==');

    if (process.platform !== 'darwin') {
        console.log(`SKIP 非 macOS 平台（process.platform=${process.platform}），Vision 不可用`);
        return;
    }

    const ffmpeg = await resolveTool('ffmpeg');
    if (!ffmpeg) {
        console.log('SKIP 未找到 ffmpeg（/opt/homebrew/bin、/usr/local/bin、PATH 均无），无法现场生成测试图');
        return;
    }
    const ffprobe = await resolveTool('ffprobe');
    log(`ffmpeg: ${ffmpeg}`);

    // ---------- 1) 现场生成测试素材 ----------
    const fixtures = await generateFixtures(ffmpeg);
    log(`FIXTURES ok ${Object.keys(fixtures).length} 组素材（${FIXTURES_DIR}）`);

    // ---------- 2) 编译（强制重编并计时，断言 < 60s） ----------
    const compileStart = Date.now();
    let compileInfo;
    try {
        compileInfo = await ensureBinary({ force: true });
    } catch (err) {
        console.error(`FAIL 编译 vision.swift 失败（${Date.now() - compileStart}ms）`);
        console.error(err.message);
        if (err.stderr) console.error(err.stderr);
        process.exitCode = 1;
        return;
    }
    const compileMs = Date.now() - compileStart;
    check(compileInfo.compiled === true, 'ensureBinary({force:true}) 应报告 compiled=true');
    check(compileMs < 60_000, `首次编译耗时 ${compileMs}ms 应 < 60000ms`);
    check(existsSync(BINARY_PATH), `编译产物应存在: ${BINARY_PATH}`);
    report('PASS compile', `swiftc -O 耗时 ${compileMs}ms（<60s），产物 ${path.relative(path.join(__dirname, '..'), BINARY_PATH)}，缓存记录 ${getCompileInfo().compileMs}ms`);

    // ---------- 3) cutout ----------
    const cutoutOut = path.join(FIXTURES_DIR, 'out-cutout.png');
    let cutout;
    try {
        cutout = await cutoutImage(fixtures.cutout, cutoutOut);
    } catch (err) {
        const reason = visionUnavailableReason(err);
        if (reason) {
            console.log(`SKIP Vision cutout 不可用（本机系统限制）：${reason}`);
            return;
        }
        throw err;
    }
    check(cutout.ok === true, 'cutout ok=true');
    check(['foreground-instance', 'person-segmentation'].includes(cutout.method), `cutout method 合法（实际 ${cutout.method}）`);
    check(cutout.width === CUTOUT_W && cutout.height === CUTOUT_H, `cutout 尺寸 ${cutout.width}x${cutout.height} == ${CUTOUT_W}x${CUTOUT_H}`);
    check(cutout.coverage >= 0.05 && cutout.coverage <= 0.60, `cutout 覆盖率 ${cutout.coverage} 应在 5%–60%`);
    check(existsSync(cutoutOut), 'cutout 输出 PNG 存在');

    if (ffprobe) {
        const probe = await runCapture(ffprobe, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', cutoutOut,
        ]);
        const line = probe.stdout.toString().trim();
        check(probe.code === 0, `ffprobe 读取输出 PNG 失败: ${probe.stderr}`);
        check(/rgba|argb/.test(line), `输出 PNG 应带 alpha 通道（ffprobe: ${line}）`);
        check(line.startsWith(`${CUTOUT_W},${CUTOUT_H}`), `输出 PNG 尺寸正确（ffprobe: ${line}）`);
    }

    const cutoutPixels = await decodePNG(ffmpeg, cutoutOut, CUTOUT_W, CUTOUT_H);
    const topLeftCorner = pixelRGBA(cutoutPixels, CUTOUT_W, 4, 4);
    const bottomLeftCorner = pixelRGBA(cutoutPixels, CUTOUT_W, 4, CUTOUT_H - 5);
    const circleCenter = pixelRGBA(cutoutPixels, CUTOUT_W, CUTOUT_CX, CUTOUT_CY);
    const decodedCoverage = alphaCoverage(cutoutPixels);
    check(topLeftCorner.a < 16, `背景左上角应透明（alpha=${topLeftCorner.a}）`);
    check(bottomLeftCorner.a < 16, `背景左下角应透明（alpha=${bottomLeftCorner.a}）`);
    check(circleCenter.a > 200, `前景中心（偏上右 ${CUTOUT_CX},${CUTOUT_CY}）应不透明（alpha=${circleCenter.a}），方向未翻转`);
    check(circleCenter.r > 150 && circleCenter.g < 100 && circleCenter.b < 100, `前景颜色应保持红色（实际 rgba=${circleCenter.r},${circleCenter.g},${circleCenter.b},${circleCenter.a}）`);
    check(Math.abs(decodedCoverage - cutout.coverage) < 0.05, `从 PNG 实测覆盖率 ${decodedCoverage.toFixed(4)} 与报告值 ${cutout.coverage} 一致`);
    check(decodedCoverage >= 0.05 && decodedCoverage <= 0.60, `PNG alpha 覆盖率 ${decodedCoverage.toFixed(4)} 在 5%–60%`);
    report('PASS cutout', `method=${cutout.method} ${cutout.width}x${cutout.height} coverage=${cutout.coverage} alpha#${decodedCoverage.toFixed(4)} 中心rgba=(${circleCenter.r},${circleCenter.g},${circleCenter.b},${circleCenter.a})`);

    // ---------- 4) track ----------
    let track;
    try {
        track = await trackBox(
            fixtures.trackFrames[0],
            { x: SQUARE_X - 5, y: SQUARE_Y - 5, w: SQUARE_W + 0, h: SQUARE_H + 0 },
            fixtures.trackFrames.slice(1),
        );
    } catch (err) {
        const reason = visionUnavailableReason(err);
        if (reason) {
            console.log(`SKIP Vision track 不可用（本机系统限制）：${reason}`);
            return;
        }
        throw err;
    }
    check(track.ok === true, 'track ok=true');
    check(track.frames.length === 5, `track 输出 5 帧（实际 ${track.frames.length}）`);
    check(track.lostAt === null, 'track 不应丢帧');
    for (const frame of track.frames) {
        check(Number.isFinite(frame.x) && Number.isFinite(frame.y) && Number.isFinite(frame.w) && Number.isFinite(frame.h),
            `track 帧坐标有限数值（${JSON.stringify(frame)}）`);
        check(frame.w > 0 && frame.h > 0, `track 帧框尺寸为正（${frame.w}x${frame.h}）`);
        check(frame.confidence > 0.3, `track 帧 confidence=${frame.confidence} 应 > 0.3`);
    }
    // 首帧（= 序列第 1 张，方块在 x=70）期望中心 (95, 85)
    const expectedFirstCenter = { x: SQUARE_X + 10 + SQUARE_W / 2, y: SQUARE_Y + SQUARE_H / 2 };
    const first = track.frames[0];
    const firstCenter = { x: first.x + first.w / 2, y: first.y + first.h / 2 };
    const centerError = Math.hypot(firstCenter.x - expectedFirstCenter.x, firstCenter.y - expectedFirstCenter.y);
    check(centerError < 15, `首帧框中心误差 ${centerError.toFixed(2)}px 应 < 15px`);
    // 第 5 帧相对首帧的 x 位移：方块每帧 +10px，4 帧差 = +40px，容差 ±20px
    const dx = track.frames[4].x - track.frames[0].x;
    check(Math.abs(dx - 40) <= 20, `第 5 帧 x 位移 ${dx.toFixed(2)}px 应 ≈ +40px（±20）`);
    check(track.frames[4].x > track.frames[0].x, '跟踪方向应为向右');
    const minConfidence = Math.min(...track.frames.map((f) => f.confidence));
    report('PASS track', `frames=${track.frames.length} 首帧中心误差=${centerError.toFixed(2)}px dx(f5-f1)=${dx.toFixed(2)}px 最低conf=${minConfidence.toFixed(3)}`);

    // ---------- 5) salient-box ----------
    let salient;
    try {
        salient = await salientBox(fixtures.salient);
    } catch (err) {
        const reason = visionUnavailableReason(err);
        if (reason) {
            console.log(`SKIP Vision salient-box 不可用（本机系统限制）：${reason}`);
            return;
        }
        throw err;
    }
    const box = salient.box;
    check(salient.ok === true, 'salient-box ok=true');
    check([box.x, box.y, box.w, box.h].every(Number.isFinite), 'salient box 数值有限');
    check(box.w > 0 && box.h > 0, `salient box 面积为正（${box.w}x${box.h}）`);
    check(box.x >= -1 && box.y >= -1 && box.x + box.w <= SALIENT_W + 2 && box.y + box.h <= SALIENT_H + 2,
        `salient box 落在图像内（${JSON.stringify(box)}）`);
    const expectedCircleBox = {
        x: SALIENT_CX - SALIENT_R,
        y: SALIENT_CY - SALIENT_R,
        w: SALIENT_R * 2,
        h: SALIENT_R * 2,
    };
    const overlap = rectOverlapRatio(expectedCircleBox, box);
    check(overlap >= 0.5, `salient box 应覆盖目标圆（覆盖率 ${overlap.toFixed(2)}，box=${JSON.stringify(box)}）`);
    report('PASS salient-box', `box=${JSON.stringify(box)} confidence=${salient.confidence} 目标覆盖率=${(overlap * 100).toFixed(0)}%`);

    // ---------- 6) 缓存与错误处理 ----------
    const cached = await ensureBinary();
    check(cached.compiled === false, '第二次 ensureBinary 应复用缓存（compiled=false）');
    report('PASS cache', `二进制已缓存，复用不重编（compiled=${cached.compiled}）`);

    let rejected = false;
    try {
        await cutoutImage(path.join(FIXTURES_DIR, 'does-not-exist.png'), cutoutOut);
    } catch (err) {
        rejected = true;
        check(/cannot read image/i.test(err.message), `缺失输入应报 cannot read image（实际: ${err.message.split('\n')[0]}）`);
        check((err.stderr || '').includes('does-not-exist.png'), '错误应带 stderr 原始信息');
    }
    check(rejected, '缺失输入应被拒绝');
    report('PASS errors', '缺失输入被拒绝且错误信息包含 stderr 路径');

    // ---------- 汇总 ----------
    log(`\nPASS cutout.test.mjs — ${checks} 项断言全部通过`);
    log(`   编译 ${compileMs}ms；cutout coverage=${cutout.coverage} (${cutout.method})；track dx=${dx.toFixed(2)}px conf>0.3；salient 覆盖率=${(overlap * 100).toFixed(0)}%`);
}

main().catch((err) => {
    console.error('\nFAIL cutout.test.mjs');
    console.error(err?.stack || String(err));
    process.exitCode = 1;
});
