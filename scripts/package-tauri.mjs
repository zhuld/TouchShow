// TouchShow Tauri 打包脚本（后端为 Rust 服务）
//
//   1. 构建前端（npm run build）→ dist/
//   2. cargo build --release 编译 Rust 后端（dist 随编译期内嵌进 sidecar），复制为 sidecar
//      （Tauri externalBin 约定：binaries/ 下需带 <triple> 后缀）
//   3. 运行 `tauri build`（bundle.active=false）生成裸可执行程序，不制作安装包
//   4. 复制主程序 + sidecar + public 到 release/tauri/
//
// 用法：npm run package:tauri
// 产物：release/tauri/
//         TouchShow.exe                        ← Tauri 壳主程序（可直接运行）
//         TouchShow-server.exe-<triple>.exe    ← Rust sidecar 服务（dist 内嵌，放在 exe 旁）
//         public/                              ← 运行时资源（可修改）
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const releaseDir = resolve(root, "release", "tauri");
const srcTauri = resolve(root, "src-tauri");
const binariesDir = resolve(srcTauri, "binaries");
// 与 src-tauri/src/lib.rs 的 SIDECAR_NAME 一致；Tauri externalBin 会整体追加 -<triple>
const triple = "x86_64-pc-windows-msvc";
const serverBin =
  process.platform === "win32" ? "touchshow-server.exe" : "touchshow-server";
const rustServer = resolve(root, "backend", "target", "release", serverBin);
// Windows：TouchShow-server.exe-<triple>.exe；Linux：TouchShow-server.exe-<triple>
const sidecarName = `TouchShow-server.exe-${triple}${process.platform === "win32" ? ".exe" : ""}`;
const sidecarExe = resolve(binariesDir, sidecarName);

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
cpSync(rustServer, sidecarExe);
console.log(`  sidecar → ${sidecarExe}`);

// [3/4] tauri build（bundle.active=false 只出裸 exe；externalBin 会把 sidecar 复制到 exe 旁）
console.log("\n[3/4] tauri build ...");
execSync("npx tauri build", { cwd: root, stdio: "inherit", shell: true });

// [4/4] 复制主程序 + sidecar + public 到 release/tauri/
console.log("\n[4/4] 复制产物到 release/tauri/ ...");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// 主程序
const mainExeName = "TouchShow.exe";
const mainExe = resolve(srcTauri, "target", "release", mainExeName);
if (!existsSync(mainExe)) throw new Error(`未找到主程序: ${mainExe}`);
cpSync(mainExe, join(releaseDir, mainExeName));

// sidecar：优先取 tauri 已复制到 exe 旁的文件，否则用步骤 2 生成的
const sidecarInTarget = resolve(srcTauri, "target", "release", sidecarName);
cpSync(
  existsSync(sidecarInTarget) ? sidecarInTarget : sidecarExe,
  join(releaseDir, basename(sidecarName)),
);

// public 与 exe 同目录，运行时读取且可修改（dist 已内嵌于 sidecar）
cpSync(resolve(root, "public"), resolve(releaseDir, "public"), {
  recursive: true,
});

// 使用说明与 exe 同目录
const usageDoc = resolve(root, "使用说明.txt");
if (existsSync(usageDoc)) {
  cpSync(usageDoc, join(releaseDir, "使用说明.txt"));
}

console.log("\n✅ Tauri 打包完成（免安装，直接运行）！");
console.log(`   主程序: ${join(releaseDir, mainExeName)}`);
console.log(`   sidecar: ${join(releaseDir, basename(sidecarName))}`);
console.log(`   public: ${join(releaseDir, "public")}  ← 运行时资源（可修改）`);
console.log("   dist  : 已内嵌于 sidecar（编译时固化，不可外部修改）");
