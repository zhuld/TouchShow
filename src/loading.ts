import { gsap } from 'gsap';

/* ==================================================================
 * 加载画面 —— 页面打开时的资源读取进度提示
 * ------------------------------------------------------------------
 * 对应 index.html 中的 #loadingScreen（外部样式，页面打开立即显示）；
 * 所有图片 / 模型 / 材质读取到本地后调用 showEnterButton() 显示「进入」按钮，
 * 由用户手动点击进入主界面（触发页面切换动画）。
 * ================================================================== */

// 加载画面 Logo（logo.svg 和 name.svg 作为打包资源随构建进入 dist/assets，不依赖 public）
const LOGO_URL = new URL('./assets/logo.svg', import.meta.url).href;
const LOGO_Name_URL = new URL('./assets/name.svg', import.meta.url).href;

const bar = document.querySelector<HTMLElement>('#lsBarFill');
const text = document.querySelector<HTMLElement>('#lsText');
const enterBtn = document.querySelector<HTMLButtonElement>('#lsEnter');
const liquidBtnText = document.querySelector<HTMLElement>('#liquidButtonText');
const liquid = document.querySelector<HTMLElement>('#liquid');

// 自动进入倒计时定时器（每秒更新按钮上剩余秒数，归零后自动进入）
let enterTimer: number | undefined;

// 配置加载失败态：加载画面提示错误，「进入」按钮变为「重试」（整页重新加载）
let configError = false;

// 绑定「进入」按钮点击事件：触发页面切换动画（按钮默认隐藏，就绪后显示）；
// 配置加载失败态点击为「重试」——整页重新加载，重新走资源预加载与初始化流程
enterBtn?.addEventListener('click', () => {
    if (configError) {
        window.location.reload();
        return;
    }
    enterMain();
});

// 设置加载画面 Logo 图片地址（由 JS 注入 src，避免依赖外部 public 目录）
const logoImg = document.querySelector<HTMLImageElement>('.ls-logo img');
if (logoImg) logoImg.src = LOGO_URL;
const logoName = document.querySelector<HTMLImageElement>('.ls-name img');
if (logoName) logoName.src = LOGO_Name_URL;

// 页面切换动画使用 ✈ 图标（index.html 内联文本元素），点击「进入」后由动画驱动飞行

// ---- 加载画面显示本机局域网 IP（便于局域网内其他设备访问本机 /admin 管理页等） ----
const ipEl = document.querySelector<HTMLElement>('#lsIp');

function setIp(ip: string): void {
    if (ipEl) {
        // 端口取当前访问地址（window.location.port）：
        // 开发模式 5173 / express 与 Tauri 打包 3000 / 自定义 PORT 都能如实显示
        const port = window.location.port;
        ipEl.textContent = port ? `本机地址：${ip}:${port}` : `本机地址：${ip}`;
    }
}

/** WebRTC 兜底：收集本地 host 候选的 IPv4 地址（服务不可用时退回浏览器探测） */
function detectLocalIps(): Promise<string[]> {
    return new Promise((resolve) => {
        const ips = new Set<string>();
        let pc: RTCPeerConnection;
        let finished = false;
        const done = (): void => {
            if (finished) return;
            finished = true;
            try { pc.close(); } catch { /* ignore */ }
            resolve([...ips]);
        };
        try {
            pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('ip-probe');
            pc.onicecandidate = (e) => {
                const m = e.candidate?.candidate?.match(/(\d{1,3}\.){3}\d{1,3}/);
                if (m) ips.add(m[0]);
                if (!e.candidate) done();
            };
            pc.createOffer()
                .then((o) => pc.setLocalDescription(o))
                .catch(done);
            setTimeout(done, 1500); // 超时兜底
        } catch {
            done();
        }
    });
}

/** 获取本机局域网 IPv4：优先本地服务 /api/local-ip，失败退回 WebRTC 探测 */
async function showLocalIp(): Promise<void> {
    if (!ipEl) return;
    try {
        const res = await fetch('/api/local-ip', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            const ips: string[] = Array.isArray(data?.ips)
                ? data.ips.map((i: { address: string }) => i.address)
                : [];
            const primary = ips.find((ip) => !ip.startsWith('169.254')) || ips[0];
            if (primary) return setIp(primary);
        }
    } catch { /* 服务不可用，走 WebRTC 兜底 */ }

    const ips = await detectLocalIps();
    const primary = ips.find((ip) => !ip.startsWith('169.254')) || ips[0];
    if (primary) setIp(primary);
}

