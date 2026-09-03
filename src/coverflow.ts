import { initSerialSync, sendProductAction } from './serial.js';
import { gsap } from 'gsap';
// 产品 / 分类类型统一来自 config.ts（避免本地重复定义造成字段漂移）
import type { Category } from './config.js';
import { resetActiveProduct, setActiveProduct } from './uiStore.js';

/* ==================================================================
 * Cover Flow 3D 产品展示
 * ------------------------------------------------------------------
 * 以 3D 空间排布产品卡片：中央为主卡，两侧卡片依次后移、旋转并缩小。
 * GSAP 负责切换补间，手写索引回绕保证无限循环。
 * ================================================================== */

// 自动翻页：打开产品卡片页后，60s 无手动翻页即进入自动翻页模式
const AUTO_IDLE_MS = 60000; // 无手动翻页多久后进入自动翻页（毫秒）
const AUTO_STEP_MS = 10000;  // 自动翻页每步间隔（毫秒）

const CENTER_GAP = 340;
const STACK_SPACING = 140;
const ROTATION = 50;
const Z_FAR = -200;

let container: HTMLElement | null = null;
let wrapper: HTMLElement | null = null;
let catDescEl: HTMLElement | null = null;
let cards: HTMLElement[] = [];
let bases: number[] = [];
let productCount = 0;
let plan: number[] = [];
let activeCategory: Category | null = null; // 当前展示的分类（用于取激活产品对象）
let activeProductIdx = -1; // 当前激活产品下标（变化时触发串口发送）
// 中央产品变化的唯一出口是 uiStore（setActiveProduct），侧边栏据此同步二级菜单选中态
let animationTween: gsap.core.Tween | null = null;

let catTypeTimer: ReturnType<typeof setInterval> | null = null;

/** 停止当前打字机动画并移除光标 */
function clearCatType(): void {
    if (catTypeTimer) { clearInterval(catTypeTimer); catTypeTimer = null; }
    if (catDescEl) catDescEl.classList.remove('typing');
}

/** 以打字机效果逐字显示类别说明 */
function typeCatDesc(text: string): void {
    clearCatType();
    if (!catDescEl) return;
    catDescEl.textContent = '';
    if (!text) return;

    catDescEl.classList.add('typing');
    let i = 0;
    catTypeTimer = setInterval(() => {
        i++;
        catDescEl!.textContent = text.slice(0, i);
        if (i >= text.length) {
            clearCatType();
        }
    }, 15);
}

// 自动翻页模式状态
let autoMode = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let autoInterval: ReturnType<typeof setInterval> | null = null;
let targetIndex = 0;
let animIndex = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartIndex = 0;
let dragDelta = 0;

export function createCoverFlow(): void {
    // 读取当前串口配置并跟随远程配置实时更新（切换产品时发送 action 到串口）
    initSerialSync();

    container = document.createElement('div');
    container.id = 'coverflow';
    container.className = 'cf-hidden';

    wrapper = document.createElement('div');
    wrapper.id = 'cf-wrapper';
    container.appendChild(wrapper);

    catDescEl = document.createElement('div');
    catDescEl.className = 'cf-catdesc';
    container.appendChild(catDescEl);

    container.addEventListener('mousedown', onDragStart);
    container.addEventListener('touchstart', onDragStart, { passive: false });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);
    container.addEventListener('wheel', onWheel, { passive: false });

    document.body.appendChild(container);
}


