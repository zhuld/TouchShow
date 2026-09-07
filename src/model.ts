/* ==================================================================
 * 模型管理器 —— 模型加载 / 缩放居中 / 材质重建 / 视角复位与产品高亮
 * ------------------------------------------------------------------
 * - 支持 .fbx（含贴图重建）与 .glb / .gltf
 * - 模型按最长边统一缩放到 TARGET_SIZE，水平居中并抬离地面
 * - 加载后关闭模型内嵌光源，避免干扰场景光照
 * - 用户取消产品高亮时平滑复位视角，不自动旋转
 * ================================================================== */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { getConfig, getModelUrl, onConfigChange, readModelName } from './config.js';
import { withBase } from './base.js';

// ---- 配置 ----
// 3D 模型固定目录 /Models/：模型文件放置于此，具体文件名由 config.json 的 model 字段远程指定。
// 模型完整地址由 config.getModelUrl() 计算，预加载与加载统一使用该地址。
const TARGET_SIZE = 10; // 模型最长边缩放至 10 个场景单位
const RESET_SPEED = 0.05; // 复位 lerp 速度

const textureLoader = new THREE.TextureLoader();

// ---- 状态 ----
let modelGroup: THREE.Group;
let currentModel: THREE.Object3D | null = null; // 当前挂载的模型（远程切换时用于卸载清理）
let currentModelName = readModelName(getConfig()); // 当前已加载模型名（用于检测远程变更）
let isResetting = false;
const resetTarget = new THREE.Vector3(0, 2, 0); // 整体复位时 OrbitControls 的目标点
const originalCameraPos = new THREE.Vector3(); // 初始相机位置，复位视角用

// ---- 高亮/聚焦（3D 模式下点击产品突出显示模型部件）----
// 选中物体自发光颜色高亮且不透明；其余部件设为高透明（opacity 0.1），突出选中物
const UNSELECTED_OPACITY = 0.1; // 高亮时未选中部件的透明度（几乎透明，突出选中物）
const HIGHLIGHT_GLOW = 0x00d4ff; // 高亮物体自发光色（主题科技蓝）
const HIGHLIGHT_GLOW_INTENSITY = 0.2; // 高亮自发光强度
const FOCUS_SPEED = 0.06; // 视角转向高亮物体的 lerp 速度（60fps 基准，帧率无关换算见 update()）
const FOCUS_EPSILON = 0.005; // 聚焦结束阈值，避免过早吸附造成末尾跳变
// 聚焦距离不再用固定系数，改为按物体实际大小自适应：让物体包围盒对角线在屏幕上
// 约占画面高度的 FOCUS_SCREEN_FRACTION，小物体放大倍数大、大物体放大倍数小，
// 不同大小的物体聚焦后画面占比一致、观感合适（大物体不会撑出屏幕，小物体也不会太小）
const FOCUS_SCREEN_FRACTION = 0.35; // 聚焦后物体对角线占画面高度的比例（0.85 = 85%）
const FOCUS_MIN_DIST = 0.01; // 聚焦相机距离下限（防止极小物体距离过近穿模/被近裁面裁剪）
// 帧率无关平滑：跨帧 delta 时间换算 lerp 步长，动画速度不随 FPS 波动（避免卡顿/顿挫）
const animTimer = new THREE.Timer();

let isFocusing = false; // 是否正在转向高亮物体
let highlightObjRef: THREE.Object3D | null = null; // 高亮物体引用（模型旋转后用于计算聚焦点）
let focusRotDeg = 0; // 观看该产品时模型的水平旋转角度（度，缺省 0 = 不旋转）
let focusCenter = new THREE.Vector3(); // 高亮物体世界包围盒中心
let focusCamPos = new THREE.Vector3(); // 期望相机位置
let focusTarget = new THREE.Vector3(); // 期望注视点（对准物体中心，使物体在画面居中）
let focusComputed = false; // 阶段2聚焦参数是否已一次性计算（避免每帧重算包围盒造成卡顿）
let focusObjectDiagonal = 0; // 聚焦物体包围盒对角线，提前缓存避免动画切换时计算
let focusLocalCenter = new THREE.Vector3(); // 聚焦物体中心在模型容器内的坐标
// 高亮前保存的材质原状态（用于恢复）
let savedMatState: {
    mat: THREE.Material;
    opacity: number;
    emissive: THREE.Color | null;
    emissiveIntensity: number;
}[] = [];

