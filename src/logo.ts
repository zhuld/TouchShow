/* ==================================================================
 * Logo 管理器 —— 动态创建左上角 Logo
 * ================================================================== */

const LOGO_URL = new URL('./assets/logo.svg', import.meta.url).href;
const NAME_URL = new URL('./assets/name.svg', import.meta.url).href;

/**
 * 在页面左上角创建 Logo 及名称图片（并排显示）。
 * 通过 TS 动态生成 DOM，与 3D 逻辑解耦。
 */
export function createLogo(): void {
    const wrap = document.createElement('div');
    wrap.id = 'logoWrap';

    const img = document.createElement('img');
    img.id = 'logo';
    img.src = LOGO_URL;
    img.alt = 'Logo';

    const name = document.createElement('img');
    name.id = 'logoName';
    name.src = NAME_URL;
    name.alt = 'TouchShow';

    wrap.append(img, name);
    const left = document.querySelector('#topBar-left');
    if (left) left.appendChild(wrap);
}
