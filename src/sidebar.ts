import { setTitleLabel } from './titleLabel';
import { showCoverFlow, hideCoverFlow } from './coverflow';
import { createProductPanel, showProductPanel, hideProductPanel } from './productPanel';
import { getConfig, fetchConfig, onConfigChange, onRemoteControl, readDisplayMode, sendLive } from './config';
import type { Category, Product, RemoteCommand } from './config';
import type { ModelManager } from './model';
import { onActiveProductChange } from './uiStore';
import { withBase } from './base';
import { gsap } from 'gsap';

/* ==================================================================
 * 侧边栏管理器 —— 产品类别导航（支持远程配置实时刷新）
 * ------------------------------------------------------------------
 * - 右上角圆形按钮开关侧边栏，按钮带弹入 / 弹出动画
 * - 点击类别按钮选中并展示 CoverFlow；再次点击取消选中
 * - 订阅远程配置变更，重建侧边栏并恢复选中态
 * ================================================================== */

let sidebar: HTMLElement | null = null;
let list: HTMLElement | null = null;
let menuBtn: HTMLElement | null = null;
let activeCatBtn: HTMLElement | null = null;
let activeProdBtn: HTMLElement | null = null; // 当前激活的二级产品按钮
let modelMgr: ModelManager | null = null; // 3D 模型管理器（3D 模式高亮产品物体用）
let sidebarTimeline: gsap.core.Timeline | null = null;

// 远程控制：管理页「远程控制」标签页一键切换分类/产品显示、显示/隐藏侧边栏。
// 侧边栏尚未创建（页面仍在初始化）时暂存命令队列，createSidebar 渲染完成后按序补执行。
const pendingRemote: RemoteCommand[] = [];

/**
 * 分派远程控制命令：
 *  - 'sidebar'：显示（visible=true）/ 隐藏（visible=false）侧边栏；
 *  - 'category' / 'product'：切换分类 / 选中具体产品。
 * 侧边栏尚未创建时返回 false（调用方负责暂存，创建完成后补执行）。
 */
function dispatchRemote(cmd: RemoteCommand): boolean {
    if (cmd.action === 'sidebar') {
        if (!sidebar) return false;
        if (cmd.visible) openSidebar();
        else closeSidebar();
        return true;
    }
    return remoteSelect(cmd);
}

onRemoteControl((cmd) => {
    if (!dispatchRemote(cmd)) pendingRemote.push(cmd);
});

function getCategoryButtons(): HTMLElement[] {
    return sidebar ? Array.from(sidebar.querySelectorAll<HTMLElement>('.sidebar-cat-btn')) : [];
}

function getSubmenus(): HTMLElement[] {
    return sidebar ? Array.from(sidebar.querySelectorAll<HTMLElement>('.sidebar-submenu')) : [];
}

function setMenuIcon(open: boolean): void {
    if (!menuBtn) return;
    menuBtn.classList.toggle('open', open);
    const icon = menuBtn.querySelector<HTMLElement>('.menu-icon');
    if (icon) {
        icon.textContent = open ? '❮' : '≡';
        gsap.to(icon, { rotation: open ? 180 : 0, duration: 0.35, ease: 'power2.out' });
    }
}

function openSidebar(): void {
    if (!sidebar) return;
    sidebarTimeline?.kill();
    sidebar.classList.remove('closed');
    setMenuIcon(true);
    document.getElementById('coverflow')?.classList.remove('cf-expand');

    const buttons = getCategoryButtons();
    const activeSubmenu = activeCatBtn?.nextElementSibling as HTMLElement | null;
    getSubmenus().forEach((submenu) => submenu.classList.remove('open'));
    sidebarTimeline = gsap.timeline();
    sidebarTimeline.fromTo(
        buttons,
        { x: 300, scale: 0.9, autoAlpha: 0 },
        { x: 0, scale: 1, autoAlpha: 1, duration: 0.65, stagger: 0.08, ease: 'back.out(1.7)' }
    );
    if (activeSubmenu?.classList.contains('sidebar-submenu')) {
        sidebarTimeline.call(() => {
            animateSubmenu(activeSubmenu, true);
            activeSubmenu.classList.add('open');
        });
    }
}

