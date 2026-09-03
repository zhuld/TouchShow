/* ==================================================================
 * 资源预加载 —— 把图片 / 3D 模型 / 材质读取到本地（浏览器缓存）
 * ------------------------------------------------------------------
 * 页面打开时并行拉取全部资源并消费响应体，确保完整下载并写入浏览器缓存；
 * 之后 Three.js / <img> 再加载同一地址时直接命中缓存，几乎秒开。
 * ================================================================== */

const CONCURRENCY = 6; // 并行下载数（避免一次性请求过多压垮服务器）

/**
 * 并行预加载一批资源到浏览器缓存。
 * @param urls       资源地址列表（产品图片、3D 模型等）
 * @param onProgress 进度回调 (loaded, total)
 */
export async function preloadResources(
    urls: string[],
    onProgress: (loaded: number, total: number) => void
): Promise<void> {
    const total = urls.length;
    if (total === 0) {
        onProgress(0, 0);
        return;
    }

    let loaded = 0;
    onProgress(0, total);

    let idx = 0;
    const worker = async (): Promise<void> => {
        while (idx < total) {
            const url = urls[idx++];
            try {
                // force-cache：已缓存直接命中；未缓存则从服务器拉取并写入缓存
                const res = await fetch(url, { cache: 'force-cache' });
                // 消费响应体，确保完整下载（浏览器才会缓存完整资源）
                await res.arrayBuffer();
            } catch (e) {
                console.warn('[preload] 资源读取失败：', url, e);
            }
            loaded++;
            onProgress(loaded, total);
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
}
