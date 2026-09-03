/* ==================================================================
 * 管理令牌（ADMIN_TOKEN）黑盒行为测试
 * ------------------------------------------------------------------
 * 覆盖启动 banner 的令牌状态提示与对应鉴权行为：
 *  - 未设置 ADMIN_TOKEN → 使用默认令牌 11223344 并在启动 banner 醒目告警；
 *  - 显式设置 ADMIN_TOKEN → 无默认令牌告警，仅自定义令牌可用；
 *  - 显式设置为空字符串 → 开放模式（管理接口不受保护）。
 *
 * 运行：npm test（pretest 自动编译 Rust 服务，需先 npm run build 生成 dist/）
 * ================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, postJson } from "./helpers.mjs";

/** 轮询等待服务 stdout 出现匹配 pattern 的输出（banner 为启动早期输出，允许管道延迟） */
async function waitStdout(srv, pattern, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (pattern.test(srv.stdout())) return;
    if (Date.now() - t0 > ms) {
      throw new Error(
        `stdout 未在 ${ms}ms 内匹配 ${pattern}，实际输出：\n${srv.stdout()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("未设置 ADMIN_TOKEN：启动 banner 醒目告警默认令牌，鉴权按默认令牌生效", async () => {
  const srv = await startServer({ env: { ADMIN_TOKEN: undefined } });
  try {
    // 启动 banner 出现默认令牌安全提醒
    await waitStdout(srv, /安全提醒：正在使用默认管理令牌 11223344/);
    assert.match(srv.stdout(), /ADMIN_TOKEN/);

    // 默认令牌非空 → 管理接口受保护：不带令牌 401，带默认令牌 200
    const noToken = await postJson(srv.base, "/api/control", { action: "sidebar", visible: true });
    assert.equal(noToken.status, 401);
    const withDefault = await postJson(
      srv.base,
      "/api/control",
      { action: "sidebar", visible: true },
      "11223344",
    );
    assert.equal(withDefault.status, 200);
  } finally {
    await srv.stop();
  }
});

test("显式设置 ADMIN_TOKEN：无默认令牌告警，仅自定义令牌可用", async () => {
  const srv = await startServer({ env: { ADMIN_TOKEN: "custom-secret-1" } });
  try {
    // 无默认令牌告警，有“已启用”提示
    await waitStdout(srv, /管理令牌: 已启用/);
    assert.doesNotMatch(srv.stdout(), /默认管理令牌/);

    const wrong = await postJson(
      srv.base,
      "/api/control",
      { action: "sidebar", visible: true },
      "11223344",
    );
    assert.equal(wrong.status, 401);
    const right = await postJson(
      srv.base,
      "/api/control",
      { action: "sidebar", visible: true },
      "custom-secret-1",
    );
    assert.equal(right.status, 200);
  } finally {
    await srv.stop();
  }
});

test("显式设置空 ADMIN_TOKEN：开放模式（管理接口不受保护）", async () => {
  const srv = await startServer({ env: { ADMIN_TOKEN: "" } });
  try {
    await waitStdout(srv, /管理令牌: 未设置（开放模式/);
    assert.doesNotMatch(srv.stdout(), /默认管理令牌/);

    const res = await postJson(srv.base, "/api/control", { action: "sidebar", visible: true });
    assert.equal(res.status, 200);
  } finally {
    await srv.stop();
  }
});
