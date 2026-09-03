/* ==================================================================
 * 配置模块 —— config.json 的统一加载与实时同步（远程配置）
 * ------------------------------------------------------------------
 * 展示屏幕启动后通过本模块：
 *   1. 从服务器拉取最新配置（/api/config，服务器不可用时退回 /config.json）
 *   2. 建立 SSE 连接（/api/config/events），服务端保存配置后实时推送
 *   3. 通过 onConfigChange() 订阅变更，驱动侧边栏 / CoverFlow 即时刷新
 * ================================================================== */

export interface Product {
    label: string;
    action: string;
    description: string;
    image: string;
    /** 可选：3D 模型中对应物体名（3D 模式下点击产品时高亮该物体并转到其视角） */
    object?: string;
    /** 可选：观看该产品物体时模型水平旋转角度（度，绕 Y 轴，缺省 0 = 不旋转） */
    rotate?: number;
}

export interface Category {
    label: string;
    icon: string;
    description: string;
    /** 可选：分类资源目录名（public/products/<dir>/，上传与图片快选均使用该目录）。
     *  缺省回退 label；分类名含特殊字符时建议显式设置安全的目录名。 */
    dir?: string;
    product: Product[];
}

/** 串口配置（config.json 顶层 serial 段，可在管理页远程设置） */
export interface SerialConfig {
    enabled: boolean;
    port: string;
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: string;
    template: string;
}

export interface Config {
    category: Category[];
    serial?: SerialConfig;
    /** 3D 模型文件名（位于 /Models/ 目录，可在管理页远程修改） */
    model?: string;
    /** 展示模式："image" 图片模式（CoverFlow 轮播）/ "model" 3D 模型模式（隐藏 CoverFlow，仅展示模型） */
    displayMode?: string;
}

/** 串口配置缺省值（config.json 未配置 serial 段时使用） */
export const DEFAULT_SERIAL: SerialConfig = {
    enabled: false,
    port: '',
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    template: '{action}\r\n',
};

/** 默认 3D 模型文件名（config.json 未配置 model 字段时使用） */
export const DEFAULT_MODEL = 'C919.glb';

/** 从配置中读取 3D 模型文件名（缺失/空白时回退默认值） */
export function readModelName(cfg: Config): string {
    return typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : DEFAULT_MODEL;
}

