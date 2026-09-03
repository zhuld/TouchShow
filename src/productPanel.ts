import type { Product } from './config';
import { gsap } from 'gsap';

/* ==================================================================
 * 产品信息框 —— 3D 模型模式下屏幕左侧展示当前产品（上介绍 / 下图片）
 * ------------------------------------------------------------------
 * - 仅 3D 模型模式使用：点击二级产品时显示该产品介绍 + 图片
 * - 高度撑满顶部栏下方的内容区，宽度由样式表控制
 * - 出现从左侧滑入、关闭向左滑出；**切换产品时先向左滑出关闭 → 换内容 → 再向右滑入**
 * - 无选中产品 / 图片模式 / 取消选中时隐藏
 * ================================================================== */

let panel: HTMLElement | null = null;
let panelLabel: HTMLElement | null = null;
let panelDesc: HTMLElement | null = null;
let panelImg: HTMLImageElement | null = null;
// 面板动画状态机：open(已滑入) / closing(向左滑出中) / closed(已隐藏)
let panelState: 'open' | 'closing' | 'closed' = 'closed';
let currentLabel: string | null = null; // 当前展示的产品名
let pendingProd: Product | null = null; // 滑出期间待展示的最新产品
let panelTween: gsap.core.Tween | null = null;

/** 创建产品信息框 DOM（幂等，重复调用直接复用已有元素） */
export function createProductPanel(): void {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'productPanel';
    panel.innerHTML = `
        <div class="pp-left">
            <h2 class="pp-label"></h2>
            <p class="pp-desc"></p>
        </div>
        <div class="pp-right">
            <img class="pp-img" alt="" draggable="false" />
        </div>
    `;
    panelLabel = panel.querySelector<HTMLElement>('.pp-label');
    panelDesc = panel.querySelector<HTMLElement>('.pp-desc');
    panelImg = panel.querySelector<HTMLImageElement>('.pp-img');
    document.body.appendChild(panel);
    gsap.set(panel, { xPercent: -105, autoAlpha: 0 });
}

/** 将描述文本拆成多行，每行行首加飞机符号（仅按换行符 \n 分行） */
function formatDesc(text: string): string {
    const lines = (text || '').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
    return lines.length ? lines.map((l) => '✈ ' + l).join('\n') : text;
}

/** 把产品内容填充进面板 */
function applyProd(prod: Product): void {
    if (!panelLabel || !panelDesc || !panelImg) return;
    panelLabel.textContent = prod.label;
    panelDesc.textContent = formatDesc(prod.description || '');
    panelImg.src = prod.image;
    panelImg.alt = prod.label;
    currentLabel = prod.label;
}

/** 向右滑入显示面板 */
function openPanel(): void {
    if (!panel) return;
    panel.classList.add('visible');
    panelTween?.kill();
    panelTween = gsap.to(panel, {
        xPercent: 0,
        autoAlpha: 1,
        duration: 0.45,
        ease: 'back.out',
        onComplete: () => { panelTween = null; },
    });
    panelState = 'open';
}

/**
 * 显示产品信息框并填充指定产品内容（介绍 / 图片）。
 * 若面板已打开且切换不同产品：先向左滑出关闭，动画结束后换上新产品再向右滑入。
 */
export function showProductPanel(prod: Product): void {
    createProductPanel();
    if (!panel || !panelDesc || !panelImg) return;

    // 内容未变且面板已打开：无需重新播放动画
    if (panelState === 'open' && prod.label === currentLabel) return;

    pendingProd = prod;
    if (panelState === 'open') {
        // 已打开 → 先向左滑出关闭，动画结束后换上最新产品再向右滑入
        panelState = 'closing';
        panel.classList.remove('visible');
        panelTween?.kill();
        panelTween = gsap.to(panel, {
            xPercent: -105,
            autoAlpha: 0,
            duration: 0.45,
            ease: 'power3.in',
            onComplete: () => {
                if (pendingProd) applyProd(pendingProd);
                openPanel();
            },
        });
    } else if (panelState === 'closing') {
        // 滑出动画进行中：pendingProd 已更新，等待滑出完成后显示最新产品
    } else {
        // 面板未打开：直接填充内容并向右滑入
        applyProd(prod);
        openPanel();
    }
}

/** 隐藏产品信息框（无选中产品 / 图片模式 / 取消选中时调用） */
export function hideProductPanel(): void {
    if (!panel) return;
    pendingProd = null;
    currentLabel = null;
    panelState = 'closed';
    panel.classList.remove('visible');
    panelTween?.kill();
    panelTween = gsap.to(panel, {
        xPercent: -105,
        autoAlpha: 0,
        duration: 0.45,
        ease: 'power3.in',
        onComplete: () => { panelTween = null; },
    });
}