function closeSidebar(): void {
    if (!sidebar) return;
    sidebarTimeline?.kill();
    setMenuIcon(false);

    getSubmenus().forEach((submenu) => submenu.classList.remove('open'));
    const buttons = getCategoryButtons();
    sidebarTimeline = gsap.timeline({
        onComplete: () => {
            if (!sidebar) return;
            sidebar.classList.add('closed');
            document.getElementById('coverflow')?.classList.add('cf-expand');
        },
    });
    sidebarTimeline.to(buttons, {
        x: 300,
        scale: 0.9,
        autoAlpha: 0,
        duration: 0.5,
        delay: 0.35,
        stagger: { each: 0.05, from: 'end' },
        ease: 'power2.in',
    });
}

/**
 * 在屏幕右侧创建产品类别侧边栏 + 右上角圆形菜单开关。
 * 点击类别按钮切换选中/取消选中状态。
 * @param modelManager 3D 模型管理器（用于 3D 模式下高亮产品对应物体）
 */
export async function createSidebar(modelManager: ModelManager): Promise<void> {
    modelMgr = modelManager;
    // ---- 产品信息框（3D 模型模式下屏幕左侧展示当前产品：上部介绍 / 下部图片）----
    createProductPanel();
    // ---- 菜单开关按钮（放到顶部栏右侧）----
    const topRight = document.querySelector('#topBar-right');
    menuBtn = document.createElement('button');
    menuBtn.id = 'menuToggle';
    menuBtn.title = '产品菜单';
    // 默认图标：三条线菜单（≡）；打开后切换为收起箭头（❮）
    // 打开页面默认显示菜单：初始即为打开态（箭头 ❮ + open 样式）
    menuBtn.innerHTML = '<span class="menu-icon">❮</span>';
    menuBtn.classList.add('open');
    if (topRight) topRight.appendChild(menuBtn);

    // ---- 侧边栏（放到内容区）----
    sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    // 打开页面默认显示菜单：不再添加 closed（保持展开）

    list = document.createElement('div');
    list.className = 'sidebar-categories';
    sidebar.appendChild(list);
    document.body.appendChild(sidebar);

    // ---- 菜单开关事件 ----
    menuBtn.addEventListener('click', () => {
        if (!sidebar) return;
        const wasClosed = sidebar.classList.contains('closed');
        if (wasClosed) openSidebar();
        else closeSidebar();
    });

    // ---- 首次加载配置（保证首屏即有完整类别；若已由预加载流程拉取过则跳过）----
    if (getConfig().category.length === 0) {
        await fetchConfig();
    }

    // ---- 订阅配置变更：远程修改后实时重建侧边栏 ----
    onConfigChange(renderSidebar);

    // ---- CoverFlow 中央产品变化 → 同步二级菜单选中态与标题 ----
    // uiStore 为唯一事实源：仅在真实切换（拖拽/点击/自动翻页越过整数边界）时通知
    onActiveProductChange((s) => {
        if (s.catLabel && s.prodIndex >= 0) syncProductSelection(s.catLabel, s.prodIndex);
    });

    renderSidebar();

    // 打开页面默认显示菜单：使用 GSAP 播放交错入场动画
    openSidebar();

    // 侧边栏就绪：按序补执行初始化期间收到的远程控制命令
    while (pendingRemote.length > 0) {
        const cmd = pendingRemote.shift()!;
        dispatchRemote(cmd);
    }
}

/**
 * 按当前展示模式展示类别内容：
 *  - image 图片模式：弹出 CoverFlow 图片轮播；
 *  - model 3D 模型模式：隐藏 CoverFlow，仅展示 3D 模型（分类标题仍会更新）。
 * 模式由 config.json 顶层 displayMode 字段（管理页「设置」）远程控制，随配置实时切换。
 */
function showCategoryContent(cat: Category): void {
    if (readDisplayMode(getConfig()) === 'model') {
        hideCoverFlow();
    } else {
        showCoverFlow(cat);
    }
}

/** 清空当前二级产品选中态 */
function clearProductSelection(): void {
    if (activeProdBtn) {
        activeProdBtn.classList.remove('active');
        activeProdBtn = null;
    }
}

/**
 * 上报当前展示的分类/产品到服务器（管理页「客户端」页实时显示每台屏当前内容）。
 * 空字符串表示未选中；任何改变当前展示的操作后调用一次。
 */
function reportStatus(): void {
    const catLabel = activeCatBtn?.dataset.label || '';
    const prodLabel = activeProdBtn?.dataset.label || '';
    sendLive('screen-status', { category: catLabel, product: prodLabel });
}

