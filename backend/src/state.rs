//! 全局共享状态。

use std::path::PathBuf;

use crate::live::Live;
use crate::serial::SerialManager;

/// 前端构建产物（dist）的来源。
pub enum DistSource {
    /// 编译期内嵌于可执行文件（打包发布形态；内容不可被外部修改/替换）
    Embedded,
    /// 外部目录（设置了 TOUCHSHOW_DIST，或编译时未内嵌时的开发回退）
    Folder(PathBuf),
}

/// 服务共享状态：目录解析、管理令牌、实时通道与串口管理器。
pub struct AppState {
    /// 外部可修改资源目录（产品图 / 3D 模型 / config.json），env TOUCHSHOW_PUBLIC 优先
    pub public_dir: PathBuf,
    /// 前端构建产物（dist）来源：内嵌 或 外部目录
    pub dist: DistSource,
    /// config.json 完整路径（位于 public_dir 下）
    pub config_file: PathBuf,
    /// 管理令牌（env ADMIN_TOKEN，缺省 11223344）
    pub token: String,
    /// WebSocket 实时通道（config-changed / control / clients）
    pub live: Live,
    /// 串口管理器（原生 serialport）
    pub serial: SerialManager,
}

