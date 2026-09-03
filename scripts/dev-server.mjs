// TouchShow 开发模式的后端运行器：直接运行 Rust 服务二进制（避免 cargo run 的
// 包装进程被杀后留下孤儿服务占用 3000 端口）。父进程退出/收到终止信号时同步杀掉子进程。
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe =
  process.platform === "win32" ? "touchshow-server.exe" : "touchshow-server";
const bin = join(root, "backend", "target", "debug", exe);

const child = spawn(bin, [], { cwd: root, stdio: "inherit", env: process.env });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });
}
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