/**
 * 二级菜单展开/收起动画（GSAP 驱动，容器高度仍由 CSS grid 过渡负责）：
 *  - 展开：产品按钮自上而下交错滑入淡入（y: -8 → 0, opacity: 0 → 1）；
 *  - 收起：自下而上反向交错滑出淡出（y: 0 → -8, opacity: 1 → 0）。
 */
function animateSubmenu(submenu: HTMLElement, open: boolean): void {
    const items = submenu.querySelectorAll<HTMLElement>('.sidebar-prod-btn');
    if (items.length === 0) return;
    // 先清掉该菜单上未完成的按钮动画（含 closeAllSubmenus 刚创建的收起动画），
    // 避免新旧 tween 竞争导致部分按钮停在中间态
    gsap.killTweensOf(items);
    if (open) {
        // 显式重置起点，避免依赖上一次动画的残留状态
        gsap.set(items, { opacity: 0, y: -8 });
        gsap.to(items, {
            opacity: 1,
            y: 0,
            duration: 0.35,
            stagger: 0.04,
            ease: 'power2.out',
            overwrite: true,
            // GSAP 会把独立 translate/rotate/scale 写成 inline none，覆盖 hover 位移；
            // 动画整体结束后清除，让 .sidebar-prod-btn:hover 的 translate 恢复生效
            onComplete: () => gsap.set(items, { clearProps: 'translate,rotate,scale' }),
        });
    } else {
        gsap.to(items, {
            opacity: 0,
            y: -8,
            duration: 0.25,
            stagger: { each: 0.04, from: 'end' },
            ease: 'power2.in',
            overwrite: true,
        });
    }
}

/** 收起所有分类的二级菜单（保留展开逻辑由调用方接管） */
function closeAllSubmenus(): void {
    if (!list) return;
    list.querySelectorAll<HTMLElement>('.sidebar-submenu').forEach((sm) => {
        animateSubmenu(sm, false);
        sm.classList.remove('open');
    });
}

/**
 * 激活某个分类（不自动选中具体产品）：展开其二级菜单并按展示模式展示内容。
 * 供一级分类点击 / 远程控制「category」共用（单一过渡路径，消除重复实现）。
 * 不需要 suppressProductSync：CoverFlow 重建时的初始定位以 silent 方式落入
 * uiStore（见 coverflow.showCoverFlow），不会发出“首项被选中”的通知。
 */
function activateCategory(cat: Category, catBtn: HTMLElement, submenu: HTMLElement): void {
    if (activeCatBtn && activeCatBtn !== catBtn) activeCatBtn.classList.remove('active');
    activeCatBtn = catBtn;
    catBtn.classList.add('active');
    closeAllSubmenus();
    animateSubmenu(submenu, true);
    submenu.classList.add('open');
    // 切换分类：不自动选中二级菜单（仅展开列表）
    clearProductSelection();
    hideProductPanel(); // 仅选中具体产品时才显示产品信息框
    setTitleLabel(cat.label);
    modelMgr?.highlightObject(null); // 分类级展示：3D 模式恢复整体模型，不聚焦具体物体
    showCategoryContent(cat);
    reportStatus();
}

/**
 * 点击一级分类按钮：
 *  - 未激活 → 激活并展开其下方二级菜单（同时收起其它分类），并按展示模式展示；
 *  - 已激活 → 取消选中、收起二级菜单与展示内容。
 */
function onCategoryClick(cat: Category, catBtn: HTMLElement, submenu: HTMLElement): void {
    // 点击一级分类：显示整个分类（3D 模式下恢复整体模型，不聚焦具体物体）
    modelMgr?.highlightObject(null);

    if (activeCatBtn === catBtn) {
        catBtn.classList.remove('active');
        activeCatBtn = null;
        animateSubmenu(submenu, false);
        submenu.classList.remove('open');
        clearProductSelection();
        setTitleLabel('');
        hideCoverFlow();
        hideProductPanel();
        reportStatus();
        return;
    }

    activateCategory(cat, catBtn, submenu);
}

/**
 * 选中具体产品：激活所属分类、展开其二级菜单，并按展示模式定位产品内容。
 * 供二级产品点击 / 远程控制「product」共用（单一过渡路径，消除重复实现）。
 */