/** 展示模式白名单：image 图片模式（CoverFlow 轮播）/ model 3D 模型模式（隐藏 CoverFlow，仅展示模型） */
export const DISPLAY_MODES = ['image', 'model'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** 远程控制命令（管理页「远程控制」标签页发送，经 SSE 广播到所有展示屏，不写入 config.json） */
export interface RemoteCommand {
    /** 动作类型：'category' 仅切换分类 / 'product' 切换并选中具体产品 / 'sidebar' 显示或隐藏侧边栏 */
    action: 'category' | 'product' | 'sidebar';
    /** 分类下标（config.json 中 category 数组索引，sidebar 命令忽略） */
    category: number;
    /** 产品下标（action 为 'product' 时有效） */
    product?: number;
    /** 侧边栏显示状态（action 为 'sidebar' 时有效） */
    visible?: boolean;
}

/** 默认展示模式（config.json 未配置 displayMode 字段时使用，保持向后兼容） */
export const DEFAULT_DISPLAY_MODE: DisplayMode = 'image';

/** 从配置中读取展示模式（缺失/非法值回退默认图片模式） */
export function readDisplayMode(cfg: Config): DisplayMode {
    const m = cfg.displayMode;
    return DISPLAY_MODES.includes(m as DisplayMode) ? (m as DisplayMode) : DEFAULT_DISPLAY_MODE;
}

/** 当前生效的 3D 模型完整地址（固定目录 /Models/ + 远程配置的文件名） */
export function getModelUrl(): string {
    return `/Models/${encodeURIComponent(readModelName(current))}`;
}

/** 从配置中规整串口参数（容错：缺失/非法值回退到缺省值） */
export function readSerialConfig(cfg: Config): SerialConfig {
    const s = cfg.serial;
    if (!s || typeof s !== 'object') return { ...DEFAULT_SERIAL };
    return {
        enabled: !!s.enabled,
        port: typeof s.port === 'string' ? s.port : '',
        baudRate: Number(s.baudRate) > 0 ? Number(s.baudRate) : DEFAULT_SERIAL.baudRate,
        dataBits: Number(s.dataBits) >= 5 && Number(s.dataBits) <= 8 ? Number(s.dataBits) : DEFAULT_SERIAL.dataBits,
        stopBits: Number(s.stopBits) > 0 ? Number(s.stopBits) : DEFAULT_SERIAL.stopBits,
        parity: typeof s.parity === 'string' ? s.parity : DEFAULT_SERIAL.parity,
        template: typeof s.template === 'string' && s.template ? s.template : DEFAULT_SERIAL.template,
    };
}

/** 优先服务器 API（支持实时同步）；服务器不可用时退回静态 config.json */
const CONFIG_URLS = ['/api/config', '/config.json'];

let current: Config = { category: [] }; // 当前生效配置（内存副本）
let snapshot = ''; // 上次通知时的 JSON 快照，用于检测内容是否真正变化
let initialized = false; // 是否已完成首次加载（首次加载总是触发通知）
// 最近一次 fetchConfig 的加载错误（两个数据源都不可用时非 null，成功后清空）
let loadError: string | null = null;

const listeners = new Set<(cfg: Config) => void>();

// 远程控制命令订阅（管理页「远程控制」一键切换展示屏显示内容，与配置变更无关）
const remoteListeners = new Set<(cmd: RemoteCommand) => void>();

export function getConfig(): Config {
    return current;
}

/** 订阅远程控制命令（管理页远程切换分类/产品显示），返回取消订阅函数 */
export function onRemoteControl(fn: (cmd: RemoteCommand) => void): () => void {
    remoteListeners.add(fn);
    return () => {
        remoteListeners.delete(fn);
    };
}

function emitRemote(data: unknown): void {
    const cmd = data as RemoteCommand;
    if (!cmd || typeof cmd !== 'object') return;
    // sidebar 命令只携带 visible 布尔值；category/product 命令需要非负整数分类下标
    if (cmd.action === 'sidebar') {
        if (typeof cmd.visible !== 'boolean') return;
    } else if (!Number.isInteger(cmd.category)) {
        return;
    }
    remoteListeners.forEach((fn) => {
        try {
            fn(cmd);
        } catch (e) {
            console.error('[config] 远程控制回调执行失败：', e);
        }
    });
}

/** 配置加载错误信息：两个数据源均不可用时记录，用于首次加载时在页面明确提示（成功后清空） */
export function getConfigLoadError(): string | null {
    return loadError;
}

/** 从服务器拉取最新配置并更新内存；两个数据源均不可用时记录错误并返回当前配置（由调用方决定提示） */
export async function fetchConfig(): Promise<Config> {
    let lastError: unknown = null;
    for (const url of CONFIG_URLS) {
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) {
                current = (await res.json()) as Config;
                loadError = null;
                return current;
            }
            lastError = new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastError = e;
            // 尝试下一个源
        }
    }
    loadError = '无法连接服务器，且本地配置文件不可用';
    console.error('[config] 加载失败：服务器 API 与静态 config.json 均不可用', lastError);
    return current;
}

