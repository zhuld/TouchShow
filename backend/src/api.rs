//! REST API 处理（对齐 server.cjs 的全部 /api/* 路由行为）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Multipart, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::config::{now_ms, read_config_file, write_config_file};
use crate::iputil;
use crate::serial;
use crate::state::AppState;

/// 组装 JSON 响应。
fn json_resp(status: StatusCode, v: Value) -> Response {
    (status, Json(v)).into_response()
}

fn ok_json(v: Value) -> Response {
    json_resp(StatusCode::OK, v)
}

/// 管理令牌校验：未设置令牌 = 开放模式；否则比对 x-admin-token / authorization 头。
fn auth_ok(state: &AppState, headers: &HeaderMap) -> bool {
    if state.token.is_empty() {
        return true;
    }
    let h = headers
        .get("x-admin-token")
        .or_else(|| headers.get("authorization"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    h == state.token
}

/// 令牌校验失败的 401 响应。
fn unauthorized() -> Response {
    json_resp(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "管理令牌错误" }))
}

/// 管理令牌校验（开放模式恒通过）；未通过返回 Err(401 响应)。
fn check_auth(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    if auth_ok(state, headers) {
        Ok(())
    } else {
        Err(unauthorized())
    }
}

/// 取 body 中可选整数（对齐 Number.isInteger 语义：非整数返回 None）。
fn body_int(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_u64().map(|u| u as i64)))
}

/// GET /api/config
pub async fn get_config(State(state): State<Arc<AppState>>) -> Response {
    match read_config_file(&state.config_file) {
        Some(cfg) => ok_json(cfg),
        None => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": "config.json 不存在或不是合法 JSON" }),
        ),
    }
}

/// POST /api/config —— 保存并实时推送。
pub async fn post_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let ok_shape = body.is_object()
        && body
            .get("category")
            .map(|c| c.is_array())
            .unwrap_or(false);
    if !ok_shape {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "配置格式错误：顶层必须是包含 category 数组的对象" }),
        );
    }
    match write_config_file(&state.config_file, &body).await {
        Ok(()) => {
            state
                .live
                .broadcast("config-changed", json!({ "time": now_ms() }))
                .await;
            // 串口参数可能在本次保存中修改：异步应用（未启用/无端口时自动断开）
            serial::apply_config(&state.serial, &body).await;
            ok_json(json!({ "ok": true, "time": now_ms() }))
        }
        Err(e) => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("写入失败：{e}") }),
        ),
    }
}

/// POST /api/control —— 远程控制命令（广播或定向单台屏）。
pub async fn post_control(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let target = body
        .get("targetClientId")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    // 显示/隐藏侧边栏命令：仅携带 visible 布尔值
    if body.get("action").and_then(|v| v.as_str()) == Some("sidebar") {
        let msg = json!({
            "action": "sidebar",
            "visible": body.get("visible").and_then(|v| v.as_bool()).unwrap_or(false),
            "time": now_ms(),
        });
        let delivered = if !target.is_empty() {
            state.live.send_to(&target, "control", msg).await
        } else {
            state.live.broadcast("control", msg).await;
            true
        };
        return if delivered {
            ok_json(json!({ "ok": true, "time": now_ms() }))
        } else {
            json_resp(
                StatusCode::NOT_FOUND,
                json!({ "ok": false, "error": "目标客户端不存在或已离线" }),
            )
        };
    }

    let action = if body.get("action").and_then(|v| v.as_str()) == Some("product") {
        "product"
    } else {
        "category"
    };
    let category = body_int(&body, "category").unwrap_or(-1);
    let product = body_int(&body, "product").unwrap_or(-1);
    if category < 0 {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "category 必须是非负整数" }),
        );
    }
    let msg = json!({ "action": action, "category": category, "product": product, "time": now_ms() });
    let delivered = if !target.is_empty() {
        state.live.send_to(&target, "control", msg).await
    } else {
        state.live.broadcast("control", msg).await;
        true
    };
    if !delivered {
        return json_resp(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": "目标客户端不存在或已离线" }),
        );
    }
    ok_json(json!({ "ok": true, "time": now_ms() }))
}

/// 列出目录下扩展名符合白名单的文件名（排序）。目录不存在时返回 Err（调用方决定兜底）。
fn list_files(dir: &std::path::Path, allowed: &dyn Fn(&str) -> bool) -> std::io::Result<Vec<String>> {
    let entries = std::fs::read_dir(dir)?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.rsplit('.').next().map(allowed).unwrap_or(false))
        .collect();
    names.sort();
    Ok(names)
}

/// GET /api/models —— 列出 /Models/ 目录下模型文件（.fbx/.glb/.gltf）。
pub async fn get_models(State(state): State<Arc<AppState>>) -> Response {
    let models_dir = state.public_dir.join("Models");
    let allowed = |f: &str| {
        let ext = f.to_ascii_lowercase();
        matches!(ext.as_str(), "fbx" | "glb" | "gltf")
    };
    match list_files(&models_dir, &allowed) {
        Ok(names) => ok_json(json!({ "ok": true, "models": names })),
        Err(_) if !models_dir.exists() => ok_json(json!({ "ok": true, "models": [] })),
        Err(e) => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("读取模型目录失败：{e}") }),
        ),
    }
}