/* ==================================================================
 * 内部工具：FBX 材质重建
 * 返回 Promise，在所有贴图加载完成后 resolve
 * ================================================================== */
function rebuildFbxMaterials(model: THREE.Object3D, texUrl: string): Promise<void> {
    const texturePromises: Promise<void>[] = [];

    model.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const oldMats = Array.isArray(child.material) ? child.material : [child.material];
        const newMats = oldMats.map((oldMat) => {
            const mat = new THREE.MeshPhongMaterial();
            mat.color.copy(oldMat.color);
            mat.specular.copy(oldMat.specular);
            mat.shininess = oldMat.shininess;

            const fileName = oldMat.map?.name;
            if (fileName && /\.(jpe?g|png|tga|bmp|webp)$/i.test(fileName)) {
                texturePromises.push(
                    new Promise<void>((resolve) => {
                        textureLoader.load(
                            texUrl + fileName,
                            (tex) => {
                                tex.colorSpace = THREE.SRGBColorSpace;
                                mat.map = tex;
                                mat.color.set(0xffffff);
                                mat.needsUpdate = true;
                                resolve();
                            },
                            undefined,
                            () => resolve() // 加载失败也 resolve，避免永久卡住
                        );
                    })
                );
            }
            return mat;
        });
        child.material = newMats.length === 1 ? newMats[0] : newMats;
    });

    return Promise.all(texturePromises).then(() => { });
}

/* ==================================================================
 * 内部工具：通用模型加载（.fbx / .glb / .gltf）
 * 返回 Promise，模型（含贴图）加载完成后 resolve
 * ================================================================== */
function loadModel(url: string): Promise<THREE.Object3D> {
    return new Promise((resolve, reject) => {
        const ext = url.split('.').pop()?.toLowerCase();
        if (ext === 'fbx') {
            const texUrl = withBase('/Models/tex/');
            new FBXLoader()
                .setResourcePath(texUrl)
                .load(
                    url,
                    async (object) => {
                        // 等待所有贴图加载完成再 resolve，避免闪烁黑色模型
                        await rebuildFbxMaterials(object, texUrl);
                        resolve(object);
                    },
                    undefined,
                    (error) => {
                        console.error('FBX 模型加载失败：', error);
                        reject(error);
                    }
                );
        } else {
            new GLTFLoader().load(url, (gltf) => resolve(gltf.scene), undefined, (error) => {
                console.error('GLB/GLTF 模型加载失败：', error);
                reject(error);
            });
        }
    });
}

/* ==================================================================
 * 内部工具：按名称查找模型内物体（优先精确匹配，其次不区分大小写的包含匹配）
 * ================================================================== */
function findObjectByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    const lower = name.toLowerCase();
    root.traverse((o) => {
        if (found) return;
        if (o.name && o.name.toLowerCase() === lower) {
            found = o;
            return;
        }
    });
    if (!found && lower.length > 0) {
        root.traverse((o) => {
            if (found) return;
            if (o.name && o.name.toLowerCase().includes(lower)) found = o;
        });
    }
    return found;
}

/* ==================================================================
 * 公开 API
 * ================================================================== */

export interface ModelManager {
    /** 每帧调用，处理聚焦与复位动画 */
    update(): void;
    /** 资源预加载完成后调用：加载并挂载 3D 模型（含贴图），resolve 时模型已就绪 */
    load(): Promise<void>;
    /**
     * 高亮模型中的指定物体并转到其视角（3D 模式点击产品时调用）：
     *  - 找到物体：该物体自发光颜色高亮且不透明，模型其余部分设为高透明（opacity 0.1，不高亮），模型先水平旋转到 rotateDeg 角度（缺省 0 不旋转），再平滑转向放大该物体；
     *  - 传 null / 未找到物体：恢复模型整体展示（不透明 + 复位整体视角）。
     * @param rotateDeg 观看时模型的水平旋转角度（度，绕 Y 轴，缺省 0 = 不旋转）
     */
    highlightObject(name: string | null, rotateDeg?: number): void;
}

/**
 * 初始化模型管理器：创建模型容器、加载模型、绑定控件事件。
 * @param scene   Three.js 场景（模型容器将添加到此场景）
 * @param controls OrbitControls 实例（用于监听交互事件与复位目标点）
 */
