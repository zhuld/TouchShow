/* ==================================================================
 * TouchShow 主入口 —— 3D 展览展示（Vite + TypeScript + Three.js）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 初始化 3D 场景：背景贴图、透视相机、WebGL 渲染器
 *   2. 搭建光源：环境光 + 主题色平行光（投射阴影）
 *   3. 挂载 OrbitControls：单指旋转 / 双指缩放（带阻尼）
 *   4. 协调 UI 模块：Logo、标题栏、产品侧边栏、CoverFlow
 *   5. 启动远程配置实时同步（SSE 推送 + 15s 轮询兜底）
 *   6. 阻止页面级缩放（仅保留 3D 模型可缩放）
 * ================================================================== */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createModelManager } from './model.js';
import type { ModelManager } from './model.js';
import { createLogo } from './logo.js';
import { createSidebar } from './sidebar.js';
import { createTitleLabel } from './titleLabel.js';
import { createCoverFlow } from './coverflow.js';
import { fetchConfig, getConfig, getConfigLoadError, getModelUrl, onConfigChange, readDisplayMode, startConfigSync } from './config.js';
import { preloadResources } from './preload.js';
import { withBase } from './base.js';
import { updateLoading, setLoadingText, showEnterButton, showConfigError } from './loading.js';
import './style.css';

// ---- 模块初始化 ----
// 动态创建 Logo + 标题栏标签（位于加载画面之下，页面显示后即可见）；
// 侧边栏 / CoverFlow / 实时同步在资源全部读取到本地后创建（见下方 5.1 节）
createLogo();
createTitleLabel();

/* ==================================================================
 * 0. 禁用页面缩放（屏幕不缩放，仅 3D 模型可通过 OrbitControls 缩放）
 * ------------------------------------------------------------------
 * 触摸设备上：双指捏合由 OrbitControls 处理（canvas 已设 touch-action:none），
 * 浏览器页面级缩放需在此阻止，避免整个界面被缩放。
 * ================================================================== */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());
// 阻止 Ctrl/Cmd + 滚轮 或 +/- 键的页面缩放
window.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  },
  { passive: false }
);
window.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=')) {
      e.preventDefault();
    }
  },
  { passive: false }
);

/* ==================================================================
 * 1. 主题色（默认科技蓝）
 * ================================================================== */
const ACCENT_COLOR = 0x00d4ff;

/* ==================================================================
 * 2. 场景（Scene）/ 相机（Camera）/ 渲染器（Renderer）
 * ================================================================== */
const scene = new THREE.Scene();

// 加载 background.png 作为场景背景
const bgTexture = new THREE.TextureLoader().load(
  new URL('./assets/background.png', import.meta.url).href
);
bgTexture.colorSpace = THREE.SRGBColorSpace;
scene.background = bgTexture;

const camera = new THREE.PerspectiveCamera(
  45, // 视野 45°
  window.innerWidth / window.innerHeight, // 宽高比
  0.01, // 近裁面（配合 minDistance=0.05 放大 10 倍，避免近处物体被裁剪）
  1000 // 远裁面
);
camera.position.set(6, 5, 9);
camera.lookAt(0, 1.5, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// 注意：r185+ 已将 PCFSoftShadowMap 合并进 PCFShadowMap，此处使用默认的 PCFShadowMap

// 将渲染器挂载到 #app 容器
const app = document.querySelector<HTMLDivElement>('#app')!;
app.appendChild(renderer.domElement);

/* ==================================================================
 * 3. 灯光：环境光 + 平行光（投射阴影）
 * ================================================================== */
const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambientLight);

// 半球光：提供天空→地面的柔和渐变照明，避免模型暗面死黑
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x404040, 0.8);
scene.add(hemiLight);

// 主平行光：主题色（第 7 节会同步为 --accent 科技蓝），提高强度提亮整体
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
directionalLight.position.set(5, 10, 7);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.set(1024, 1024);
scene.add(directionalLight);

// 补光：另一侧白色平行光，减轻阴影面死黑，让模型细节更清晰
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(-6, 4, -8);
scene.add(fillLight);

// 右侧平行光：从模型正右方打光，照亮右侧面
const rightLight = new THREE.DirectionalLight(0xffffff, 0.6);
rightLight.position.set(12, 6, 0);
scene.add(rightLight);

// 左侧平行光：从模型正左方打光，照亮左侧面
const leftLight = new THREE.DirectionalLight(0xffffff, 0.6);
leftLight.position.set(-12, 6, 0);
scene.add(leftLight);

/* ==================================================================
 * 4. OrbitControls（原生支持触摸：单指旋转 / 双指缩放+平移）
 * ================================================================== */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 启用阻尼
