/* ==================================================================
 * 部署基础路径 —— 运行时资源地址统一拼接 BASE_URL
 * ------------------------------------------------------------------
 * 前端可部署在不同基础路径下：
 *   - 默认构建（EXE / Tauri / 本地后端）：BASE_URL = '/'，行为不变；
 *   - GitHub Pages 项目站点（build:pages）：BASE_URL = '/TouchShow/'，
 *     config.json / Models / products / icons 等以 '/' 开头的运行时
 *     资源路径会自动加上基础路径前缀，避免解析到域名根路径 404。
 * ================================================================== */

/** 基础路径（末尾统一去掉斜杠，便于拼接；根部署时为空串） */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/**
 * 为以 '/' 开头的应用内资源路径拼接部署基础路径：
 *  - 空值 / 相对路径 / 绝对地址（http:、https:、//）原样返回；
 *  - 其余（'/config.json'、'/Models/x.glb'、'/products/...' 等）拼上 BASE。
 */
export function withBase(path: string): string {
    if (!path || !path.startsWith('/') || /^(https?:)?\/\//i.test(path)) return path;
    return BASE + path;
}
