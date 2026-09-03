//! 静态资源服务与 404 回退。
//!
//! 解析顺序：外部 public 目录优先；其次 dist —— dist 可能「编译期内嵌于 exe」
//! （DistSource::Embedded，内容不可改），也可能是外部目录（DistSource::Folder，
//! 用于设置了 TOUCHSHOW_DIST 或编译时未内嵌的开发/测试场景）。
//! /admin 别名 → dist/admin.html；未匹配到的 GET/HEAD 统一返回 404（用 dist/404.html 页面）。

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use percent_encoding::percent_decode_str;

use crate::state::{AppState, DistSource};

/// 依据扩展名给出 Content-Type（text/* 附 charset=utf-8，对齐 express）。
fn content_type(rel: &str) -> String {
    let guess = mime_guess::from_path(rel).first_or_octet_stream();
    let mut ct = guess.to_string();
    if guess.type_() == mime_guess::mime::TEXT {
        ct.push_str("; charset=utf-8");
    }
    ct
}

fn build(head: bool, status: StatusCode, ct: &str, body: Vec<u8>) -> Response {
    let len = body.len();
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ct);
    if head {
        b = b.header(header::CONTENT_LENGTH, len.to_string());
        return b.body(Body::empty()).unwrap();
    }
    b.body(Body::from(body)).unwrap()
}

fn text_404() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from("404 Not Found"))
        .unwrap()
}

/// 动态内容（产品图片 / 3D 模型可能被远程上传同名替换）加 Cache-Control: no-cache，
/// 让浏览器每次加载都向服务器重新校验，替换文件后无需清缓存也能即时看到新内容。
fn with_no_cache(resp: Response, on: bool) -> Response {
    if !on {
        return resp;
    }
    let (mut parts, body) = resp.into_parts();
    parts.headers.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    Response::from_parts(parts, body)
}

/// 规范化 URL 路径为站内相对文件路径：目录（/ 结尾）→ index.html；
/// 含目录穿越/反斜杠/NUL 时返回 None（调用方据此 404）。
fn normalize_rel(path: &str) -> Option<String> {
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() || rel.ends_with('/') {
        format!("{rel}index.html")
    } else {
        rel.to_string()
    };
    if rel.split('/').any(|seg| seg == "..") || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    Some(rel)
}

/// 在某个外部根目录下按 URL 路径找文件并返回；找不到返回 None。
async fn try_serve_file(root: &Path, path: &str, head: bool) -> Option<Response> {
    let rel = normalize_rel(path)?;
    let full = root.join(&rel);
    let meta = tokio::fs::metadata(&full).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = tokio::fs::read(&full).await.ok()?;
    let ct = content_type(&rel);
    Some(build(head, StatusCode::OK, &ct, bytes))
}

/// 从内嵌 dist 中按 URL 路径取文件；找不到返回 None。
fn try_serve_embedded(path: &str, head: bool) -> Option<Response> {
    let rel = normalize_rel(path)?;
    let bytes = crate::embed::get(&rel)?;
    let ct = content_type(&rel);
    Some(build(head, StatusCode::OK, &ct, bytes.to_vec()))
}

/// 按 dist 来源（内嵌或外部目录）尝试取文件。
async fn try_serve_dist(state: &AppState, path: &str, head: bool) -> Option<Response> {
    match &state.dist {
        DistSource::Folder(dir) => try_serve_file(dir, path, head).await,
        DistSource::Embedded => try_serve_embedded(path, head),
    }
}

/// 路由未匹配的兜底处理器（静态文件 / /admin / 404 页）。
pub async fn static_fallback(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return text_404();
    }
    let head = method == Method::HEAD;
    let path = req.uri().path().to_string();

    // 百分号解码（中文路径等），失败直接 404
    let decoded = match percent_decode_str(&path).decode_utf8() {
        Ok(d) => d.into_owned(),
        Err(_) => return text_404(),
    };
    // 拒绝异常路径
    if decoded.contains('\\') || decoded.contains('\0') || decoded.split('/').any(|s| s == "..") {
        return text_404();
    }

    // 1) 外部 public 优先（产品图 / 3D 模型为可变资源：加 no-cache，保证同名替换后即时生效）
    let is_live_asset = decoded.starts_with("/products/") || decoded.starts_with("/Models/");
    if let Some(resp) = try_serve_file(&state.public_dir, &decoded, head).await {
        return with_no_cache(resp, is_live_asset);
    }
    // 2) dist（内嵌 或 外部目录）
    if let Some(resp) = try_serve_dist(&state, &decoded, head).await {
        return resp;
    }
    // /admin 别名（dist/admin.html 是构建入口，真实文件在 dist）
    if decoded == "/admin" {
        if let Some(resp) = try_serve_dist(&state, "/admin.html", head).await {
            return resp;
        }
    }
    // 3) 其余未知路径 → 404 页（HTTP 404）
    if let Some(resp) = try_serve_dist(&state, "/404.html", head).await {
        let (mut parts, body) = resp.into_parts();
        parts.status = StatusCode::NOT_FOUND;
        return Response::from_parts(parts, body);
    }
    text_404()
}

