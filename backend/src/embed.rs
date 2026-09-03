//! 编译期内嵌的前端构建产物（dist/）。
//!
//! 仅当后端 crate 编译时项目根存在 `dist/` 才启用（见 build.rs 的 `embed_dist` cfg）。
//! 打包发布时前端（dist）随 Rust 服务一并内嵌进 exe，exe 旁无需 dist 目录，
//! 内容在编译时固化、无法被外部修改/替换（public/ 仍为外部可替换资源）。

#[cfg(embed_dist)]
use include_dir::{include_dir, Dir};

/// 内嵌的 dist 目录树（仅 `embed_dist` 编译时存在）。
#[cfg(embed_dist)]
static DIST: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../dist");

/// 是否启用了内嵌 dist。
pub fn enabled() -> bool {
    cfg!(embed_dist)
}

/// 读取内嵌 dist 中的文件字节；目录路径（结尾 `/`）→ index.html；未找到返回 None。
/// `rel` 为去掉前导 `/` 的相对路径（调用方已做目录穿越净化）。
#[cfg(embed_dist)]
pub fn get(rel: &str) -> Option<&'static [u8]> {
    let rel = if rel.is_empty() || rel.ends_with('/') {
        format!("{rel}index.html")
    } else {
        rel.to_string()
    };
    DIST.get_file(&rel).map(|f| f.contents())
}

#[cfg(not(embed_dist))]
pub fn get(_rel: &str) -> Option<&'static [u8]> {
    None
}

#[cfg(all(test, embed_dist))]
mod tests {
    #[test]
    fn embedded_dist_contains_pages() {
        // 相对根目录默认索引
        let idx = super::get("").expect("index.html 应在内嵌 dist 中");
        let s = String::from_utf8_lossy(idx);
        assert!(s.contains("TouchShow"), "index.html 应包含 TouchShow 标记");
        assert!(
            super::get("index.html").is_some(),
            "index.html 显式路径也应可读"
        );
        assert!(
            super::get("admin.html").is_some(),
            "admin.html 应在内嵌 dist 中"
        );
        assert!(
            super::get("404.html").is_some(),
            "404.html 应在内嵌 dist 中"
        );
    }
}