/** 订阅配置变更（实时推送或轮询发现后触发），返回取消订阅函数 */
export function onConfigChange(fn: (cfg: Config) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

function emit(): void {
    listeners.forEach((fn) => {
        try {
            fn(current);
        } catch (e) {
            console.error('[config] 变更回调执行失败：', e);
        }
    });
}

/** 拉取最新配置，仅在内容真正变化时触发通知（首次加载总是通知） */
async function refresh(): Promise<void> {
    const before = snapshot;
    await fetchConfig();
    const after = JSON.stringify(current);
    const changed = after !== before;
    console.log(`[config] refresh: before=${before.length}B after=${after.length}B changed=${changed} initialized=${initialized}`);
    if (!initialized || changed) {
        initialized = true;
        snapshot = after;
        emit();
    }
}

// 当前实时通道连接（供 sendLive 向服务端发消息，如展示屏上报当前展示状态）
let liveSocket: WebSocket | null = null;

/** 通过实时通道向服务端发送一条消息（如 screen-status）；未连接时静默忽略 */
export function sendLive(type: string, data: unknown): void {
    if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
        try {
            liveSocket.send(JSON.stringify({ type, data }));
        } catch (e) {
            console.warn('[config] 实时通道发送失败：', e);
        }
    }
}

/** 构造实时通道 WebSocket 地址：同源 /api/ws，展示屏固定 role=screen；
 *  URL 携带 ?name= 时透传作为屏名（管理页「客户端」列表展示用） */
function buildLiveUrl(role: 'screen' | 'admin'): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ role });
    const name = new URLSearchParams(location.search).get('name');
    if (name) params.set('name', name);
    return `${proto}//${location.host}/api/ws?${params.toString()}`;
}

/**
 * 启动实时同步：
 *  - 立即加载一次配置
 *  - WebSocket（/api/ws）双向通道：服务端推送 config-changed（配置变更刷新）
 *    与 control（管理页远程控制）到展示屏；断线指数退避自动重连
 *  - 兜底轮询（5s），WS 失效时也能收到更新
 *  - 页面重新可见时立即刷新
 */
export function startConfigSync(): () => void {
    void refresh();

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let wasDown = false; // 是否曾处于断线状态（重连成功后立即补拉，避免错过断线期间的推送）
    // WS 断线重连：指数退避（1s → 2s → 4s … 封顶 30s），连接成功即重置。
    // 避免后端短暂不可用 / 网络抖动时固定 3s 高频重连，减少错误刷屏与无效请求。
    let retryDelay = 1000;

    const connect = () => {
        if (disposed) return;
        // 清理可能残留的重连定时器，确保同一时刻只有一条重连链路
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        try {
            ws?.close();
        } catch { /* ignore */ }
        ws = new WebSocket(buildLiveUrl('screen'));
        liveSocket = ws;
        ws.onopen = () => {
            console.log('[config] 实时通道已连接');
            retryDelay = 1000; // 连接成功，重置退避
            // 断线期间可能错过推送：重连成功后立即补拉一次，无需等轮询兜底
            if (wasDown) {
                wasDown = false;
                void refresh();
            }
        };
        ws.onmessage = (ev) => {
            let msg: { type?: string; data?: unknown } | null = null;
            try {
                msg = JSON.parse(String(ev.data));
            } catch { /* ignore */ }
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'config-changed') {
                console.log('[config] 实时收到 config-changed，触发刷新');
                void refresh();
            } else if (msg.type === 'control') {
                // 远程控制命令（管理页「远程控制」切换分类/产品/侧边栏）
                emitRemote(msg.data);
            }
        };
        ws.onclose = () => {
            console.warn('[config] 实时通道断开，准备重连');
            wasDown = true;
            try {
                ws?.close();
            } catch { /* ignore */ }
            ws = null;
            liveSocket = null;
            if (disposed) return;
            reconnectTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
        };
        ws.onerror = () => {
            // onerror 后通常触发 onclose；主动关闭以进入统一重连逻辑
            try {
                ws?.close();
            } catch { /* ignore */ }
        };
    };
    connect();

    // 兜底轮询：即使 WS 失效也能发现配置变化（5s 间隔，保证修改后尽快生效）
    const pollTimer = setInterval(() => {
        void refresh();
    }, 5_000);

    // 页面重新可见时立即刷新
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void refresh();
    });

    // 清理（热重载 / 卸载场景）
    return () => {
        disposed = true;
        clearInterval(pollTimer);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try {
            ws?.close();
        } catch { /* ignore */ }
        liveSocket = null;
    };
}