export function showCoverFlow(category: Category, startIndex = 0, updateDescription = true): void {
    if (!container || !wrapper) return;
    const previousDescription = updateDescription ? '' : (catDescEl?.textContent || '');

    // 同一分类内切换产品时保留现有卡片，沿最短路径平滑翻页，避免重建后瞬移。
    if (activeCategory?.label === category.label && productCount > 1 && cards.length > 0) {
        const index = Math.min(Math.max(0, Math.floor(startIndex) || 0), productCount - 1);
        let offset = index - animIndex;
        if (productCount === 2) {
            const candidates = bases
                .map((base, cardIndex) => ({ cardIndex, distance: Math.abs(base - animIndex), base }))
                .filter((item) => plan[item.cardIndex] === index)
                .sort((a, b) => a.distance - b.distance);
            const nearest = candidates[0];
            if (nearest) offset = nearest.base - animIndex;
        } else {
            offset -= productCount * Math.round(offset / productCount);
        }
        onManualInteraction();
        targetIndex = animIndex + offset;
        if (updateDescription) {
            typeCatDesc('\u3000\u3000' + category.description.replace(/\n/g, '\n\u3000\u3000'));
        }
        container.classList.remove('cf-hidden');
        animateToTarget();
        return;
    }

    hideCoverFlow();

    const products = category.product;
    productCount = products.length;
    const start = Math.min(Math.max(0, Math.floor(startIndex) || 0), Math.max(0, productCount - 1));
    targetIndex = start;
    animIndex = start;
    activeCategory = category;
    // 初始即定位到 start：首帧不产生“产品变化”事件，避免分类级切换误把首项当“选中”。
    // （旧实现置 -1 触发首帧事件，再用侧边栏 suppressProductSync 标志压制——已由 uiStore silent 取代）
    activeProductIdx = start;
    setActiveProduct(category.label, start, true); // silent：只落库，不通知侧边栏
    cards = [];
    bases = [];
    plan = productCount === 2 ? [0, 1, 0, 1] : products.map((_, i) => i);
    const initBase = productCount === 2 ? [-2, -1, 0, 1] : products.map((_, i) => i);
    wrapper.innerHTML = '';

    plan.forEach((productIndex, index) => {
        const prod = products[productIndex];
        if (!prod) return;

        const card = document.createElement('div');
        card.className = 'cf-card';
        bases.push(initBase[index]);
        card.addEventListener('click', (event) => {
            onManualInteraction();
            if (isDragging) return;
            let offset = bases[index] - animIndex;
            if (productCount > 2) {
                offset -= productCount * Math.round(offset / productCount);
            }
            if (Math.abs(offset) >= 0.5) {
                event.stopPropagation();
                targetIndex = productCount === 2 ? bases[index] : animIndex + offset;
                animateToTarget();
            }
        });

        const img = document.createElement('img');
        img.draggable = false;
        // config.json 中图片路径为 /products/... 绝对路径（public 资源）
        img.src = prod.image;
        img.alt = prod.label;
        // 卡片带 3D 变换时懒加载视口判定会失效（图片永不加载），且图片已在加载画面预加载进缓存，故用 eager
        img.loading = 'eager';

        // 图片加载中提示：图片尚未加载完成或缺失时，在图片区域显示提示
        const imgHint = document.createElement('div');
        imgHint.className = 'cf-img-hint';
        const hintSpin = document.createElement('div');
        hintSpin.className = 'cf-img-hint-spin';
        const hintText = document.createElement('span');
        hintText.className = 'cf-img-hint-text';
        hintText.textContent = '图片加载中…';
        imgHint.appendChild(hintSpin);
        imgHint.appendChild(hintText);

        img.addEventListener('load', () => {
            // 图片加载成功：隐藏加载提示
            imgHint.style.display = 'none';
        });
        img.addEventListener('error', () => {
            // 图片缺失（加载失败）：隐藏图片本身，重新显示提示并改为加载失败
            img.style.display = 'none';
            imgHint.style.display = 'flex';
            hintSpin.style.display = 'none';
            hintText.textContent = '图片加载失败';
        });

        const label = document.createElement('div');
        label.className = 'cf-label';
        label.textContent = prod.label;

        const desc = document.createElement('div');
        desc.className = 'cf-desc';
        // 每行开头用飞机符号「✈」替换原来的全角空格缩进
        desc.textContent = '\u2708 ' + prod.description.replace(/\n/g, '\n\u2708 ');

        card.appendChild(img);
        card.appendChild(imgHint);
        card.appendChild(label);
        card.appendChild(desc);
        wrapper!.appendChild(card);
        cards.push(card);
    });

    if (updateDescription) {
        typeCatDesc('\u3000\u3000' + category.description.replace(/\n/g, '\n\u3000\u3000'));
    } else if (previousDescription && catDescEl) {
        catDescEl.textContent = previousDescription;
    }

    container.classList.remove('cf-hidden');
    updateCards(true);
    // 自动翻页：打开卡片页即开始 60s 空闲计时，无手动翻页则自动循环播放
    resetIdleTimer();
}

export function hideCoverFlow(): void {
    // 切换/隐藏类别：退出自动翻页并清空空闲计时
    autoMode = false;
    stopAutoAdvance();
    clearIdleTimer();
    if (!container) return;
    stopAnimation();
    container.classList.add('cf-hidden');
    productCount = 0;
    activeCategory = null;
    activeProductIdx = -1;
    resetActiveProduct(); // 隐藏时清空 uiStore 的中央产品状态
    cards = [];
    bases = [];
    plan = [];
    if (wrapper) wrapper.innerHTML = '';
    clearCatType();
    if (catDescEl) catDescEl.textContent = '';
}

/* ==================================================================
 * 自动翻页：打开卡片页 60s 无手动翻页后进入，直到手动翻页或切换类别
 * ================================================================== */

/** 清空空闲计时 */
function clearIdleTimer(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/** 停止自动翻页步进 */
function stopAutoAdvance(): void {
    if (autoInterval) { clearInterval(autoInterval); autoInterval = null; }
}

/** 手动翻页/切换类别：退出自动模式并重新开始 60s 空闲计时 */
function onManualInteraction(): void {
    autoMode = false;
    stopAutoAdvance();
    resetIdleTimer();
}

/** 重置空闲计时：60s 无手动翻页后进入自动翻页（仅当 CoverFlow 可见且多卡片时） */
function resetIdleTimer(): void {
    clearIdleTimer();
    if (!container || container.classList.contains('cf-hidden') || productCount <= 1) return;
    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!autoMode && !container!.classList.contains('cf-hidden')) {
            autoMode = true;
            startAutoAdvance();
        }
    }, AUTO_IDLE_MS);
}

