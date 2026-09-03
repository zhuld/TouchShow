/* ==================================================================
 * 串口发送模块 —— 切换产品时把 product.action 发送到指定串口
 * ------------------------------------------------------------------
 * 串口参数来自 config.json 的 serial 段（可在管理页 /admin 远程设置）。
 * 实际串口读写由 Rust 后端（backend/，原生 serialport crate）完成，
 * 本模块只负责把 action 通过 POST /api/serial/action 交给服务端，
 * 服务端按模板（serial.template）组装报文后写入串口。
 * ================================================================== */
import { getConfig, onConfigChange, readSerialConfig } from './config.js';
import type { SerialConfig } from './config.js';

let serial: SerialConfig = readSerialConfig(getConfig());

/** 初始化：读取当前串口配置并跟随远程配置实时更新 */
export function initSerialSync(): void {
    serial = readSerialConfig(getConfig());
    onConfigChange((cfg) => {
        serial = readSerialConfig(cfg);
    });
}

/**
 * 产品切换时发送 action 内容到服务端串口。
 * 仅当 config.json 的 serial.enabled 为 true 且 action 非空时发送；
 * 失败仅告警，不阻塞展示流程。
 */
export async function sendProductAction(action: string, label: string): Promise<void> {
    if (!serial.enabled || !action) return;
    try {
        const res = await fetch('/api/serial/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, label: label || '' }),
        });
        if (!res.ok) {
            const data = (await res.json().catch(() => null)) as { error?: string } | null;
            console.warn('[serial] 发送失败：', data?.error || ('HTTP ' + res.status));
        }
    } catch (e) {
        console.warn('[serial] 发送动作失败：', e);
    }
}
