/* ==================================================================
 * UI 状态容器 —— 收敛 CoverFlow ↔ 侧边栏 的“当前中央产品”同步
 * ------------------------------------------------------------------
 * 原实现中 CoverFlow 通过单槽回调（productChangeListener）把“中央产品变化”
 * 通知侧边栏，侧边栏再用 suppressProductSync 布尔标志压制“分类级切换瞬间”
 * 的首次渲染自动选中。单槽回调 + 跨模块布尔标志属命令式协调，易在时序/重入
 * 下出错。
 *
 * 本模块作为二者之间唯一的事实源（store）：
 *  - CoverFlow 在中央产品真实变化（拖拽 / 滚轮 / 点击 / 自动翻页越过整数
 *    边界）时调用 setActiveProduct() 上报，默认触发通知；
 *  - 重建 / 隐藏时的初始定位用 silent 落库，不触发通知 —— 因此侧边栏不再
 *    需要“抑制首项选中”的标志；
 *  - 侧边栏订阅 onActiveProductChange() 同步二级菜单选中态与标题。
 * ================================================================== */

export interface ActiveProductState {
    /** 当前 CoverFlow 展示的分类 label（无展示 = null） */
    catLabel: string | null;
    /** 当前中央产品下标（无 = -1） */
    prodIndex: number;
}

let state: ActiveProductState = { catLabel: null, prodIndex: -1 };
const listeners = new Set<(s: ActiveProductState) => void>();

/** 更新中央产品状态；默认仅在真正变化时通知订阅者（silent=true 只落库不通知） */
export function setActiveProduct(catLabel: string, prodIndex: number, silent = false): void {
    if (state.catLabel === catLabel && state.prodIndex === prodIndex) return;
    state = { catLabel, prodIndex };
    if (silent) return;
    listeners.forEach((fn) => {
        try {
            fn(state);
        } catch (e) {
            console.error('[uiStore] 订阅回调执行失败：', e);
        }
    });
}

/** 清空中央产品状态（CoverFlow 隐藏 / 无展示时；只落库不通知，侧边栏自行维护选中态） */
export function resetActiveProduct(): void {
    if (state.catLabel === null && state.prodIndex === -1) return;
    state = { catLabel: null, prodIndex: -1 };
}

/** 订阅“中央产品变化”事件（返回取消订阅函数） */
export function onActiveProductChange(fn: (s: ActiveProductState) => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
