/* ==================================================================
 * 后端 HTTP 行为基线测试（黑盒，不改业务代码）
 * ------------------------------------------------------------------
 * 启动真实 Rust 服务二进制（backend/target/debug/touchshow-server，
 * 隔离 TOUCHSHOW_PUBLIC 临时目录），用 HTTP 断言其行为：
 * 静态页 / 配置 API / 鉴权 / 远程控制 / 模型 / 本机 IP / 串口 /
 * WebSocket 实时通道。
 *
 * 运行：npm test（需先 npm run build 生成 dist/；pretest 会自动编译 Rust 服务）
 * ================================================================== */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, postJson, openWs, TEST_TOKEN } from "./helpers.mjs";

let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  await srv.stop();
});

/* ==================================================================
 * 静态页面 / 静态资源
 * ================================================================== */
test("GET / 返回展示页 HTML", async () => {
  const res = await fetch(srv.base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const html = await res.text();
  assert.match(html, /TouchShow 3D 展览展示/);
});

test("GET /admin 与 /admin.html 返回管理页", async () => {
  for (const p of ["/admin", "/admin.html"]) {
    const res = await fetch(srv.base + p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /TouchShow 远程配置/);
  }
});

test("外部 public 静态资源优先被服务", async () => {
  const res = await fetch(srv.base + "/hello.txt");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello-from-public");
});

test("不存在的路径返回 404", async () => {
  const res = await fetch(srv.base + "/no-such-page-xyz");
  assert.equal(res.status, 404);
});

/* ==================================================================
 * 配置 API
 * ================================================================== */
test("GET /api/config 返回初始配置", async () => {
  const res = await fetch(srv.base + "/api/config");
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.ok(Array.isArray(cfg.category));
  assert.equal(cfg.category[0].label, "测试分类");
  assert.equal(cfg.category[0].product[0].label, "产品A");
  assert.equal(cfg.serial.enabled, false);
});

test("POST /api/config 鉴权：无令牌 / 错令牌返回 401", async () => {
  const body = { category: [], model: "C919.glb" };
  const noToken = await postJson(srv.base, "/api/config", body);
  assert.equal(noToken.status, 401);
  const badToken = await postJson(srv.base, "/api/config", body, "wrong-token");
  assert.equal(badToken.status, 401);
});

test("POST /api/config 格式校验：顶层缺少 category 返回 400", async () => {
  const res = await postJson(srv.base, "/api/config", { foo: 1 }, TEST_TOKEN);
  assert.equal(res.status, 400);
});

test("POST /api/config 合法保存：写盘成功且 GET 可读回新值", async () => {
  const payload = {
    model: "C919.glb",
    displayMode: "image",
    category: [
      {
        label: "新分类",
        icon: "",
        description: "new",
        product: [
          { label: "新产品", action: "n", description: "d", image: "/p.png" },
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
  const res = await postJson(srv.base, "/api/config", payload, TEST_TOKEN);
  assert.equal(res.status, 200);
  const ok = await res.json();
  assert.equal(ok.ok, true);

  // 接口读回一致
  const get = await (await fetch(srv.base + "/api/config")).json();
  assert.equal(get.category[0].label, "新分类");
  assert.equal(get.displayMode, "image");

  // 真实写盘到隔离的 public/config.json
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const onDisk = JSON.parse(
    readFileSync(join(srv.publicDir, "config.json"), "utf8"),
  );
  assert.equal(onDisk.category[0].product[0].label, "新产品");
});

/* ==================================================================
 * 远程控制 API
 * ================================================================== */
test("POST /api/control：无令牌 401；category 负数 400；合法 200", async () => {
  const noToken = await postJson(srv.base, "/api/control", {
    action: "category",
    category: 0,
  });
  assert.equal(noToken.status, 401);

  const bad = await postJson(
    srv.base,
    "/api/control",
    { action: "category", category: -1 },
    TEST_TOKEN,
  );
  assert.equal(bad.status, 400);

  const cat = await postJson(
    srv.base,
    "/api/control",
    { action: "category", category: 0 },
    TEST_TOKEN,
  );
  assert.equal(cat.status, 200);
  assert.equal((await cat.json()).ok, true);

  const sidebar = await postJson(
    srv.base,
    "/api/control",
    { action: "sidebar", visible: false },
    TEST_TOKEN,
  );
  assert.equal(sidebar.status, 200);
  assert.equal((await sidebar.json()).ok, true);
});

/* ==================================================================
 * 模型列表
 * ================================================================== */
test("GET /api/models 只返回模型扩展名文件", async () => {
  const res = await fetch(srv.base + "/api/models");
  assert.equal(res.status, 200);
  const { ok, models } = await res.json();
  assert.equal(ok, true);
  assert.ok(models.includes("demo.glb"), `应有 demo.glb，实得：${models}`);
  assert.ok(!models.includes("note.txt"), "note.txt 应被过滤");
});

/* ==================================================================
 * 本机 IP
 * ================================================================== */
test("GET /api/local-ip 返回 IPv4 地址列表", async () => {
  const res = await fetch(srv.base + "/api/local-ip");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.ips));
  for (const ip of data.ips) {
    assert.match(ip.address, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.ok(typeof ip.name === "string");
  }
});

/* ==================================================================
 * 串口（未启用时应保持静默，不拉起 PowerShell worker）
 * ================================================================== */
test("GET /api/serial/status 在未启用时返回 disabled 状态", async () => {
  const res = await fetch(srv.base + "/api/serial/status");
  assert.equal(res.status, 200);
  const st = await res.json();
  assert.equal(st.ok, true);
  assert.equal(st.config.enabled, false);
  assert.equal(st.connected, false);
  assert.equal(st.workerAlive, false);
});

test("POST /api/serial/action 未启用时返回 skipped", async () => {
  const res = await postJson(srv.base, "/api/serial/action", {
    action: "action_a",
    label: "产品A",
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.skipped, true);
  assert.equal(data.reason, "serial disabled");
});

/* ==================================================================
 * 串口管理端点鉴权（#2）：connect/disconnect/send 需管理令牌，
 * action 由展示屏运行时调用、status/ports 为只读信息，保持开放。
 * ================================================================== */
test("串口管理端点鉴权：connect/disconnect/send 无令牌 / 错令牌返回 401", async () => {
  const noTokenSend = await postJson(srv.base, "/api/serial/send", {
    data: "x",
  });
  assert.equal(noTokenSend.status, 401);

  const noTokenConnect = await postJson(srv.base, "/api/serial/connect", {});
  assert.equal(noTokenConnect.status, 401);

  const badTokenConnect = await postJson(
    srv.base,
    "/api/serial/connect",
    {},
    "wrong-token",
  );
  assert.equal(badTokenConnect.status, 401);

  const noTokenDisconnect = await fetch(srv.base + "/api/serial/disconnect", {
    method: "POST",
  });
  assert.equal(noTokenDisconnect.status, 401);
});

test("POST /api/serial/send 带令牌：缺 data 400；未启用时写串口 500", async () => {
  const noData = await postJson(srv.base, "/api/serial/send", {}, TEST_TOKEN);
  assert.equal(noData.status, 400);

  const send = await postJson(
    srv.base,
    "/api/serial/send",
    { data: "hello" },
    TEST_TOKEN,
  );
  assert.equal(send.status, 500);
  const err = await send.json();
  assert.match(err.error || "", /串口未启用/);
});

test("POST /api/serial/connect|disconnect 带令牌返回 200", async () => {
  const connect = await postJson(
    srv.base,
    "/api/serial/connect",
    { serial: { enabled: false, port: "", template: "{action}\r\n" } },
    TEST_TOKEN,
  );
  assert.equal(connect.status, 200);
  const c = await connect.json();
  assert.equal(c.connected, false);

  const disconnect = await fetch(srv.base + "/api/serial/disconnect", {
    method: "POST",
    headers: { "x-admin-token": TEST_TOKEN },
  });
  assert.equal(disconnect.status, 200);
  const d = await disconnect.json();
  assert.equal(d.ok, true);
});

/* ==================================================================
 * WebSocket 实时通道
 * ================================================================== */
test("WebSocket：配置保存后展示屏收到 config-changed", async () => {
  const c = await openWs(srv.base, "screen");
  try {
    // 新连接会先收到一次 clients 列表，确认通道已建立
    await c.waitFor("clients");
    const payload = {
      category: [],
      model: "C919.glb",
      displayMode: "image",
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
    const res = await postJson(srv.base, "/api/config", payload, TEST_TOKEN);
    assert.equal(res.status, 200);
    const msg = await c.waitFor("config-changed");
    assert.ok(msg && msg.type === "config-changed");
  } finally {
    c.close();
  }
});

test("WebSocket：管理页远程控制广播 control 到展示屏", async () => {
  const c = await openWs(srv.base, "screen");
  try {
    await c.waitFor("clients");
    const res = await postJson(
      srv.base,
      "/api/control",
      { action: "category", category: 0 },
      TEST_TOKEN,
    );
    assert.equal(res.status, 200);
    const msg = await c.waitFor("control");
    assert.equal(msg.data.action, "category");
    assert.equal(msg.data.category, 0);
  } finally {
    c.close();
  }
});

test("WebSocket：管理页能看到在线展示屏（含 ?name 命名）", async () => {
  // 先连一台带名字的展示屏
  const screen = await openWs(srv.base, "screen", "演示屏A");
  try {
    const first = await screen.waitFor("clients");
    assert.ok(
      first.data.some((c) => c.role === "screen" && c.name === "演示屏A"),
      "clients 列表应包含已连的命名展示屏",
    );

    // 管理页连接同样能收到列表（含自己 role=admin）
    const admin = await openWs(srv.base, "admin");
    try {
      const got = await admin.waitFor("clients");
      const roles = got.data.map((c) => c.role);
      assert.ok(roles.includes("screen"), "管理页列表应含展示屏");
      assert.ok(roles.includes("admin"), "管理页列表应含管理页自身");
      const named = got.data.find((c) => c.name === "演示屏A");
      assert.ok(named && named.role === "screen", "应能看到命名的展示屏");
      // 测试经 127.0.0.1 连接：回环无独立来源 IP，应回退显示本机局域网 IPv4
      assert.match(named.ip, /^\d{1,3}(\.\d{1,3}){3}$/, "来源 IP 应为 IPv4");
      assert.notEqual(named.ip, "127.0.0.1", "回环连接不应显示 127.0.0.1");
    } finally {
      admin.close();
    }
  } finally {
    screen.close();
  }
});

test("WebSocket：断开的连接会从列表中移除", async () => {
  const screen = await openWs(srv.base, "screen", "短命屏");
  const admin = await openWs(srv.base, "admin");
  try {
    await admin.waitFor("clients"); // 建立基线
    const before = (await screen.waitFor("clients")).data.filter(
      (c) => c.name === "短命屏",
    );
    assert.equal(before.length, 1);
    screen.close();
    // 断开后应收到更新后的 clients 列表且不再含短命屏
    let removed = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !removed) {
      try {
        const snap = await admin.waitFor("clients", 500);
        removed = !snap.data.some((c) => c.name === "短命屏");
      } catch {
        /* 等待下一次广播 */
      }
    }
    assert.ok(removed, "展示屏断开后应出现在后续 clients 列表中被移除");
  } finally {
    try {
      screen.close();
    } catch (e) {}
    admin.close();
  }
});

test("WebSocket：屏上报当前展示，管理页客户端列表可见", async () => {
  const admin = await openWs(srv.base, "admin");
  const screen = await openWs(srv.base, "screen", "状态屏");
  try {
    // 屏上报一次当前展示
    screen.ws.send(
      JSON.stringify({
        type: "screen-status",
        data: { category: "防火系统系列", product: "烟雾探测器" },
      }),
    );
    // 等待管理页收到包含该屏 current 的列表
    let found = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !found) {
      try {
        const snap = await admin.waitFor("clients", 500);
        found = snap.data.find(
          (c) =>
            c.name === "状态屏" &&
            c.current &&
            c.current.category === "防火系统系列",
        );
      } catch {
        /* 等待下一次广播 */
      }
    }
    assert.ok(found, "管理页应能看到屏上报的当前分类");
    assert.equal(found.current.product, "烟雾探测器");
  } finally {
    screen.close();
    admin.close();
  }
});

test("WebSocket：control 可定向到单台屏，其它屏不响应", async () => {
  const a = await openWs(srv.base, "screen", "定向A");
  const b = await openWs(srv.base, "screen", "定向B");
  try {
    // 屏B 连接后收到的列表里取屏A 的 id
    const snap = await b.waitFor("clients");
    const aInfo = snap.data.find((c) => c.name === "定向A");
    assert.ok(aInfo && aInfo.id, "应能从列表取到屏A 的 id");

    const res = await postJson(
      srv.base,
      "/api/control",
      { action: "category", category: 0, targetClientId: aInfo.id },
      TEST_TOKEN,
    );
    assert.equal(res.status, 200);
    await a.waitFor("control"); // 屏A 收到
    await assert.rejects(b.waitFor("control", 700)); // 屏B 不应收到
  } finally {
    a.close();
    b.close();
  }
});

test("WebSocket：定向到不存在的客户端返回 404", async () => {
  const res = await postJson(
    srv.base,
    "/api/control",
    { action: "category", category: 0, targetClientId: "no-such-client-id" },
    TEST_TOKEN,
  );
  assert.equal(res.status, 404);
});

/* ==================================================================
 * 资源上传（/api/upload）与文件列表（/api/files）
 * ================================================================== */
function makeMultipart(fields) {
  const fd = new FormData();
  if (fields.kind !== undefined) fd.append("kind", fields.kind);
  if (fields.category !== undefined) fd.append("category", fields.category);
  if (fields.file)
    fd.append(
      "file",
      new Blob([fields.file.body], {
        type: fields.file.type || "application/octet-stream",
      }),
      fields.file.name,
    );
  return fd;
}

test("POST /api/upload 鉴权：无令牌返回 401", async () => {
  const res = await fetch(srv.base + "/api/upload", {
    method: "POST",
    body: makeMultipart({
      kind: "image",
      category: "cat",
      file: { name: "a.png", body: "x" },
    }),
  });
  assert.equal(res.status, 401);
});

test("POST /api/upload 参数校验：非法 kind / 缺文件 / 扩展名 / 缺分类 / 目录穿越均 400", async () => {
  const auth = { "x-admin-token": TEST_TOKEN };
  const cases = [
    { kind: "hack", category: "c", file: { name: "a.png", body: "x" } },
    { kind: "image", category: "c" }, // 缺 file
    { kind: "image", category: "c", file: { name: "a.exe", body: "x" } }, // 扩展名不允许
    { kind: "image", category: "../evil", file: { name: "a.png", body: "x" } }, // 目录穿越
    { kind: "image", file: { name: "a.png", body: "x" } }, // 图片缺 category
  ];
  for (const c of cases) {
    const res = await fetch(srv.base + "/api/upload", {
      method: "POST",
      headers: auth,
      body: makeMultipart(c),
    });
    assert.equal(res.status, 400, JSON.stringify(c));
  }
});

test("POST /api/upload 图片：写入 products/<分类>/，同名覆盖、静态可访问且 /api/files 可列出", async () => {
  const upload = (body) =>
    fetch(srv.base + "/api/upload", {
      method: "POST",
      headers: { "x-admin-token": TEST_TOKEN },
      body: makeMultipart({ kind: "image", category: "上传测试", file: body }),
    });
  const res = await upload({
    name: "demo.png",
    type: "image/png",
    body: "PNGDATA-v1",
  });
  assert.equal(res.status, 200);
  const ok = await res.json();
  assert.equal(ok.ok, true);
  assert.equal(ok.file, "demo.png");
  assert.equal(ok.path, "/products/上传测试/demo.png");

  // 同名覆盖：第二次上传后静态内容为新值；图片资源带 Cache-Control: no-cache
  const res2 = await upload({
    name: "demo.png",
    type: "image/png",
    body: "PNGDATA-v2",
  });
  assert.equal(res2.status, 200);
  const asset = await fetch(srv.base + ok.path);
  assert.equal(asset.headers.get("cache-control"), "no-cache");
  assert.equal(await asset.text(), "PNGDATA-v2");

  const list = await (
    await fetch(
      srv.base + "/api/files?kind=image&category=" + encodeURIComponent("上传测试"),
    )
  ).json();
  assert.ok(list.files.includes("demo.png"), "文件列表应包含 demo.png");
  assert.equal(list.dir, "/products/上传测试");
});

test("POST /api/upload 模型：写入 Models/ 且 /api/files?kind=model 可列出", async () => {
  const res = await fetch(srv.base + "/api/upload", {
    method: "POST",
    headers: { "x-admin-token": TEST_TOKEN },
    body: makeMultipart({ kind: "model", file: { name: "demo.glb", body: "GLB" } }),
  });
  assert.equal(res.status, 200);
  const ok = await res.json();
  assert.equal(ok.path, "/Models/demo.glb");
  const list = await (await fetch(srv.base + "/api/files?kind=model")).json();
  assert.ok(list.files.includes("demo.glb"), "模型列表应包含 demo.glb");
  assert.equal(list.dir, "/Models");
});

