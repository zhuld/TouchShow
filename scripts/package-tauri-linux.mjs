// TouchShow Tauri Linux 打包脚本（后端为 Rust 服务；需在 Linux 构建机上运行）
//
//   1. 构建前端（npm run build）→ dist/
//   2. cargo build --release 编译 Rust 后端（dist 随编译期内嵌进 sidecar），复制为 sidecar
//      （Linux 无扩展名，带 triple 后缀）
//   3. 运行 `tauri build`（bundle.active=false）生成裸可执行程序，不制作安装包
//   4. 复制主程序 + sidecar + public 到 release/tauri-linux/
//
// 前置条件（Linux 构建机）：
//   - Rust 工具链：https://rustup.rs
//   - Tauri Linux 系统依赖（Ubuntu/Debian 示例）：
//       sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
//         libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
//
// 用法：npm run package:tauri:linux
// 产物：release/tauri-linux/
//         TouchShow                              ← 可直接运行的主程序
//         TouchShow-server.exe-<triple>          ← Rust sidecar 服务（dist 内嵌，放在主程序旁）
//         public/                                ← 运行时资源（可修改）
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const releaseDir = resolve(root, "release", "tauri-linux");
const srcTauri = resolve(root, "src-tauri");
const binariesDir = resolve(srcTauri, "binaries");
const triple = "x86_64-unknown-linux-gnu"; // 与 src-tauri/src/lib.rs 的 SIDECAR_NAME 一致
// Rust 后端产物（Linux 无扩展名）
const rustServer = resolve(
  root,
  "backend",
  "target",
  "release",
  "touchshow-server",
);
// Tauri externalBin 会在配置路径后整体追加 -<triple>，故文件名是 TouchShow-server.exe-<triple>
const sidecarBin = resolve(binariesDir, `TouchShow-server.exe-${triple}`);

if (process.platform !== "linux") {
  throw new Error(
    "Linux Tauri 打包必须在 Linux 构建机上运行；当前环境是 Windows，请在 Linux 环境执行 npm run package:tauri:linux。",
  );
}

// [1/4] 构建前端
console.log("\n[1/4] 构建前端 (npm run build) ...");
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

// [2/4] cargo release 编译 Rust 后端并复制为 sidecar
console.log(
  "\n[2/4] 编译 Rust 后端 (cargo build --release) 并复制为 sidecar ...",
);
execSync("npm run build:server:release", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (!existsSync(rustServer))
  throw new Error(`Rust 后端产物缺失: ${rustServer}`);
mkdirSync(binariesDir, { recursive: true });
cpSync(rustServer, sidecarBin);
chmodSync(sidecarBin, 0o755); // 确保可执行
console.log(`  sidecar → ${sidecarBin}`);

// [3/4] tauri build（bundle.active=false 只出裸二进制；externalBin 会把 sidecar 复制到主程序旁）
console.log("\n[3/4] tauri build ...");
execSync("npx tauri build", { cwd: root, stdio: "inherit", shell: true });

// [4/4] 复制主程序 + sidecar + public 到 release/tauri-linux/
console.log("\n[4/4] 复制产物到 release/tauri-linux/ ...");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// 主程序（Linux 无扩展名）
const mainBinName = "TouchShow";
const mainBinCandidates = [
  resolve(srcTauri, "target", "release", mainBinName),
  resolve(srcTauri, "target", "release", "touchshow"),
];
const mainBin = mainBinCandidates.find((candidate) => existsSync(candidate));
if (!mainBin)
  throw new Error(`未找到主程序: ${mainBinCandidates.join(" 或 ")}`);
cpSync(mainBin, join(releaseDir, mainBinName));
chmodSync(join(releaseDir, mainBinName), 0o755);

// sidecar：优先取 tauri 已复制到主程序旁的文件，否则用步骤 2 生成的
const sidecarName = basename(sidecarBin);
const sidecarInTarget = resolve(srcTauri, "target", "release", sidecarName);
cpSync(
  existsSync(sidecarInTarget) ? sidecarInTarget : sidecarBin,
  join(releaseDir, sidecarName),
);
chmodSync(join(releaseDir, sidecarName), 0o755);

// public 与主程序同目录，运行时读取且可修改（dist 已内嵌于 sidecar）
cpSync(resolve(root, "public"), resolve(releaseDir, "public"), {
  recursive: true,
});

// 使用说明与主程序同目录
const usageDoc = resolve(root, "使用说明.txt");
if (existsSync(usageDoc)) {
  cpSync(usageDoc, join(releaseDir, "使用说明.txt"));
  console.log("   使用说明 → release/tauri-linux/使用说明.txt");
}

console.log("\n✅ Tauri Linux 打包完成（免安装，直接运行）！");
console.log(`   主程序: ${join(releaseDir, mainBinName)}`);
console.log(`   sidecar: ${join(releaseDir, sidecarName)}`);
console.log(`   public: ${join(releaseDir, "public")}  ← 运行时资源（可修改）`);
console.log("   dist  : 已内嵌于 sidecar（编译时固化，不可外部修改）");
