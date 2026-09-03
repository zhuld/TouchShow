//! 编译期配置：当前端构建产物（项目根 dist/）存在时启用内嵌（embed_dist cfg），
//! 使后端 crate 把 dist 一并编译进可执行文件（打包发布无需在 exe 旁放 dist 目录，
//! 也无法被外部修改/替换）。

fn main() {
    // 声明自定义 cfg，避免 unexpected_cfgs 告警（无论是否启用都声明）
    println!("cargo:rustc-check-cfg=cfg(embed_dist)");

    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if dist.is_dir() {
        println!("cargo:rustc-cfg=embed_dist");
        // npm run build 更新 dist 内容时触发 build.rs 重跑 / 重编译，保证内嵌为最新前端
        println!("cargo:rerun-if-changed={}", dist.display());
    }
}