export function createModelManager(scene: THREE.Scene, controls: OrbitControls, camera: THREE.Camera): ModelManager {
    // ① 创建模型容器，挂载到场景
    modelGroup = new THREE.Group();
    scene.add(modelGroup);

    // 记录初始相机位置，用于取消高亮后的视角复位
    originalCameraPos.copy(camera.position);

    // ② 加载并挂载 3D 模型（由 load() 在资源预加载完成后调用）
    const mountModel = (model: THREE.Object3D): void => {
        model.traverse((child) => {
            // 关闭模型文件内嵌的光源（FBX 常自带灯光节点，会干扰场景光照）
            if (child instanceof THREE.Light) {
                child.visible = false;
            }
            if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                // 克隆材质，使每个网格拥有独立材质实例：
                // GLB 中多个网格可能共享同一材质（尤其默认材质），若不克隆，
                // 高亮/透明会相互"串扰"（选中一个部件，共享材质的其它部件无法单独变透明）。
                // 克隆后每个网格的透明度/自发光可独立设置，互不影响。
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                const newMats = mats.map((mat) => {
                    const clone = mat.clone();
                    clone.transparent = true;
                    clone.opacity = 1;
                    return clone;
                });
                child.material = newMats.length === 1 ? newMats[0] : newMats;
            }
        });

        // 按最长边统一缩放
        const box = new THREE.Box3().setFromObject(model);
        const maxSide = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        if (maxSide > 0) {
            model.scale.setScalar(TARGET_SIZE / maxSide);
        }

        // 水平居中 + 底部抬离地面
        const scaledBox = new THREE.Box3().setFromObject(model);
        const center = scaledBox.getCenter(new THREE.Vector3());
        model.position.sub(center);
        model.position.y += center.y - scaledBox.min.y + 1.2;

        modelGroup.add(model);
    };

    // 释放模型几何/材质资源（远程切换模型时避免 GPU 内存泄漏）
    const disposeModel = (obj: THREE.Object3D): void => {
        obj.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            child.geometry?.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                m.map?.dispose();
                m.dispose();
            });
        });
    };

    // 恢复高亮时保存的材质原状态（透明度 / 自发光）
    const restoreMaterials = (): void => {
        savedMatState.forEach((s) => {
            s.mat.opacity = s.opacity;
            if (s.emissive) (s.mat as THREE.MeshStandardMaterial).emissive.copy(s.emissive);
            (s.mat as THREE.MeshStandardMaterial).emissiveIntensity = s.emissiveIntensity;
            s.mat.needsUpdate = true;
        });
        savedMatState = [];
    };

    // 模型重新加载后清空高亮状态（新模型材质全新，旧保存状态失效）
    const resetHighlightState = (): void => {
        savedMatState = [];
        isFocusing = false;
        highlightObjRef = null;
        focusComputed = false;
        focusObjectDiagonal = 0;
        focusLocalCenter.set(0, 0, 0);
    };

    // 加载序号：防止初始化阶段的首次推送与手动 load() 并发加载造成竞态，仅最新一次生效
    let loadSeq = 0;
    // 加载并挂载模型；已存在模型时先卸载并清理旧模型
    const loadAndMount = async (url: string): Promise<void> => {
        const seq = ++loadSeq;
        try {
            const model = await loadModel(url);
            // 期间又发起了更新的加载请求，丢弃本次结果，避免旧加载覆盖新加载
            if (seq !== loadSeq) {
                disposeModel(model);
                return;
            }
            if (currentModel) {
                modelGroup.remove(currentModel);
                disposeModel(currentModel);
            }
            mountModel(model);
            // 新模型已挂载：清空上一个模型的高亮状态（材质全新）
            resetHighlightState();
            currentModel = model;
            currentModelName = readModelName(getConfig());
            console.log(`[model] 模型加载完成：${url}`);
        } catch (e) {
            // 加载失败时保留当前模型，避免黑屏；明确打印便于排查（常见：文件名错误/文件不存在）
            if (seq === loadSeq) {
                console.error(`[model] 模型加载失败，已保留当前模型：${url}`, e);
            }
        }
    };

    // 订阅配置变更：模型文件名被远程修改（管理页保存或直接改 config.json）后，自动卸载旧模型并加载新模型
    //    注意：必须在 return 之前注册，否则成为不可达代码、订阅永不生效
    onConfigChange((cfg) => {
        const name = readModelName(cfg);
        console.log(`[model] onConfigChange: name=${name} currentModelName=${currentModelName}`);
        if (name && name !== currentModelName) {
            console.log(`[model] 检测到模型变更：${currentModelName} → ${name}，正在重新加载…`);
            void loadAndMount(getModelUrl());
        }
    });

    // ③ 绑定 OrbitControls 事件：用户接管视角时取消复位/聚焦
    controls.addEventListener('start', () => {
        isResetting = false;
        isFocusing = false;
        controls.enableDamping = true;
    });

    // ④ 返回管理器接口
    return {
        update() {
            // 帧率无关平滑系数：以 60fps 为基准换算每帧步长，动画速度不随 FPS 波动（避免卡顿）；
            // dt 钳制到 0.05s，防止页面切后台回来时 getDelta 过大导致镜头跳变
            animTimer.update();
            const dt = Math.min(animTimer.getDelta(), 0.05);
            const alphaFocus = 1 - Math.pow(1 - FOCUS_SPEED, dt * 60);
            const alphaReset = 1 - Math.pow(1 - RESET_SPEED, dt * 60);

            // 观看物体：先把模型水平旋转到配置角度（rotateDeg，默认 0 不旋转），旋转完成后基于物体新位置转向放大
            if (isFocusing) {
                // 目标水平角（度 → 弧度），归一到 [0, 2π)
                const FOCUS_ROT = ((focusRotDeg % 360) + 360) % 360 * Math.PI / 180;
                // 阶段1：平滑旋转模型到目标角度（最短角度路径）
                let y = modelGroup.rotation.y % (Math.PI * 2);
                if (y > Math.PI) y -= Math.PI * 2;
                else if (y < -Math.PI) y += Math.PI * 2;
                let diff = FOCUS_ROT - y;
                if (diff > Math.PI) diff -= Math.PI * 2;
                else if (diff < -Math.PI) diff += Math.PI * 2;

                if (Math.abs(diff) > 0.0005) {
                    modelGroup.rotation.y += diff * alphaFocus;
                } else {
                    // 阶段2：旋转完成，首次进入时一次性计算聚焦参数（物体在画面居中），
                    // 之后每帧仅向固定目标插值，避免每帧重算包围盒拖慢帧率造成卡顿
                    if (!focusComputed) {
                        focusComputed = true;
                        modelGroup.rotation.y = FOCUS_ROT;
                        if (highlightObjRef) {
                            // 中心已在点击时缓存，旋转后只做轻量矩阵变换。
                            modelGroup.updateMatrix();
                            focusCenter.copy(focusLocalCenter).applyMatrix4(modelGroup.matrix);
                            // 按物体实际大小自适应聚焦距离：让物体对角线约占画面高度 FOCUS_SCREEN_FRACTION
                            // （垂直 FOV = camera.fov；物体角尺寸 ≈ 2·atan(diag/(2·D)) = fov·ratio）
                            const diag = Math.max(focusObjectDiagonal, 1e-6);
                            const fovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
                            const camDist = diag / (2 * Math.tan((fovDeg * FOCUS_SCREEN_FRACTION / 2) * Math.PI / 180));
                            // 相机偏移方向 (0.72,0.45,0.9) 长度为 √(0.72²+0.45²+0.9²)≈1.2373，基准 dist = 实际距离 / 该长度
                            const dist = Math.max(camDist / 1.2373, FOCUS_MIN_DIST);
                            focusCamPos.copy(focusCenter).add(new THREE.Vector3(dist * 0.72, dist * 0.45, dist * 0.9));
                            // 注视点对准物体中心：物体在画面居中显示
                            focusTarget.copy(focusCenter);
                        }
                    }
                    controls.target.lerp(focusTarget, alphaFocus);
                    camera.position.lerp(focusCamPos, alphaFocus);
                    if (controls.target.distanceTo(focusTarget) < FOCUS_EPSILON && camera.position.distanceTo(focusCamPos) < FOCUS_EPSILON) {
                        controls.target.copy(focusTarget);
                        camera.position.copy(focusCamPos);
                        controls.update();
                        controls.enableDamping = true;
                        isFocusing = false;
                        highlightObjRef = null;
                        focusComputed = false;
                        focusObjectDiagonal = 0;
                    }
                }
                // controls.update() 由主循环 animate() 统一调用，这里不再重复调用（避免阻尼被重复叠加）
                return;
            }

            if (isResetting) {
                // 平滑复位模型旋转：取最短角度路径归零（帧率无关平滑）
                let y = modelGroup.rotation.y % (Math.PI * 2);
                if (y > Math.PI) y -= Math.PI * 2;
                else if (y < -Math.PI) y += Math.PI * 2;
                modelGroup.rotation.y += (0 - y) * alphaReset;

                // 平滑复位 OrbitControls 目标点
                controls.target.lerp(resetTarget, alphaReset);

                // 平滑复位相机位置（视角角度 + 缩放距离）
                camera.position.lerp(originalCameraPos, alphaReset);

                const rotDone = Math.abs(modelGroup.rotation.y) < 0.002;
                const targetDone = controls.target.distanceTo(resetTarget) < 0.01;
                const cameraDone = camera.position.distanceTo(originalCameraPos) < 0.01;

                if (rotDone && targetDone && cameraDone) {
                    modelGroup.rotation.y = 0;
                    controls.target.copy(resetTarget);
                    camera.position.copy(originalCameraPos);
                    controls.update();
                    controls.enableDamping = true;
                    isResetting = false;
                }
            }
        },
        // 高亮模型中的指定物体并转到其视角（3D 模式点击产品时调用）
        highlightObject(name: string | null, rotateDeg = 0) {
            // 记录该产品的观看旋转角度（度，默认 0 = 不旋转）
            focusRotDeg = typeof rotateDeg === 'number' && Number.isFinite(rotateDeg) ? rotateDeg : 0;
            // 清除上一个高亮：恢复所有材质原状态
            restoreMaterials();
            isFocusing = false;
            focusComputed = false;
            focusObjectDiagonal = 0;
            controls.enableDamping = false;
            focusLocalCenter.set(0, 0, 0);

            if (!currentModel || !name) {
                // 无模型或未指定物体 → 回到整体展示（触发整体复位）
                if (!isResetting) {
                    isResetting = true;
                }
                return;
            }

            // 在模型中查找物体：优先精确匹配，其次不区分大小写的包含匹配
            const target = findObjectByName(currentModel, name);
            if (!target) {
                controls.enableDamping = true;
                console.warn(`[model] 未找到物体「${name}」，保持整体展示`);
                return;
            }

            // 收集目标物体用到的所有材质
            const targetMats = new Set<THREE.Material>();
            target.traverse((o) => {
                if (!(o instanceof THREE.Mesh)) return;
                const ms = Array.isArray(o.material) ? o.material : [o.material];
                ms.forEach((m) => targetMats.add(m));
            });

            // 保存所有材质原状态并应用高亮：选中物体自发光颜色高亮且不透明，
            // 其余部件设为高透明（opacity 0.1），突出选中物
            currentModel.traverse((o) => {
                if (!(o instanceof THREE.Mesh)) return;
                const ms = Array.isArray(o.material) ? o.material : [o.material];
                ms.forEach((m) => {
                    if (savedMatState.some((s) => s.mat === m)) return; // 同一材质只保存一次
                    const em = (m as THREE.MeshStandardMaterial).emissive;
                    savedMatState.push({
                        mat: m,
                        opacity: m.opacity,
                        emissive: em ? em.clone() : null,
                        emissiveIntensity: (m as THREE.MeshStandardMaterial).emissiveIntensity,
                    });
                    const isTarget = targetMats.has(m);
                    // 选中物体：不透明 + 自发光颜色高亮；未选中物体：高透明（0.1）突出选中物
                    if (isTarget) {
                        m.transparent = true;
                        m.opacity = 1;
                        if (em) {
                            em.set(HIGHLIGHT_GLOW);
                            (m as THREE.MeshStandardMaterial).emissiveIntensity = HIGHLIGHT_GLOW_INTENSITY;
                        }
                    } else {
                        m.transparent = true;
                        m.opacity = UNSELECTED_OPACITY;
                    }
                    m.needsUpdate = true;
                });
            });

            // 启动聚焦：记录物体引用，先把模型水平旋转到配置角度，旋转完成后转向放大
            highlightObjRef = target;
            const targetBox = new THREE.Box3().setFromObject(target);
            const targetCenter = targetBox.getCenter(new THREE.Vector3());
            focusObjectDiagonal = targetBox.getSize(new THREE.Vector3()).length();
            focusLocalCenter.copy(modelGroup.worldToLocal(targetCenter));
            isResetting = false;
            isFocusing = true;
        },
        // ⑤ 加载并挂载模型（资源预加载完成后调用；模型/贴图已入浏览器缓存，加载迅速）
        async load(): Promise<void> {
            await loadAndMount(getModelUrl());
        },
    };
}