function activateProduct(
    cat: Category,
    prod: Product,
    prodBtn: HTMLElement,
    catBtn: HTMLElement,
    submenu: HTMLElement,
    updateCategoryDescription: boolean,
): void {
    if (activeCatBtn && activeCatBtn !== catBtn) activeCatBtn.classList.remove('active');
    activeCatBtn = catBtn;
    catBtn.classList.add('active');
    closeAllSubmenus();
    animateSubmenu(submenu, true);
    submenu.classList.add('open');

    if (activeProdBtn) activeProdBtn.classList.remove('active');
    activeProdBtn = prodBtn;
    prodBtn.classList.add('active');

    setTitleLabel(cat.label);

    if (readDisplayMode(getConfig()) === 'model') {
        hideCoverFlow(); // 模型模式：仅更新标题/选中态
        showProductPanel(prod); // 模型模式：屏幕左侧展示产品信息框（上部介绍 / 下部图片）
        modelMgr?.highlightObject(prod.object || null, prod.rotate); // 高亮产品对应物体，按配置角度旋转（未配置/未找到则显示整体）
    } else {
        hideProductPanel(); // 图片模式不显示产品信息框
        showCoverFlow(cat, cat.product.indexOf(prod), updateCategoryDescription); // 图片模式：CoverFlow 定位到该产品
        modelMgr?.highlightObject(null); // 图片模式恢复整体模型
    }
    reportStatus();
}

/**
 * 点击二级产品按钮：
 *  - 激活所属一级分类并保持其二级菜单展开；
 *  - 图片模式：CoverFlow 定位到该产品；3D 模型模式：仅更新标题/选中态。
 */
function onProductClick(
    cat: Category,
    prod: Product,
    prodBtn: HTMLElement,
    catBtn: HTMLElement,
    submenu: HTMLElement,
    updateCategoryDescription = activeCatBtn !== catBtn
): void {
    activateProduct(cat, prod, prodBtn, catBtn, submenu, updateCategoryDescription);
}

/**
 * CoverFlow 中央激活产品变化（uiStore 通知）时，同步侧边栏二级菜单选中态与标题。
 * 仅当 CoverFlow 显示的正是当前激活分类时生效（避免串扰其它分类）。
 * 注：CoverFlow 重建的初始定位走 uiStore silent 落库、不发通知，故无需“抑制首项选中”标志。
 */
function syncProductSelection(catLabel: string, index: number): void {
    if (activeCatBtn?.dataset.label !== catLabel) return;
    const submenu = activeCatBtn.nextElementSibling as HTMLElement | null;
    const prodBtns = submenu ? submenu.querySelectorAll<HTMLElement>('.sidebar-prod-btn') : null;
    const target = prodBtns ? prodBtns[index] : null;
    if (activeProdBtn && activeProdBtn !== target) activeProdBtn.classList.remove('active');
    activeProdBtn = target || null;
    if (target) target.classList.add('active');
    setTitleLabel(catLabel);
    reportStatus();
}

/**
 * 根据当前配置重建侧边栏（一级分类 + 其下方二级产品菜单）。
 * 若当前正在展示某类别，重建后按 label 匹配恢复选中态、展开态并刷新展示；
 * 若该类别已被删除，则隐藏 CoverFlow 并清空标题；首次加载默认展开第一个分类。
 */
