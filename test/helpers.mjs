/* ==================================================================
 * 后端测试辅助 —— 以“黑盒”方式启动真实 Rust 服务二进制
 * ------------------------------------------------------------------
 * 设计原则：不修改任何业务代码。测试通过子进程 + 隔离的
 * TOUCHSHOW_PUBLIC 临时目录运行真实服务，用 HTTP 断言其行为，
 * 作为后端（backend/，Rust）的回归基线。
 *
 * 前置条件：dist/ 已构建（npm run build）+ Rust 二进制已构建
 * （npm run build:server；npm test 会自动先跑 pretest）。
 * ================================================================== */
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
// ws 客户端：实时通道 /api/ws（服务端同一依赖）
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
/** Rust 后端二进制（需先构建：npm run build:server / cargo build） */
export const SERVER = join(
  ROOT,
  "backend",
  "target",
  "debug",
  process.platform === "win32" ? "touchshow-server.exe" : "touchshow-server",
);
/** 测试用管理令牌（与生产 ADMIN_TOKEN 解耦，显式设置以便验证 401/200） */
export const TEST_TOKEN = "test-token-123";

/** 断言 dist 已构建（server 的静态页面/404 均来自 dist） */
export function checkDist() {
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error(
      "dist/ 缺失（尚未构建）。请先运行 `npm run build` 再执行测试。",
    );
  }
}

/** 创建隔离的临时 public 目录（最小 config.json + 假模型 + 静态文件） */
export function makePublicDir() {
  const dir = mkdtempSync(join(tmpdir(), "touchshow-test-public-"));
  const models = join(dir, "Models");
  mkdirSync(models, { recursive: true });
  // 假模型：验证 /api/models 只返回模型扩展
  writeFileSync(join(models, "demo.glb"), "fake-model", "utf8");
  writeFileSync(join(models, "note.txt"), "should-be-filtered", "utf8");
  // 静态文件：验证外部 public 优先服务
  writeFileSync(join(dir, "hello.txt"), "hello-from-public", "utf8");
  const cfg = {
    model: "C919.glb",
    displayMode: "model",
    category: [
      {
        label: "测试分类",
        icon: "",
        description: "desc",
        product: [
          {
            label: "产品A",
            action: "action_a",
            description: "x",
            image: "/products/a.png",
          },
        ],
      },
    ],
    serial: {
      enabled: false,
      port: "",
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      template: "{action}\r\n",
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  return dir;
}

/** 探测一个空闲端口（轻微竞态可接受，仅用于测试） */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 启动测试 server（Rust 后端二进制）并等待 /api/config 就绪。
 * @returns {Promise<{base, publicDir, stop, child, stdout(): string}>}
 */
export async function startServer(opts = {}) {
  checkDist();
  if (!existsSync(SERVER)) {
    throw new Error(
      `Rust 后端二进制缺失（${SERVER}）。请先运行 \`npm run build:server\`（cargo build）。`,
    );
  }
  const publicDir = opts.publicDir || makePublicDir();
  const port = opts.port || (await findFreePort());
  // 基准环境 + 默认注入；opts.env 中值为 undefined/null 的键表示“从环境中删除”
  // （例如删除 ADMIN_TOKEN 以验证“未设置令牌”分支的行为）。
  const env = {
    ...process.env,
    PORT: String(port),
    TOUCHSHOW_PUBLIC: publicDir,
    TOUCHSHOW_DIST: join(ROOT, "dist"),
    TOUCHSHOW_NO_OPEN: "1",
    ADMIN_TOKEN: TEST_TOKEN,
  };
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined || v === null) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  const child = spawn(SERVER, [], {
    env,
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 收集 stdout（含启动 banner），供测试断言启动提示（如默认令牌告警）
  const stdoutChunks = [];
  child.stdout.on("data", (d) => stdoutChunks.push(String(d)));
  child.stderr.on("data", (d) => process.stderr.write("[server-stderr] " + d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server 进程提前退出 code=${child.exitCode}`);
    }
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) break;
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error("server 启动超时（8s）");
    await new Promise((r) => setTimeout(r, 100));
  }

  const ownsPublic = opts.publicDir == null;
  let stopped = false;
  return {
    base,
    publicDir,
    child,
    /** 服务进程 stdout（含启动 banner），供断言启动提示 */
    stdout: () => stdoutChunks.join(""),
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await new Promise((res) => {
          child.once("exit", res);
          child.kill();
          setTimeout(res, 1500); // 兜底：进程未及时退出也继续
        });
      } catch {
        /* ignore */
      }
      if (ownsPublic) {
        try {
          rmSync(publicDir, { recursive: true, force: true });
        } catch {
          /* Windows 下 watch 句柄释放可能有延迟，残留于系统临时目录可接受 */
        }
      }
    },
  };
}

/** POST JSON（可选带管理令牌头） */
export function postJson(base, path, body, token) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-admin-token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * 打开 WebSocket 实时通道连接（展示屏/管理页角色可选，可带 ?name= 命名屏），
 * 缓存收到的消息并支持按 type 等待。
 * @returns {Promise<{ws: WebSocket, waitFor(type, ms): Promise<object>, close(): void}>}
 */
export async function openWs(base, role = "screen", name = "") {
  const params = new URLSearchParams({ role });
  if (name) params.set("name", name);
  const url = base.replace(/^http/, "ws") + "/api/ws?" + params.toString();
  const ws = new WebSocket(url);
  return await new Promise((resolve, reject) => {
    const seen = [];
    let cursor = 0; // 已消费消息下标：waitFor 只匹配新消息，避免重复命中旧广播
    ws.on("message", (d) => seen.push(String(d)));
    const waitFor = (type, ms = 4000) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const tick = () => {
          for (let i = cursor; i < seen.length; i++) {
            try {
              const j = JSON.parse(seen[i]);
              if (j && j.type === type) {
                cursor = i + 1;
                return res(j);
              }
            } catch {
              /* ignore */
            }
          }
          if (Date.now() - t0 > ms) {
            return rej(new Error(`WS 未在 ${ms}ms 内收到「${type}」`));
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    ws.on("open", () =>
      resolve({
        ws,
        waitFor,
        close: () => {
          try {
            ws.close();
          } catch (e) {
            /* ignore */
          }
        },
      }),
    );
    ws.on("error", reject);
  });
}
