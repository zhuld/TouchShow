//! config.json 读写（稳健原子写入）与外部变更监听（轮询 mtime，替代 node fs.watch）。

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::state::AppState;

/// 读取 config.json；不存在/非合法 JSON 时返回 None（对齐 node readConfig）。
pub fn read_config_file(path: &Path) -> Option<Value> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).ok(),
        Err(_) => None,
    }
}

/// 当前时间的 Unix 毫秒时间戳（对齐 Date.now()）。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文件修改时间（Unix 毫秒）。
fn modified_ms(path: &Path) -> Option<u128> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
}

/// 稳健写入 config.json：
///  1. 优先原子替换（写 config.json.tmp + rename），避免写一半损坏；
///  2. rename 失败（文件被编辑器/杀软以“禁改名”方式占用）时重试 3 次；
///  3. 仍失败则退回直接写入（绕过禁止 rename 的文件锁）。
pub async fn write_config_file(path: &Path, cfg: &Value) -> std::io::Result<()> {
    let content = serde_json::to_string_pretty(cfg).unwrap_or_else(|_| "{}".to_string());
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, content.as_bytes()).await?;

    let mut renamed = false;
    for _ in 0..3 {
        match tokio::fs::rename(&tmp, path).await {
            Ok(()) => {
                renamed = true;
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }

    if !renamed {
        let _ = tokio::fs::remove_file(&tmp).await;
        // 直接写入兜底（非原子，但可绕过“禁止 rename”的文件锁）
        tokio::fs::write(path, content.as_bytes()).await?;
    }
    Ok(())
}

/// 轮询监听 config.json 被外部工具直接修改：即使未走 POST /api/config，
/// 也能立刻广播 config-changed 给所有展示屏。
/// 用 mtime 轮询（1s）替代 node fs.watch：无 OS 句柄、跨平台、简单可靠。
pub fn spawn_config_watcher(state: Arc<AppState>) {
    tokio::spawn(async move {
        let path = state.config_file.clone();
        let mut last = modified_ms(&path);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let cur = modified_ms(&path);
            if cur.is_some() && cur != last {
                last = cur;
                state
                    .live
                    .broadcast("config-changed", serde_json::json!({ "time": now_ms() }))
                    .await;
            }
        }
    });
}
