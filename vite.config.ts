import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import type { ServerResponse } from 'node:http';

/**
 * 开发服务器本机 IP 接口：
 *  - configureServer 同步部分在 Vite 内部中间件（含 /api 代理）之前执行，
 *    因此 /api/local-ip 在此被直接拦截，dev 模式不启动 Rust 后端也能返回本机 IP；
 *  - 与 Rust 后端 GET /api/local-ip 返回结构保持一致（{ ok, ips: [{name,address,netmask}] }）。
 */
function localIpPlugin(): Plugin {
  return {
    name: 'touchshow-local-ip',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/local-ip', (req, res) => {
        const ips: { name: string; address: string; netmask: string }[] = [];
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const iface of ifaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
              ips.push({ name, address: iface.address, netmask: iface.netmask });
            }
          }
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, ips }));
      });
    },
  };
}

/**
 * 开发服务器 404 兜底：
 *  - 通过 configureServer 返回的后置钩子注册，位于 Vite 内部中间件（含 htmlFallback）之后；
 *  - 配合 appType: 'mpa'（关闭 SPA history fallback），未被任何页面/静态资源/模块匹配到的
 *    浏览器导航请求会走到这里，统一返回 404 状态与 404.html 页面；
 *  - htmlFallback 可能已把 /、/admin 等改写为 /index.html、/admin.html，因此这里
 *    先判断路径对应的文件是否真实存在，存在则放行由 Vite 后续中间件正常提供。
 */
function notFoundPage(): Plugin {
  const rootDir = fileURLToPath(new URL('.', import.meta.url));
  const publicDir = path.join(rootDir, 'public');
  const notFoundHtml = readFileSync(new URL('./404.html', import.meta.url), 'utf-8');

  // 判断路径对应的文件是否真实存在（root 或 public 目录），避免误拦截合法页面/资源
  const isRealFile = (pathname: string): boolean => {
    const rel = pathname.replace(/^\/+/, '');
    return [path.join(rootDir, rel), path.join(publicDir, rel)].some(
      (p) => p.startsWith(rootDir) && existsSync(p),
    );
  };

  // 是否为浏览器导航请求（Accept 含 text/html），用于区分 fetch/EventSource 等 API 请求
  const isNavigation = (accept?: string): boolean =>
    (accept || '').includes('text/html');

  // 输出统一的 404 页面（HTTP 状态码 404）
  const sendNotFound = (res: ServerResponse): void => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(notFoundHtml);
  };

  return {
    name: 'touchshow-404',
    apply: 'serve',
    configureServer(server) {
      // 同步部分（在 Vite 内部中间件，含 /api 代理之前）执行：
      // 拦截对 /api 及未知 /api/* 的浏览器导航请求，直接返回 404 页面。
      // 否则这类请求会经代理转发到 express，而 express 返回的是 dist 里的构建版 404
      // （引用 /assets/...），dev 下这些资源不存在，404 页面会丢失样式。
      // 真正的 API 请求（fetch/EventSource，Accept 不含 text/html）仍交由代理处理。
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = (req.url || '').split('?')[0];
        if (!pathname.startsWith('/api')) return next();
        if (!isNavigation(req.headers.accept)) return next();
        sendNotFound(res);
      });

      // 通过 configureServer 返回的后置钩子注册，位于 Vite 内部中间件（含 htmlFallback）之后；
      // 配合 appType: 'mpa'（关闭 SPA history fallback），未被任何页面/静态资源/模块匹配到的
      // 浏览器导航请求会走到这里，统一返回 404 状态与 404.html 页面；
      // htmlFallback 可能已把 /、/admin 等改写为 /index.html、/admin.html，因此这里
      // 先判断路径对应的文件是否真实存在，存在则放行由 Vite 后续中间件正常提供。
      return () => {
        server.middlewares.use((req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next();
          const pathname = (req.url || '').split('?')[0];
          // API 请求交由代理（/api → express 后端）处理
          if (pathname.startsWith('/api/')) return next();
          // 仅对浏览器导航请求返回 404 页面，其余（如图片/模块等资源）走 Vite 默认 404
          if (!isNavigation(req.headers.accept)) return next();
          // 真实存在的页面/资源（含 htmlFallback 已改写的 /index.html、/admin.html 等）放行
          if (isRealFile(pathname)) return next();
          sendNotFound(res);
        });
      };
    },
  };
}