function renderSidebar(): void {
    if (!sidebar || !list) return;
    const data = getConfig();

    // 记住当前激活类别/产品（按 label 匹配，避免重建后丢失选中态）
    const activeLabel = activeCatBtn?.dataset.label;
    const activeProductLabel = activeProdBtn?.dataset.label;

    list.innerHTML = '';
    activeCatBtn = null;
    activeProdBtn = null;

    data.category.forEach((cat, index) => {
        // ---- 一级分类按钮 ----
        const catBtn = document.createElement('button');
        catBtn.className = 'sidebar-cat-btn';
        catBtn.dataset.label = cat.label;
        catBtn.style.setProperty('--i', String(index));
        catBtn.innerHTML = `<span class="cat-main"><span class="cat-icon"></span><span class="cat-label">${cat.label}</span><span class="cat-count">${cat.product.length}</span></span>`;
        const icon = catBtn.querySelector<HTMLElement>('.cat-icon');
        const iconValue = typeof cat.icon === 'string' ? cat.icon.trim() : '';
        if (icon && iconValue) {
            if (/\.svg(?:[?#].*)?$/i.test(iconValue)) {
                const image = document.createElement('img');
                image.src = new URL(withBase(iconValue), document.baseURI).href;
                image.alt = '';
                icon.appendChild(image);
            } else {
                icon.textContent = iconValue;
            }
        }

        // ---- 二级菜单（产品列表，显示在一级按钮下方）----
        const submenu = document.createElement('div');
        submenu.className = 'sidebar-submenu';
        submenu.style.setProperty('--i', String(index)); // 随所属一级按钮交错入场
        const subInner = document.createElement('div');
        subInner.className = 'sidebar-submenu-inner';
        cat.product.forEach((prod) => {
            const prodBtn = document.createElement('button');
            prodBtn.className = 'sidebar-prod-btn';
            prodBtn.dataset.label = prod.label;
            prodBtn.innerHTML = `<span class="prod-dot"></span><span class="prod-label">${prod.label}</span>`;
            prodBtn.addEventListener('click', () => onProductClick(cat, prod, prodBtn, catBtn, submenu));
            subInner.appendChild(prodBtn);
            // 恢复二级选中态（仅当分类也恢复激活时）
            if (cat.label === activeLabel && prod.label === activeProductLabel) {
                prodBtn.classList.add('active');
                activeProdBtn = prodBtn;
                // 3D 模型模式：恢复产品信息框
                if (readDisplayMode(getConfig()) === 'model') {
                    showProductPanel(prod);
                }
            }
        });
        submenu.appendChild(subInner);

        list!.appendChild(catBtn);
        list!.appendChild(submenu);

        // 恢复之前激活的类别：重新选中一级按钮 + 展开二级菜单 + 恢复标题与展示内容。
        // 图片模式用之前选中的产品下标重新定位 CoverFlow（模型模式仅展示模型，产品/信息框由上方产品循环恢复）
        if (cat.label === activeLabel) {
            catBtn.classList.add('active');
            activeCatBtn = catBtn;
            animateSubmenu(submenu, true);
            submenu.classList.add('open');
            setTitleLabel(cat.label);
            if (readDisplayMode(getConfig()) === 'model') {
                hideCoverFlow();
            } else {
                const restoredIdx = activeProdBtn
                    ? cat.product.findIndex((p) => p.label === activeProdBtn?.dataset.label)
                    : -1;
                showCoverFlow(cat, restoredIdx >= 0 ? restoredIdx : 0, true);
            }
        }

        catBtn.addEventListener('click', () => onCategoryClick(cat, catBtn, submenu));
    });

    if (activeLabel === undefined && data.category.length > 0) {
        // 首次加载（无激活类别）：不选中任何分类/产品，保持全部收起，等待用户点击选择
        setTitleLabel('');
        hideCoverFlow();
        hideProductPanel();
    } else if (activeLabel !== undefined && !data.category.some((cat) => cat.label === activeLabel)) {
        // 原激活类别已被删除：收起当前展示
        setTitleLabel('');
        hideCoverFlow();
        hideProductPanel();
    }

    // 图片模式（或虽为模型模式但未选中具体产品）：隐藏产品信息框
    if (readDisplayMode(getConfig()) !== 'model' || !activeProdBtn) {
        hideProductPanel();
    }
    reportStatus();
}

/**
 * 远程控制：按管理页「远程控制」命令切换分类/产品显示（不依赖 DOM 点击）。
 *  - action 'category'：激活分类、展开二级菜单并展示该分类内容（不自动选中产品）；
 *  - action 'product'：在分类内定位并选中指定产品（图片模式 CoverFlow 定位 / 3D 模式信息框+高亮）。
 * 侧边栏尚未创建或命令无效时返回 false（调用方负责暂存）。
 */
function remoteSelect(cmd: RemoteCommand): boolean {
    if (!sidebar || !list) return false;
    const cat = getConfig().category[cmd.category];
    if (!cat) return false;
    const catBtn = getCategoryButtons()[cmd.category];
    if (!catBtn) return false;
    const submenu = catBtn.nextElementSibling as HTMLElement | null;
    if (!submenu) return false;

    const wantProduct =
        cmd.action === 'product' &&
        Number.isInteger(cmd.product) &&
        cmd.product! >= 0 &&
        cmd.product! < cat.product.length;
    const prod = wantProduct ? cat.product[cmd.product!] : undefined;

    if (prod) {
        // 选中具体产品（复用与二级点击相同的过渡路径）
        const prodBtn = submenu.querySelectorAll<HTMLElement>('.sidebar-prod-btn')[cmd.product!];
        if (!prodBtn) return false;
        activateProduct(cat, prod, prodBtn, catBtn, submenu, true);
    } else {
        // 仅切换分类（复用与一级点击相同的过渡路径；不自动选中二级菜单）
        activateCategory(cat, catBtn, submenu);
    }
    return true;
}

