// TouchShow 一键打包脚本（后端为 Rust 服务）
//
//   1. 构建前端（tsc && vite build）→ dist/
//   2. cargo build --release 编译 Rust 后端（dist 随编译期内嵌进 exe）→
//      backend/target/release/touchshow-server(.exe)
//   3. 准备 release/ 输出目录（清空重建）
//   4. 复制 Rust 服务为独立 TouchShow.exe
//   5. 复制 public/ + 使用说明.txt 到 release/（public 位于 exe 旁，可随时修改/更换）
//   6. Tauri 打包（可选，需 Rust 工具链）→ release/tauri/
//
// 用法：npm run package
// 说明：前端产物 dist 已内嵌于 exe（编译时固化，不可被外部修改/替换）；
//       发布只需 TouchShow.exe + public/，无需安装 Node、无需在 exe 旁放置 dist。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const releaseDir = resolve(root, "release");
const exeName = "TouchShow.exe";
const serverBin =
  process.platform === "win32" ? "touchshow-server.exe" : "touchshow-server";
const serverExe = resolve(root, "backend", "target", "release", serverBin);

// [1/6] 构建前端
console.log("\n[1/6] 构建前端 (tsc && vite build) ...");
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

// [2/6] cargo release 编译 Rust 后端
console.log("\n[2/6] 编译 Rust 后端 (cargo build --release) ...");
execSync("npm run build:server:release", {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
if (!existsSync(serverExe)) {
  throw new Error(`Rust 后端产物缺失: ${serverExe}`);
}

// [3/6] 准备输出目录
console.log("\n[3/6] 准备 release 输出目录 ...");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// [4/6] 复制 Rust 服务为独立 exe
console.log("\n[4/6] 复制 Rust 服务 → release/TouchShow.exe ...");
cpSync(serverExe, resolve(releaseDir, exeName));

// [5/6] 复制 public + 使用说明（public 位于 exe 旁，可随时修改/更换；dist 已内嵌）
console.log("\n[5/6] 复制 public/使用说明（dist 已内嵌） ...");
cpSync(resolve(root, "public"), resolve(releaseDir, "public"), {
  recursive: true,
});
const usageDoc = resolve(root, "使用说明.txt");
if (existsSync(usageDoc)) {
  cpSync(usageDoc, resolve(releaseDir, "使用说明.txt"));
}

// [6/6] Tauri 打包（可选，需 Rust 工具链 cargo；缺失时跳过并提示）
console.log("\n[6/6] Tauri 打包 ...");
try {
  execSync("cargo --version", { stdio: "ignore" });
  execSync("node scripts/package-tauri.mjs", {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
} catch {
  console.log("   ⚠ 未检测到 cargo（Rust 工具链），跳过 Tauri 打包。");
  console.log("   可先安装 rustup，再单独运行 npm run package:tauri");
}

console.log("\n✅ 打包完成！");
console.log(`   exe   : ${resolve(releaseDir, exeName)}`);
console.log(
  `   public: ${resolve(releaseDir, "public")}  ← 可随时修改/更换，无需重新打包`,
);
console.log("   dist  : 已内嵌于 exe（编译时固化，不可外部修改）");
console.log(
  `   tauri : ${resolve(releaseDir, "tauri")}  ← Tauri 版（需 cargo）`,
);
