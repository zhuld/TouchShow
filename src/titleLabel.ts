import { gsap } from 'gsap';

/* ==================================================================
 * 标题栏标签管理器 —— 带出入场动画
 * ================================================================== */

let labelEl: HTMLElement | null = null;
let lineEl: HTMLElement | null = null;
let labelTween: gsap.core.Timeline | null = null;
let linePulseTween: gsap.core.Tween | null = null;

/**
 * 在页面顶部居中创建标题标签 + 底部固定发光横线。
 */
export function createTitleLabel(): void {
    const center = document.querySelector('#topBar-center');
    if (!center) return;

    labelEl = document.createElement('div');
    labelEl.id = 'titleLabel';
    center.appendChild(labelEl);

    lineEl = document.createElement('div');
    lineEl.id = 'titleLine';
    center.appendChild(lineEl);
}

/**
 * 设置标题栏显示的文本，带淡入淡出动画。
 * @param text 要显示的文字，传空字符串则隐藏。
 */
export function setTitleLabel(text: string): void {
    if (!labelEl || !lineEl) return;

    labelTween?.kill();
    linePulseTween?.kill();

    const el = labelEl;
    const currentText = el.textContent || '';

    // 目标与当前相同，不处理
    if (text === currentText) return;

    labelTween = gsap.timeline();
    if (currentText) {
        labelTween.to(el, { y: -24, autoAlpha: 0, duration: 0.25, ease: 'power2.in' });
        labelTween.to(lineEl, { autoAlpha: 0, duration: 0.25, ease: 'power2.in' }, '<');
        labelTween.call(() => applyText(el, text));
    } else {
        applyText(el, text);
    }
}

function applyText(el: HTMLElement, text: string): void {
    el.textContent = text;

    if (!text) {
        gsap.set([el, lineEl], { autoAlpha: 0, y: -24 });
        return;
    }

    gsap.fromTo(
        el,
        { y: -24, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.35, ease: 'power2.out' }
    );
    gsap.fromTo(
        lineEl,
        { y: 0, autoAlpha: 0 },
        {
            y: 0,
            autoAlpha: 1,
            duration: 0.5,
            ease: 'power2.out',
            onComplete: () => {
                linePulseTween = gsap.to(lineEl, {
                    autoAlpha: 0.2,
                    duration: 1.6,
                    delay: 0.5,
                    repeat: -1,
                    yoyo: true,
                    ease: 'sine.inOut',
                });
            },
        }
    );
}