/** 启动自动翻页：每隔一段时间前进一张卡片（配合无限循环回绕） */
function startAutoAdvance(): void {
    stopAutoAdvance();
    autoInterval = setInterval(() => {
        targetIndex += 1;
        animateToTarget();
    }, AUTO_STEP_MS);
}

function onDragStart(event: MouseEvent | TouchEvent): void {
    if (!container || container.classList.contains('cf-hidden') || productCount <= 1) return;
    onManualInteraction();
    isDragging = true;
    dragStartX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    dragStartIndex = Math.round(animIndex);
    dragDelta = 0;
}

function onDragMove(event: MouseEvent | TouchEvent): void {
    if (!isDragging) return;
    event.preventDefault();
    const currentX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    dragDelta = currentX - dragStartX;
    targetIndex = dragStartIndex - dragDelta / (CENTER_GAP * 1.2);
    stopAnimation();
    animIndex = targetIndex;
    updateCards(false);
}

function onDragEnd(): void {
    if (!isDragging) return;
    isDragging = false;
    targetIndex = Math.round(targetIndex);
    animateToTarget();
}

function onWheel(event: WheelEvent): void {
    if (!container || container.classList.contains('cf-hidden') || productCount <= 1) return;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
    event.preventDefault();
    if (Math.abs(event.deltaX) > 40) {
        onManualInteraction();
        targetIndex += event.deltaX > 0 ? 1 : -1;
        animateToTarget();
    }
}

function animateToTarget(): void {
    stopAnimation();
    const startIndex = animIndex;
    const progress = { value: startIndex };
    animationTween = gsap.to(progress, {
        value: targetIndex,
        duration: 0.55,
        ease: 'power3.out',
        onUpdate: () => {
            animIndex = progress.value;
            updateCards(false);
        },
        onComplete: () => {
            animationTween = null;
            animIndex = targetIndex;
            updateCards(false);
        },
    });
}

function stopAnimation(): void {
    if (animationTween) {
        animationTween.kill();
        animationTween = null;
    }
}

function calcPosition(offset: number): { x: number; z: number; rotateY: number; zIdx: number; brightness: number; scale: number } {
    const absOffset = Math.abs(offset);
    const sign = Math.sign(offset);
    const x = absOffset < 1
        ? offset * CENTER_GAP
        : sign * (CENTER_GAP + (absOffset - 1) * STACK_SPACING);
    const rotateY = absOffset < 0.5 ? -offset * ROTATION * 2 : (sign < 0 ? ROTATION : -ROTATION);
    return {
        x,
        z: absOffset > 0.5 ? Z_FAR : absOffset * Z_FAR * 2,
        rotateY,
        zIdx: 1000 - Math.round(absOffset * 100),
        brightness: absOffset < 0.5 ? 1 : 0.5,
        scale: Math.max(0.68, 1 - absOffset * 0.28),
    };
}

function calcOpacity(offset: number): number {
    const absOffset = Math.abs(offset);
    if (productCount === 2) return absOffset <= 1 ? 1 : Math.max(0, (1.5 - absOffset) / 0.5);
    const wrapPoint = Math.min(productCount / 2, 4.5);
    const fadeStart = Math.max(1, wrapPoint - 1);
    if (wrapPoint <= fadeStart || absOffset <= fadeStart) return 1;
    return Math.max(0, 1 - (absOffset - fadeStart) / (wrapPoint - fadeStart));
}

function updateCards(instant: boolean): void {
    if (productCount === 0) return;
    cards.forEach((card, index) => {
        let offset = bases[index] - animIndex;
        if (productCount === 1) offset = 0;
        else if (productCount === 2) {
            while (offset > 2.5) { bases[index] -= 4; offset -= 4; }
            while (offset < -2.5) { bases[index] += 4; offset += 4; }
        } else {
            offset -= productCount * Math.round(offset / productCount);
        }
        const position = calcPosition(offset);
        const opacity = calcOpacity(offset);
        card.style.transition = instant ? 'none' : 'filter 0.35s ease, border-color 0.3s ease, box-shadow 0.3s ease';
        card.style.transform = `translateX(${position.x}px) translateZ(${position.z}px) rotateY(${position.rotateY}deg) scale(${position.scale})`;
        card.style.zIndex = String(position.zIdx);
        card.style.filter = `brightness(${position.brightness})`;
        card.style.opacity = String(opacity);
        card.style.pointerEvents = opacity <= 0 ? 'none' : 'auto';
        card.classList.toggle('cf-active', Math.abs(offset) < 0.5);
    });
    updateActiveProduct();
}

function updateActiveProduct(): void {
    if (productCount === 0) return;
    const active = ((Math.round(animIndex) % productCount) + productCount) % productCount;
    if (active !== activeProductIdx) {
        activeProductIdx = active;
        if (active >= 0 && activeCategory && active < activeCategory.product.length) {
            const prod = activeCategory.product[active];
            if (prod) {
                sendProductAction(prod.action, prod.label);
                // 通过 uiStore 通知侧边栏同步二级菜单选中态（拖拽/点击/自动翻页等真实切换）
                setActiveProduct(activeCategory.label, active);
            }
        }
    }
}
