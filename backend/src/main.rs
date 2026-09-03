//! TouchShow Rust 后端服务入口（替代原 node server.cjs + lib/*.cjs）。
//!
//! 职责：
//!  - 目录解析（public 外部可改资源 / dist 前端产物，均支持 env 覆盖）
//!  - 启动 HTTP + WebSocket 服务，挂载全部 /api/* 路由与静态资源
//!  - 启动时按 config.json 应用串口配置、轮询监听 config.json 外部改动
//!  - 非 TOUCHSHOW_NO_OPEN 模式下自动全屏打开浏览器

mod api;
mod config;
mod embed;
mod iputil;
mod live;
mod serial;
mod state;
mod web;

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;

use crate::config::read_config_file;
use crate::state::{AppState, DistSource};

/// 解析一个运行时目录：
///   1. env 显式指定（TOUCHSHOW_PUBLIC / TOUCHSHOW_DIST）；
///   2. exe 同目录下的子目录（打包后布局：TouchShow.exe + public/ + dist/）；
///   3. 当前工作目录下的子目录（源码/开发态，npm 脚本在项目根运行）。
fn resolve_dir(env_var: &str, sub: &str) -> PathBuf {
    if let Ok(v) = env::var(env_var) {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand = parent.join(sub);
            if cand.is_dir() {
                return cand;
            }
        }
    }
    if let Ok(cwd) = env::current_dir() {
        let cand = cwd.join(sub);
        if cand.is_dir() {
            return cand;
        }
    }
    // 兜底：仍然返回 cwd/sub（目录不存在时各读取方自然失败/回退）
    env::current_dir()
        .map(|c| c.join(sub))
        .unwrap_or_else(|_| PathBuf::from(sub))
}

/// 解析前端产物（dist）来源：
///   1. env TOUCHSHOW_DIST 显式指定 → 外部目录（测试/开发注入用）；
///   2. 编译期内嵌（build.rs 检测到项目根 dist/ 时启用）→ 打包发布形态，dist 固化在 exe 内；
///   3. 未内嵌（如首次在无 dist 时编译）→ 退回外部目录（exe 同目录 / cwd）。
fn resolve_dist() -> DistSource {
    if let Ok(v) = env::var("TOUCHSHOW_DIST") {
        if !v.trim().is_empty() {
            return DistSource::Folder(PathBuf::from(v));
        }
    }
    if embed::enabled() {
        return DistSource::Embedded;
    }
    DistSource::Folder(resolve_dir("TOUCHSHOW_DIST", "dist"))
}

/// 自动打开浏览器全屏（对齐 server.cjs 启动逻辑）：
/// 只打开一个浏览器，优先 Chrome，其次 Edge，都没有才用系统默认浏览器。
#[cfg(windows)]
fn open_browser(url: &str) {
    use std::process::Command;
    let local = env::var("LOCALAPPDATA").unwrap_or_default();
    let candidates = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        &format!("{local}/Google/Chrome/Application/chrome.exe"),
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ];
    for exe in candidates {
        if std::path::Path::new(exe).exists() {
            let name = if exe.contains("Chrome") { "Chrome" } else { "Edge" };
            println!("使用 {name} 全屏打开展示...");
            let _ = Command::new(exe)
                .args(["--kiosk", "--new-window", url])
                .spawn()
                .map_err(|e| println!("打开 {name} 失败: {e}"));
            return;
        }
    }
    println!("未检测到 Chrome/Edge，使用默认浏览器打开...");
    let _ = Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|e| println!("打开默认浏览器失败: {e}"));
}

#[cfg(not(windows))]
fn open_browser(url: &str) {
    use std::process::Command;
    let _ = Command::new("xdg-open").arg(url).spawn();
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(3000);
    let no_open = env::var("TOUCHSHOW_NO_OPEN").as_deref() == Ok("1");
    // ADMIN_TOKEN 未显式设置时使用开发默认令牌，并在启动 banner 醒目告警（安全兜底提示）
    let using_default_token = env::var("ADMIN_TOKEN").is_err();
    let token = if using_default_token {
        "11223344".to_string()
    } else {
        env::var("ADMIN_TOKEN").unwrap_or_default()
    };
    // 预先记录令牌是否为空（token 随后 move 进 AppState，启动 banner 仍需该信息）
    let token_is_empty = token.is_empty();

    let public_dir = resolve_dir("TOUCHSHOW_PUBLIC", "public");
    let dist = resolve_dist();
    let config_file = public_dir.join("config.json");

    let live = live::Live::new();
    let serial = serial::new_manager();

    let state = Arc::new(AppState {
        public_dir,
        dist,
        config_file: config_file.clone(),
        token,
        live,
        serial,
    });

    // 启动时按 config.json 的 serial 段尝试连接串口（未启用则无操作）
    if let Some(cfg) = read_config_file(&config_file) {
        serial::apply_config(&state.serial, &cfg).await;
    }

    // 轮询监听 config.json 被外部工具直接修改 → 广播 config-changed
    config::spawn_config_watcher(state.clone());

    let app = Router::new()
        .route("/api/config", get(api::get_config).post(api::post_config))
        .route("/api/control", post(api::post_control))
        .route("/api/models", get(api::get_models))
        .route("/api/files", get(api::get_files))
        .route("/api/upload", post(api::upload))
        .route("/api/local-ip", get(api::get_local_ip))
        .route("/api/serial/status", get(api::serial_status))
        .route("/api/serial/ports", get(api::serial_ports))
        .route("/api/serial/connect", post(api::serial_connect))
        .route("/api/serial/disconnect", post(api::serial_disconnect))
        .route("/api/serial/send", post(api::serial_send))
        .route("/api/serial/action", post(api::serial_action))
        .route("/api/ws", get(live::ws_handler))
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
        .fallback(web::static_fallback)
        .with_state(state.clone());

    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .unwrap_or_else(|e| panic!("绑定端口 {port} 失败: {e}"));

    println!("==========================================");
    println!("TouchShow running at http://localhost:{port}");
    println!("可修改资源(public): {}", state.public_dir.display());
    let dist_desc = match &state.dist {
        DistSource::Embedded => "内嵌于可执行文件（编译时打包，不可外部修改）".to_string(),
        DistSource::Folder(p) => p.display().to_string(),
    };
    println!("前端产物(dist)   : {dist_desc}");
    println!("实时推送(WebSocket): ws://localhost:{port}/api/ws");
    // 管理令牌状态提示：使用默认令牌时醒目告警，避免误以为管理接口已有保护
    if using_default_token {
        println!("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        println!("!! 安全提醒：正在使用默认管理令牌 11223344");
        println!("!! 请通过环境变量 ADMIN_TOKEN 设置自定义令牌");
        println!("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    } else if token_is_empty {
        println!("管理令牌: 未设置（开放模式，管理接口不受保护）");
    } else {
        println!("管理令牌: 已启用（ADMIN_TOKEN 自定义）");
    }
    println!("==========================================");

    if no_open {
        println!("TOUCHSHOW_NO_OPEN=1，不打开外部浏览器（Tauri 窗口模式）");
    } else {
        open_browser(&format!("http://localhost:{port}"));
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}
