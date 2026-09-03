// TouchShow 程序图标生成脚本
//
//   1. 从横版 Logo（默认 src/assets/logo.png，也支持 .svg）生成 1024×1024 方形源图标
//      src-tauri/icons/app-icon.svg（深色渐变背景 + 天蓝光晕，Logo 居中）
//   2. 调用 Tauri CLI 的 `tauri icon` 一键生成全套平台图标：
//      src-tauri/icons/  *.png / *.ico / *.icns
//      src-tauri/icons/android/*、src-tauri/icons/ios/*
//
// 用法：
//   npm run make-icon                          # 默认 Logo → 全套图标
//   npm run make-icon -- <源Logo.svg|.png>     # 指定其它横版/方形 Logo（SVG 或 PNG）
//   npm run make-icon -- --bg=#123456          # 纯色背景（默认深色渐变 + 天蓝光晕）
//   npm run make-icon -- --scale=0.9           # Logo 占图标宽度比例（默认 0.9）
//
// 产物：
//   src-tauri/icons/app-icon.svg   ← 1024 方形源图标（可手动微调后单独跑 tauri icon）
//   src-tauri/icons/*              ← Tauri 全套平台图标（会覆盖旧图标，android/ios 自动重建）
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const iconsDir = resolve(root, 'src-tauri', 'icons');
const appIcon = resolve(iconsDir, 'app-icon.svg');
const SIZE = 1024; // 方形源图标边长

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
let source = resolve(root, 'src', 'assets', 'logo.png'); // 项目横版 Logo
let bgColor = null; // null → 使用默认深色渐变 + 天蓝光晕
let scale = 0.9;    // Logo 宽度占图标宽度的比例

for (const a of args) {
    if (a.startsWith('--bg=')) bgColor = a.slice('--bg='.length);
    else if (a.startsWith('--scale=')) scale = parseFloat(a.slice('--scale='.length));
    else if (!a.startsWith('-')) source = isAbsolute(a) ? a : resolve(root, a);
}
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    console.error(`[错误] --scale 需为 (0,1] 之间的数字，当前: ${scale}`);
    process.exit(1);
}

// ---------- 1. 读取并解析源 Logo（支持 .svg 或 .png） ----------
console.log(`[1/3] 读取源 Logo: ${source}`);
if (!existsSync(source)) {
    console.error(`[错误] 未找到源 Logo: ${source}`);
    console.error('  可指定其它源文件：npm run make-icon -- <路径.svg|.png>');
    process.exit(1);
}

const isPng = /\.png$/i.test(source);

// 解析源 SVG 的 viewBox（优先）或 width/height，得到逻辑画布尺寸
function parseViewBox(svg) {
    const vb = svg.match(/viewBox\s*=\s*["']([\d.\s,\-]+)["']/);
    if (vb) {
        const [minX, minY, w, h] = vb[1].trim().split(/[\s,]+/).map(Number);
        if (w > 0 && h > 0) return { minX, minY, width: w, height: h };
    }
    const wm = svg.match(/<svg[^>]*\bwidth\s*=\s*["']([\d.]+)["']/);
    const hm = svg.match(/<svg[^>]*\bheight\s*=\s*["']([\d.]+)["']/);
    if (wm && hm && +wm[1] > 0 && +hm[1] > 0) return { minX: 0, minY: 0, width: +wm[1], height: +hm[1] };
    return null;
}

let vb, inner;
if (isPng) {
    // PNG：读取二进制，从 IHDR 块解析宽高，以 data URI 内嵌到方形源图标
    const pngBuf = readFileSync(source);
    if (pngBuf.length < 24 || pngBuf.readUInt32BE(0) !== 0x89504e47) {
        console.error('[错误] 不是有效的 PNG 文件');
        process.exit(1);
    }
    const w = pngBuf.readUInt32BE(16);
    const h = pngBuf.readUInt32BE(20);
    vb = { minX: 0, minY: 0, width: w, height: h };
    inner = `<image href="data:image/png;base64,${pngBuf.toString('base64')}" width="${w}" height="${h}"/>`;
    console.log(`  PNG 尺寸: ${w}×${h}`);
} else {
    // SVG：读取文本并解析尺寸
    const srcSvg = readFileSync(source, 'utf8');
    vb = parseViewBox(srcSvg);
    if (!vb) {
        console.error('[错误] 无法解析源 SVG 尺寸（缺少 viewBox 或 width/height）');
        process.exit(1);
    }
    // 提取 <svg> 内部内容（path 等图形元素），整体缩放居中放入方形画布
    inner = srcSvg.match(/<svg[^>]*>([\s\S]*)<\/svg>/i)?.[1] ?? srcSvg;
    console.log(`  viewBox: ${vb.minX} ${vb.minY} ${vb.width}×${vb.height}`);
}

// ---------- 2. 生成 1024 方形源图标 ----------
const s = (SIZE * scale) / vb.width;
const logoW = vb.width * s;
const logoH = vb.height * s;
const tx = (SIZE - logoW) / 2 - vb.minX * s;
const ty = (SIZE - logoH) / 2 - vb.minY * s;

const defs = bgColor
    ? ''
    : `<defs>
    <linearGradient id="appBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101d33"/>
      <stop offset="1" stop-color="#04070d"/>
    </linearGradient>
    <radialGradient id="appGlow" cx="0.5" cy="0.66" r="0.6">
      <stop offset="0" stop-color="#0089cf" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#0089cf" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
const bgFill = bgColor ?? 'url(#appBg)';
const glowRect = bgColor ? '' : '<rect width="1024" height="1024" fill="url(#appGlow)"/>';

const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  ${defs}
  <rect width="${SIZE}" height="${SIZE}" fill="${bgFill}"/>
  ${glowRect}
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(6)})">
    ${inner}
  </g>
</svg>
`;

mkdirSync(iconsDir, { recursive: true });
writeFileSync(appIcon, appSvg);
console.log(`\n[2/3] 生成方形源图标: ${appIcon}（${SIZE}×${SIZE}，Logo 宽占比 ${(scale * 100).toFixed(0)}%）`);

// ---------- 3. tauri icon 生成全套平台图标 ----------
console.log('\n[3/3] 调用 tauri icon 生成全套平台图标 ...');
execSync(`npx tauri icon "${appIcon}" -o "${iconsDir}"`, { cwd: root, stdio: 'inherit', shell: true });
console.log('\n完成。全套图标已生成到 src-tauri/icons/（含 *.png / *.ico / *.icns / android/ / ios/）。');
