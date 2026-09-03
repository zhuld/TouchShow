// TouchShow Tauri 窗口壳：
//   1. 启动时拉起内嵌的 Node 服务（pkg 编译的 sidecar：TouchShow-server-<triple>.exe）
//      —— 设 TOUCHSHOW_NO_OPEN=1 让它不弹浏览器、不抢端口；CREATE_NO_WINDOW 隐藏其控制台
//   2. 轮询 localhost:PORT 就绪后，主窗口导航到该地址（复用现有 server.cjs 全部能力，
//      含外部可修改的 public 资源、绝对路径 /assets /config.json 等）
//   3. 退出时杀掉 sidecar 子进程

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Windows 专属：creation_flags 用于隐藏子进程控制台
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, RunEvent};

/// 本地服务端口，与 server.cjs 的 PORT 保持一致
const SERVER_PORT: u16 = 3000;

/// pkg 编译的 sidecar 文件名（Tauri externalBin 在配置路径 `TouchShow-server.exe` 后整体追加 -<triple>；
/// 与 scripts/package-tauri*.mjs 里命名一致）
#[cfg(windows)]
const SIDECAR_NAME: &str = "TouchShow-server.exe-x86_64-pc-windows-msvc.exe";
#[cfg(not(windows))]
const SIDECAR_NAME: &str = "TouchShow-server.exe-x86_64-unknown-linux-gnu";

/// Windows CREATE_NO_WINDOW：子进程（Node 服务）不弹控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 保存 sidecar 子进程句柄，防止被 drop 时连带终止
struct SidecarState(Mutex<Option<Child>>);

/// 解析 sidecar 路径：
///   - 源码/开发态：src-tauri/binaries/ 下的 TouchShow-server.exe-<triple>.exe
///   - 安装态：与主程序 exe 同目录；Tauri 会去掉 <triple> 后缀重命名
///     （binaries/TouchShow-server.exe → 安装为 TouchShow-server.exe.exe），
///     因此按多个候选名逐一探测，避免命名差异导致找不到服务
fn resolve_sidecar_path() -> Option<std::path::PathBuf> {
    let dev_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let exe_dir = std::env::current_exe().ok()?.parent().map(|d| d.to_path_buf())?;

    // 可能出现的 sidecar 文件名（平台相关：安装后 Tauri 去掉 triple 后缀，Windows 再保留 .exe）
    #[cfg(windows)]
    let names: [&str; 4] = [
        SIDECAR_NAME, // 带 triple（源码/开发态 + 打包前的 binaries 目录）
        "TouchShow-server.exe.exe", // 安装后（Tauri 去掉 triple 后缀）
        "TouchShow-server.exe", // 兜底
        "TouchShow-server",     // 兜底
    ];
    #[cfg(not(windows))]
    let names: [&str; 3] = [
        SIDECAR_NAME, // 带 triple（源码/开发态 + 打包前的 binaries 目录）
        "TouchShow-server.exe", // 安装后（Tauri 去掉 triple 后缀）
        "TouchShow-server",     // 兜底
    ];

    for dir in [&dev_dir, &exe_dir] {
        for name in &names {
            let p = dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// 轮询等待本地服务就绪
fn wait_for_server(port: u16, timeout_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // 外部可修改资源 public 目录：主程序 exe 同目录（bundle.resources 会把 public 安装到此处）
            let public_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("public")))
                .unwrap_or_else(|| std::path::PathBuf::from("public"));

            // 1) 启动内嵌 Node 服务（sidecar）
            if let Some(sidecar) = resolve_sidecar_path() {
                let mut cmd = Command::new(&sidecar);
                cmd.env("TOUCHSHOW_NO_OPEN", "1")
                    .env("PORT", SERVER_PORT.to_string())
                    .env("TOUCHSHOW_PUBLIC", public_dir.to_string_lossy().to_string());
                // Windows 专属：隐藏子进程控制台窗口（Linux 无此 API）
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);
                match cmd.spawn()
                {
                    Ok(child) => {
                        *app.state::<SidecarState>().0.lock().unwrap() = Some(child);
                    }
                    Err(e) => eprintln!("[TouchShow] 启动内嵌服务失败: {e}"),
                }
            } else {
                eprintln!("[TouchShow] 未找到 sidecar: {SIDECAR_NAME}");
            }

            // 2) 等服务就绪后导航主窗口（后台线程，不阻塞主线程）
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if wait_for_server(SERVER_PORT, 30) {
                    let url = format!("http://localhost:{SERVER_PORT}")
                        .parse::<tauri::Url>()
                        .expect("无效 URL");
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.navigate(url);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 3) 退出时杀掉 sidecar
            if let RunEvent::Exit = event {
                if let Some(mut child) = app_handle.state::<SidecarState>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