/// GET /api/files?kind=image|model&category=分类名 ——
/// 列出分类产品图片目录（products/<分类>/）或模型目录下的资源文件！
/// 与 /api/models 一致为只读接口，不校验管理令牌！！
pub async fn get_files(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {

    let kind = params.get("kind").map(|s| s.as_str()).unwrap_or("image");
    let (rel_dir, allowed): (PathBuf, &dyn Fn(&str) -> bool) = match kind {
        "model" => (
            PathBuf::from("Models"),
            &|f: &str| {
                let ext = f.to_ascii_lowercase();
                matches!(ext.as_str(), "fbx" | "glb" | "gltf")
            },
        ),
        "image" => {
            let cat = params.get("category").map(|s| s.trim()).unwrap_or("");
            if cat.is_empty() {
                return json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "ok": false, "error": "缺少 category 参数（分类名，对应 products/<分类>/ 目录）" }),
                );
            }
            // 与 upload 一致：拒绝目录穿越（/ 、\\ 、.. 一律不合法），分类名即一级子目录名
            if cat.contains('\\') || cat.contains('/') || cat.contains('\0') || cat.split('/').any(|s| s == "..") {
                return json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "ok": false, "error": "category 不合法" }),
                );
            }
            (
                PathBuf::from("products").join(cat),
                &|f: &str| {
                    let ext = f.to_ascii_lowercase();
                    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")
                },
            )
        }
        _ => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "kind 必须是 image 或 model" }),
            );
        }
    };
    let dir = state.public_dir.join(rel_dir.clone());
    match list_files(&dir, &allowed) {
        Ok(names) => ok_json(json!({
            "ok": true,
            "files": names,
            "dir": format!("/{}", rel_dir.display().to_string().replace('\\', "/")),
        })),
        Err(_) if !dir.exists() => ok_json(json!({
            "ok": true,
            "files": [],
            "dir": format!("/{}", rel_dir.display().to_string().replace('\\', "/")),
        })),
        Err(e) => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("读取目录失败：{e}") }),
        ),
    }
}

/// 资源扩展名白名单：image → 图片；model →  ３D 模型。
fn upload_ext_allowed(kind: &str, ext: &str) -> bool {
    match kind {
        "image" => matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg"),
        "model" => matches!(ext, "fbx" | "glb" | "gltf"),
        _ => false,
    }
}

/// 清理上传文件名：取最后一级（去掉路径前缀，防目录穿越），拒绝敏感字符。
/// 返回 None 表示不合法。
fn sanitize_file_name(raw: &str) -> Option<String> {
    let name = raw.replace('\\', "/");
    let stem = name.rsplit('/').next()?.trim();
    if stem.is_empty() || stem.contains('\0') || stem.contains("..") || stem.contains('/') {
        return None;
    }
    Some(stem.to_string())
}

/// POST /api/upload —— 上传产品图片 / 3D 模型到 public/ 对应目录。
/// multipart 表单字段：kind=image|model、category=<分类名>（图片必需）、file=<文件>。
/// 同名文件直接覆盖（原子写 tmp+rename）；成功后广播 config-changed 让展示屏立即刷新。

pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {

    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    // 1) 解析字段
    let mut kind = String::new();
    let mut category = String::new();
    let mut raw_name = String::new();
    let mut data: Vec<u8> = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                return json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({ "ok": false, "error": format!("解析上传表单失败：{e}") }),
                );
            }
        };
        match field.name() {
            Some("kind") => kind = field.text().await.unwrap_or_default().trim().to_string(),
            Some("category") => category = field.text().await.unwrap_or_default().trim().to_string(),
            Some("file") => {
                raw_name = field.file_name().unwrap_or_default().to_string();
                data = match field.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        return json_resp(
                            StatusCode::BAD_REQUEST,
                            json!({ "ok": false, "error": format!("读取文件失败：{e}") }),
                        );
                    }
                };
            }
            _ => {}
        }
    }
    // 2) 参数校验
    if !matches!(kind.as_str(), "image" | "model") {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "kind 必须是 image 或 model" }),
        );
    }
    if data.is_empty() {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "缺少文件（multipart file 字段为空）" }),
        );
    }
    let file_name = match sanitize_file_name(&raw_name) {
        Some(n) => n,
        None => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "文件名不合法（只能为文件本身的名字）" }),
            );
        }
    };
    let ext = file_name
        .rsplit('.').next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !upload_ext_allowed(&kind, &ext) {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": format!("{} 不支持 .{ext} 类型文件", if kind == "image" { "图片" } else { "3D 模型" }) }),
        );
    }
    // 3) 目标路径：图片 → products/<分类>/；模型 → Models/
    let rel_dir = if kind == "image" {
        if category.is_empty() {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "图片上传必须指定分类（category）" }),
            );
        }
        if category.contains('\\') || category.contains('/') || category.contains('\0') || category.split('/').any(|s| s == "..") {
            return json_resp(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "category 不合法" }),
            );
        }
        PathBuf::from("products").join(&category)
    } else {
        PathBuf::from("Models")
    };
    let dir = state.public_dir.join(rel_dir.clone());
    let full = dir.join(&file_name);
    // 防目录穿越兜底：最终路径必须仍在 public 根目录内
    if !full.starts_with(&state.public_dir) {
        return json_resp(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "路径不合法" }),
        );
    }
    // 4) 写入（先建目录 →→ 原子写 tmp+rename →→ 同名覆盖）
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("创建目录失败：{e}") }),
        );
    }
    let tmp = dir.join(format!(".{file_name}.upload-{}", Uuid::new_v4()));
    if let Err(e) = tokio::fs::write(&tmp, &data).await {
        return json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("写入失败：{e}") }),
        );
    }
    if let Err(e) = tokio::fs::rename(&tmp, &full).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": format!("保存失败：{e}") }),
        );
    }
    // 5) 广播：config-changed →→ 展示屏立即重拉配置并重建 CoverFlow / 刷新（图片/模型可能同名替换）
    state
        .live
        .broadcast("config-changed", json!({ "time": now_ms() }))
        .await;
    let rel_display = format!("/{}", full.strip_prefix(&state.public_dir).unwrap_or(&rel_dir).display().to_string().replace('\\', "/"));
    ok_json(json!({
        "ok": true,
        "kind": kind,
        "file": file_name,
        "path": rel_display,
        "time": now_ms(),
    }))
}

/// GET /api/local-ip —— 返回本机局域网 IPv4 地址列表。
pub async fn get_local_ip() -> Response {
    let ips: Vec<Value> = iputil::list_ipv4()
        .into_iter()
        .map(|i| json!({ "name": i.name, "address": i.address, "netmask": i.netmask }))
        .collect();
    ok_json(json!({ "ok": true, "ips": ips }))
}

/* ==================================================================
 * 串口 API（原生 serialport；字段结构对齐 lib/serial-bridge.cjs）
 * ================================================================== */

/// GET /api/serial/status
pub async fn serial_status(State(state): State<Arc<AppState>>) -> Response {
    ok_json(serial::status_json(&state.serial).await)
}

/// GET /api/serial/ports
pub async fn serial_ports() -> Response {
    let ports = serial::list_ports();
    ok_json(json!({ "ok": true, "ports": ports, "error": Value::Null }))
}

/// POST /api/serial/connect
pub async fn serial_connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    // 请求体带 serial 段则用请求体，否则读当前 config
    let cfg_val = if body.get("serial").is_some() {
        body
    } else {
        read_config_file(&state.config_file).unwrap_or(Value::Null)
    };
    ok_json(serial::connect_json(&state.serial, &cfg_val).await)
}

/// POST /api/serial/disconnect
pub async fn serial_disconnect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    ok_json(serial::disconnect_json(&state.serial).await)
}

/// POST /api/serial/send —— 发送原始内容（管理页测试发送）。
pub async fn serial_send(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = check_auth(&state, &headers) {
        return resp;
    }
    let data = body
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if data.is_empty() {
        return json_resp(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": "缺少 data 字段" }));
    }
    match serial::write_message(&state.serial, &data, false).await {
        Ok(()) => ok_json(json!({ "ok": true, "len": data.len(), "time": now_ms() })),
        Err(e) => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": e }),
        ),
    }
}

/// POST /api/serial/action —— 展示屏切换产品：按模板组装 action 并发送。
pub async fn serial_action(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let label = body
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let enabled = {
        let g = state.serial.lock().await;
        g.cfg.enabled
    };
    if !enabled {
        return ok_json(json!({ "ok": true, "skipped": true, "reason": "serial disabled" }));
    }

    let (tpl, action2, label2) = {
        let g = state.serial.lock().await;
        (g.cfg.template.clone(), action.clone(), label.clone())
    };
    let b = serial::build_serial_message(&tpl, &action2, &label2);
    let (payload, hex) = if b.hex_only {
        (b.hex_data.clone(), true)
    } else {
        (b.str_val.clone(), false)
    };
    match serial::write_message(&state.serial, &payload, hex).await {
        Ok(()) => {
            let len = if hex {
                b.hex_data
                    .split_whitespace()
                    .filter(|s| !s.is_empty())
                    .count()
            } else {
                serial::utf16_len(&b.str_val)
            };
            ok_json(json!({
                "ok": true,
                "action": action,
                "message": b.str_val,
                "len": len,
            }))
        }
        Err(e) => json_resp(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": e }),
        ),
    }
}