controls.dampingFactor = 0.08; // 平滑惯性系数
controls.enableZoom = true;
controls.enablePan = true; // 平移（上下左右移动）：鼠标右键/中键拖动、双指拖动、方向键
controls.listenToKeyEvents(window); // 启用键盘方向键平移（无需聚焦画布）
controls.target.set(0, 2, 0);
controls.minDistance = 0.05; // 允许更靠近小物体（放大倍数提升 10 倍：约 22 倍 → 约 224 倍）
controls.maxDistance = 30;
controls.update();

/* ==================================================================
 * 5. 模型管理器
 * ================================================================== */
const modelManager: ModelManager = createModelManager(scene, controls, camera);

/* ==================================================================
 * 5.0 展示模式：图片模式 / 3D 模型模式
 * ------------------------------------------------------------------
 * config.json 顶层 displayMode 字段（管理页「设置」中远程切换）：
 *  - "image"（默认）：创建 CoverFlow，点击分类展示产品图片轮播；
 *  - "model"：不创建 CoverFlow 组件，仅展示 3D 模型（隐藏 CoverFlow）。
 * 组件只创建一次；远程从 model 切回 image 时由 onConfigChange 动态补建。
 * ================================================================== */
let coverflowCreated = false;
function ensureCoverFlow(): void {
  if (coverflowCreated) return;
  coverflowCreated = true;
  createCoverFlow();
}

/* ==================================================================
 * 5.1 资源预加载 + 页面显示流程
 * ------------------------------------------------------------------
 * 页面打开先显示加载画面，将全部产品图片 / 3D 模型读取到本地（浏览器缓存），
 * 再加载并挂载模型、渲染侧边栏，最后隐藏加载画面展示正常页面。
 * ================================================================== */

// 加载画面最短展示时长（毫秒）：即使资源提前就绪也至少展示这么久，避免一闪而过
const LOADING_MIN_MS = 5000;

// 配置加载失败时中止后续初始化（加载画面给出「重试」，避免进入空白页面）
let initAborted = false;

void (async () => {
  const loadStart = Date.now();
  try {
    // ① 拉取配置（获取产品图片地址列表）
    await fetchConfig();

    // ①.2 配置加载失败：加载画面明确提示「重试」（整页重新加载），不再继续后续初始化
    if (getConfigLoadError()) {
      initAborted = true;
      showConfigError();
      return;
    }

    // ①.5 立即启动实时同步（SSE + 轮询）：即使后续初始化步骤失败，
    //       模型/主题/串口/产品列表的远程变更也能第一时间响应
    startConfigSync();

    // 展示模式远程切换：切到 image 时若 CoverFlow 尚未创建则动态补建；
    // 切到 model 时由侧边栏 renderSidebar 负责隐藏 CoverFlow（组件不展示）
    onConfigChange((cfg) => {
      if (readDisplayMode(cfg) === 'image') {
        ensureCoverFlow();
      }
    });

    // ② 收集全部资源地址并预加载到本地缓存（产品图片 + 3D 模型文件）
    const urls: string[] = [];
    getConfig().category.forEach((cat) => {
      cat.product.forEach((prod) => urls.push(withBase(prod.image)));
    });
    urls.push(getModelUrl());
    await preloadResources(urls, (loaded, total) => updateLoading(loaded, total));

    // ③ 从本地缓存加载并挂载 3D 模型（材质 / 贴图随模型一起读取到本地）
    setLoadingText('正在加载 3D 模型…');
    await modelManager.load();

    // ④ 渲染 UI：按展示模式创建 CoverFlow / 侧边栏（实时同步已在 ① 后启动）
    //    image 图片模式：创建 CoverFlow；model 3D 模型模式：不创建，仅展示模型
    if (readDisplayMode(getConfig()) === 'image') {
      ensureCoverFlow();
    }
    await createSidebar(modelManager);
  } catch (e) {
    console.error('[init] 初始化失败：', e);
  } finally {
    // ⑤ 全部就绪：确保加载画面至少展示 LOADING_MIN_MS 后显示「进入」按钮，由用户手动进入
    //    配置加载失败时已由 showConfigError 展示「重试」按钮，不再显示进入按钮
    if (!initAborted) {
      const remain = Math.max(0, LOADING_MIN_MS - (Date.now() - loadStart));
      setTimeout(showEnterButton, remain);
    }
  }
})();

/* ==================================================================
 * 6. 窗口自适应缩放
 * ================================================================== */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ==================================================================
 * 7. 应用主题色：平行光颜色与 UI 主题同步（默认科技蓝）
 * ================================================================== */
// UI 颜色由 :root 的 --accent 驱动，此处同步 3D 主光颜色
directionalLight.color.setHex(ACCENT_COLOR);

/* ==================================================================
 * 8. 动画循环
 * ================================================================== */
function animate(): void {
  requestAnimationFrame(animate);

  // 模型更新（聚焦与整体复位动画）
  modelManager.update();

  // 阻尼模式下必须每帧调用 update() 才能获得平滑惯性
  controls.update();

  renderer.render(scene, camera);
}
animate();