/**
 * HTML 基础路径注入：
 *  - 构建时把 HTML（如 404.html 的返回首页链接）中的 __APP_BASE__ 占位符
 *    替换为解析后的 base（默认 '/'；GitHub Pages 构建为 '/TouchShow/'）；
 *  - 纯内联脚本 / 普通 <a href> 不走 Vite 的 import.meta.env 注入，
 *    需要用该占位符方式在构建期固化基础路径。
 */
function htmlBasePlugin(): Plugin {
  let base = '/';
  return {
    name: 'touchshow-html-base',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml(html) {
      return html.replaceAll('__APP_BASE__', base);
    },
  };
}

// Vite 配置：开启局域网访问（host: true），方便触摸屏/局域网内设备调试
export default defineConfig({
  // 项目根目录默认为当前目录（即本配置文件所在目录），此处显式声明
  root: '.',
  // MPA 模式：关闭 SPA history fallback（未知路径不再回退到 index.html），
  // 配合 notFoundPage 插件让不支持的地址显示 404 页面
  appType: 'mpa',
  plugins: [localIpPlugin(), notFoundPage(), htmlBasePlugin()],
  server: {
    // 监听 0.0.0.0，允许局域网内其他设备（如触摸屏一体机）通过本机 IP 访问
    host: true,
    // 默认端口 5173，若被占用 Vite 会自动递增
    port: 5173,
    // 忽略构建产物 / 打包输出目录，避免文件监听器去 watch 被占用（正在运行的 exe）或频繁变动的
    // 大目录而崩溃/反复触发页面重载（如 release/TouchShow.exe 被占用会报 EBUSY，src-tauri/target
    // 的编译产物变动会导致无意义 reload）
    watch: {
      ignored: [
        '**/release/**',
        '**/src-tauri/target/**',
        '**/cache/**',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
    // 远程配置/实时通道 API 代理到 Rust 后端服务（backend/，默认 3000）
    // 这样开发模式下前端也能访问 /api/config 及 WebSocket 实时通道（/api/ws）
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // 允许 WebSocket 升级（/api/ws 实时通道，代理 HTTP upgrade 请求）
        ws: true,
        // 透传客户端真实来源 IP（X-Forwarded-For）：dev 下 server 收到的连接来自
        // Vite 本机，若不透传，客户端列表只能看到 127.0.0.1（回退为本机 IP）。
        xfwd: true,
        // 禁用代理层超时（http-proxy 的 timeout / proxyTimeout 均设为 0），
        // 避免开发模式下长时间实时连接被代理层掐断。
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    // public 目录不复制进 dist：运行时资源（产品图/3D模型/config.json）由 exe 外部加载，可随时修改/更换
    copyPublicDir: false,
    // three.js 体积较大，将其拆分为独立 vendor chunk，
    // 避免所有代码挤进单个大 chunk，同时利用浏览器长缓存
    rollupOptions: {
      // 多页面入口：index.html（展示页）+ admin.html（远程配置管理页）+ 404.html（不支持的地址），
      // 均随构建打进 dist（public 目录不复制，故 404.html 必须作为构建入口）
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) {
            if (id.includes('examples/jsm')) return 'three-examples';
            return 'three';
          }
        },
      },
    },
    // three.js minify 后仍会超过 500 kB，放宽该阈值以消除警告
    chunkSizeWarningLimit: 1200,
  },
});