void showLocalIp();

/** 更新进度条与文字（loaded/total） */
export function updateLoading(loaded: number, total: number): void {
    if (bar) {
        const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        bar.style.width = `${pct}%`;
    }
    if (text) text.textContent = `正在读取资源 ${loaded}/${total}`;
}

/** 设置加载画面提示文字（如「正在加载 3D 模型…」） */
export function setLoadingText(msg: string): void {
    if (text) text.textContent = msg;
}

/** 配置加载失败：加载画面显示明确错误提示，「进入」按钮变为「重试」（整页重新加载） */
export function showConfigError(): void {
    configError = true;
    if (bar) bar.style.width = '0%';
    if (text) text.textContent = '配置加载失败：无法连接服务器，且本地配置文件不可用';
    if (enterBtn) {
        enterBtn.disabled = false;
        enterBtn.classList.add('show');
        if (liquidBtnText) liquidBtnText.textContent = '点击重试';
    }
}

/** 全部资源就绪：进度满格并显示「进入」按钮；30 秒倒计时结束自动进入 */
export function showEnterButton(): void {
    if (bar) bar.style.width = '100%';
    if (text) text.textContent = '资源加载完成';
    if (enterBtn) {
        enterBtn.disabled = false;
        enterBtn.classList.add('show');
        gsap.fromTo(
            enterBtn,
            { y: 14, scale: 0.92, autoAlpha: 0 },
            { y: 0, scale: 1, autoAlpha: 1, duration: 0.55, ease: 'power3.out' }
        );
        startAutoEnter(30);
    }
}

/** 启动自动进入倒计时：按钮上显示剩余秒数，倒数到 0 自动进入（手动进入由 enterMain 清除定时器） */
function startAutoEnter(total: number): void {
    const btn = enterBtn;
    if (!btn) return;
    let remain = total;
    const setText = (): void => {
        // 两位补零，保证按钮文字宽度恒定不抖动（30s→09s）
        if (liquidBtnText) {
            liquidBtnText.textContent = `进入展厅（${String(remain).padStart(2, '0')}s）`;
        }

    };
    setText();

    // 倒计时期间液体随剩余时间从 top:-170px 逐渐下移到 -60px（液体消退效果）
    if (liquid) {
        liquid.style.transition = 'none'; // 避免 CSS 0.5s 过渡干扰逐帧动画
        gsap.fromTo(
            liquid,
            { top: -170 },
            { top: -60, duration: total, ease: 'linear' }
        );
    }

    enterTimer = window.setInterval(() => {
        remain -= 1;
        if (remain > 0) {
            setText();
        } else {
            window.clearInterval(enterTimer);
            enterMain();
        }
    }, 1000);
}

/** 用户点击「进入」：执行切换动画（飞机从左往右飞过，把加载画面从左往右拉开） */
function enterMain(): void {
    // 手动进入时清除自动进入倒计时，避免后台继续运行
    if (enterTimer !== undefined) {
        window.clearInterval(enterTimer);
        enterTimer = undefined;
    }
    const el = document.querySelector<HTMLElement>('#loadingScreen');
    if (!el || el.classList.contains('ls-done')) return;
    const screen = el; // 闭包中捕获非空引用（TS 对窄化变量在回调里的推断会丢失）
    screen.classList.add('ls-done');

    const plane = document.getElementById('lsPlane');
    if (plane) plane.style.opacity = '1'; // 动画开始：飞机显示（独立 fixed 层，初始在屏幕左外）

    const SCREEN_TRAVEL = 200; // 加载画面额外右滑余量（px）：保证完全滑出屏幕
    const planeWidth = plane ? plane.offsetWidth : 80; // 飞机元素宽度（机头顶画面左缘用）
    const travel = window.innerWidth + SCREEN_TRAVEL;
    gsap.to(screen, {
        x: travel,
        duration: 2.5,
        ease: 'power3.out',
        onComplete: () => {
            screen.remove();
            plane?.remove();
        },
    });
    if (plane) {
        gsap.to(plane, {
            x: travel - planeWidth,
            yPercent: -50,
            duration: 2.5,
            ease: 'power3.out',
        });
    }
}
