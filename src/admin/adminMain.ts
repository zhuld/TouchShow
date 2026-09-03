// @ts-nocheck
/* ==================================================================
 * 管理页脚本 —— 从 admin.html 内联脚本整体迁出（2026-09-02 重构）
 * ------------------------------------------------------------------
 * 由两部分按原执行顺序合并：
 *   1. 3D 模型物体枚举（原 <script type="module">）：顶部 import three，
 *      先执行并把 window.__TSModelObjects 挂到 window；
 *   2. 管理页主逻辑（原内联经典 IIFE）：配置编辑/保存/SSE/远程控制。
 * 作为 Vite 模块入口后，脚本在 DOM 解析完成后才执行（原经典脚本在
 * body 末尾同步执行，module 延迟执行，行为一致且更安全）。
 * 注：整体保留原逻辑（@ts-nocheck 跳过类型检查），后续可逐步类型化、
 * 再按标签页拆分子模块。
 * ================================================================== */



import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

(function () {
  // 模型名 -> Promise<物体名[]>（解析一次后缓存，避免重复加载大模型）
  var cache = Object.create(null);
  var currentModel = ""; // 当前已解析的模型名
  var currentList = []; // 当前已解析的物体名列表
  var refreshCbs = []; // 物体列表变化时的回调（经典脚本用于刷新下拉框）

  // 遍历模型收集网格物体名（去重 + 按字典序排序，便于选择）。
  // skipPrefix：过滤掉以模型文件名（去扩展名）开头的部件，如 C919.glb 的
  // C919 / C919001… 这类模型主体/机身，避免下拉被无意义的部件名刷屏。
  function collectMeshNames(root, skipPrefix) {
    var names = [];
    var seen = Object.create(null);
    root.traverse(function (o) {
      if (o && o.isMesh && o.name && !seen[o.name]) {
        if (skipPrefix && o.name.indexOf(skipPrefix) === 0) return;
        seen[o.name] = true;
        names.push(o.name);
      }
    });
    names.sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return names;
  }

  // 加载模型文件（.glb/.gltf 用 GLTFLoader，.fbx 用 FBXLoader），resolve 时返回模型根节点
  function loadModelUrl(url) {
    return new Promise(function (resolve, reject) {
      var ext = (url.split(".").pop() || "").toLowerCase();
      if (ext === "fbx") {
        new FBXLoader().load(url, resolve, undefined, reject);
      } else {
        new GLTFLoader().load(
          url,
          function (gltf) {
            resolve(gltf.scene);
          },
          undefined,
          reject,
        );
      }
    });
  }

  // 解析指定模型文件（/Models/ 下）的网格物体名；同名解析结果缓存
  function load(name) {
    name = (name || "").trim();
    if (!name) {
      currentModel = "";
      currentList = [];
      window.__TSModelObjects.current = [];
      notify();
      return Promise.resolve([]);
    }
    if (name === currentModel) return Promise.resolve(currentList);
    var p = cache[name];
    if (!p) {
      // 模型文件名去扩展名作为前缀过滤（C919.glb → 过滤 C919 开头部件）
      var base = name.replace(/\.[^.]+$/, "");
      p = loadModelUrl("/Models/" + encodeURIComponent(name))
        .then(function (root) {
          return collectMeshNames(root, base);
        })
        .catch(function (e) {
          delete cache[name];
          throw e;
        });
      cache[name] = p;
    }
    return p.then(function (list) {
      currentModel = name;
      currentList = list;
      window.__TSModelObjects.current = list;
      notify();
      return list;
    });
  }

  function notify() {
    refreshCbs.forEach(function (cb) {
      try {
        cb(currentList);
      } catch (e) { }
    });
  }

  // 暴露给经典脚本的接口（管理页主逻辑）
  window.__TSModelObjects = {
    current: currentList, // 当前模型的物体名列表（经典脚本读取用）
    load: load,
    onRefresh: function (cb) {
      refreshCbs.push(cb);
    },
  };
})();


(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var formPanel = $("formPanel");
  var jsonPanel = $("jsonPanel");
  var settingsPanel = $("settingsPanel");
  var controlPanel = $("controlPanel");
  var catSel = $("catSel");
  var prodList = $("prodList");
  var editor = $("editor");
  var statusEl = $("status");
  var connDot = $("connDot");
  var toastEl = $("toast");
  var statsEl = $("stats");
  var dirtyBadge = $("dirtyBadge");
  var catPos = $("catPos");
  var jsonStatus = $("jsonStatus");
  var iconPreview = $("iconPreview");
  var iconPicker = $("iconPicker");
  var btnToggleIcons = $("btnToggleIcons");
  var clientsPanel = $("clientsPanel");
  var clientListEl = $("clientList");
  var clientsSummaryEl = $("clientsSummary");
  var ctlTargetEl = $("ctlTarget");
  var ctlTargetHintEl = $("ctlTargetHint");
  var uploadPanel = $("uploadPanel");
  var upImageCat = $("upImageCat");
  var upImageProd = $("upImageProd");
  var upImageFile = $("upImageFile");
  var upImageTarget = $("upImageTarget");
  var upImageFiles = $("upImageFiles");
  var btnUpImage = $("btnUpImage");
  var upModelFile = $("upModelFile");
  var upModelFiles = $("upModelFiles");
  var btnUpModel = $("btnUpModel");
  var model = { category: [] }; // 当前编辑中的配置副本（loadConfig/saveConfig 读写）
  var currentCat = 0; // 当前编辑的分类下标
  var mode = "form";
  var editing = false; // 用户正在编辑 → SSE 推送时不覆盖
  var savedToken = localStorage.getItem("ts_admin_token") || "";
  $("token").value = savedToken;
  $("token").addEventListener("change", function () {
    savedToken = $("token").value.trim();
    localStorage.setItem("ts_admin_token", savedToken);
  });

  // ---- 通用 ----
  function toast(msg, ok) {
    toastEl.textContent = msg;
    toastEl.className = "show " + (ok ? "ok" : "err");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.className = "";
    }, 2600);
  }
  function setStatus(text, ok) {
    statusEl.textContent = text;
    connDot.className =
      "dot " + (ok === undefined ? "" : ok ? "on" : "err");
  }
  function countCfg(cfg) {
    var cats =
      cfg && Array.isArray(cfg.category) ? cfg.category.length : 0;
    var prods = 0;
    if (Array.isArray(cfg && cfg.category)) {
      cfg.category.forEach(function (c) {
        prods += c.product ? c.product.length : 0;
      });
    }
    return { cats: cats, prods: prods };
  }

  // 标记“未保存更改”：同步 editing 状态与顶栏提示徽标
  function markDirty(on) {
    editing = !!on;
    dirtyBadge.style.display = editing ? "" : "none";
  }

  // JSON 模式语法实时校验
  function updateJsonStatus() {
    var v = editor.value;
    if (!v || !v.trim()) {
      jsonStatus.textContent = "";
      jsonStatus.className = "";
      return;
    }
    try {
      JSON.parse(v);
      jsonStatus.textContent = "✓ JSON 语法合法";
      jsonStatus.className = "ok";
    } catch (e) {
      jsonStatus.textContent = "✗ JSON 语法错误：" + e.message;
      jsonStatus.className = "err";
    }
  }

  // 任何输入视为“正在编辑”（排除令牌框/串口测试框/远程控制目标下拉/上传面板控件）
  document.addEventListener("input", function (e) {
    if (
      e.target &&
      (e.target.id === "token" ||
        e.target.id === "serialTestData" ||
        e.target.id === "ctlTarget" ||
        e.target.id === "upImageCat" ||
        e.target.id === "upImageProd")
    )
      return;
    markDirty(true);
  });
  document.addEventListener("change", function (e) {
    if (!e.target) return;
    var id = e.target.id;
    if (
      id === "catSel" ||
      id === "token" ||
      id === "serialTestData" ||
      id === "ctlTarget" || // 远程控制「目标屏幕」下拉属于控制 UI，不计为未保存
      id === "upImageCat" ||
      id === "upImageProd" ||
      id === "upImageFile" ||
      id === "upModelFile" // 上传面板控件：上传本身不改配置
    )
      return;
    markDirty(true);
  });

  // ---- 标签页切换：分类与产品 / JSON 模式 / 设置 / 远程控制 ----
  function switchTab(m) {
    if (mode === "form") commitForm(); // 离开表单页前提交当前分类
    mode = m;
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === m);
    });
    formPanel.style.display = m === "form" ? "" : "none";
    jsonPanel.style.display = m === "json" ? "" : "none";
    settingsPanel.style.display = m === "settings" ? "" : "none";
    uploadPanel.style.display = m === "upload" ? "" : "none";
    controlPanel.style.display = m === "control" ? "" : "none";
    clientsPanel.style.display = m === "clients" ? "" : "none";
    if (m === "json") {
      editor.value = JSON.stringify(model, null, 4);
      updateJsonStatus();
    } else {
      // 从 JSON 编辑器切回：若 JSON 合法则同步到 model
      var parsed = null;
      try {
        parsed = JSON.parse(editor.value);
      } catch (e) {
        parsed = null;
      }
      if (parsed && Array.isArray(parsed.category)) model = parsed;
      if (currentCat >= model.category.length)
        currentCat = model.category.length - 1;
      if (currentCat < 0) currentCat = 0;
      renderCatSelect();
      renderForm();
      renderSerialForm();
      renderDisplayModeSel();
    }
    if (m === "control") renderControlPanel();
    if (m === "clients") {
      renderClients(currentClients);
      requestClients(); // 进入页面主动拉取最新在线列表
    }
    if (m === "upload") renderUploadPanel();
  }
  document.querySelectorAll(".tab-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      switchTab(this.getAttribute("data-tab"));
    });
  });

  // ---- 表单 → model ----
  function commitForm() {
    if (currentCat < 0 || currentCat >= model.category.length) return;
    var cat = model.category[currentCat];
    cat.label = $("catLabel").value.trim();
    var dir = $("catDir").value.trim();
    if (dir) cat.dir = dir; // 仅非空时写入（保持 config 干净，缺省回退 label）
    else delete cat.dir;
    cat.icon = $("catIcon").value.trim();
    cat.description = $("catDesc").value;
    var products = [];
    prodList.querySelectorAll(".prod-item").forEach(function (row) {
      var p = {
        label: row.querySelector(".p-label").value.trim(),
        action: row.querySelector(".p-action").value.trim(),
        image: row.querySelector(".p-image").value.trim(),
        description: row.querySelector(".p-desc").value,
      };
      var obj = row.querySelector(".p-object").value.trim();
      if (obj) p.object = obj; // 仅非空时写入（保持 config 干净）
      var rot = parseFloat(row.querySelector(".p-rotate").value);
      if (Number.isFinite(rot) && rot !== 0) p.rotate = rot; // 仅非 0 角度写入（0 = 默认不旋转）
      if (p.label || p.action) products.push(p); // 空行视为删除
    });
    cat.product = products;
  }

  // 当前分类的资源目录名（dir 优先，缺省回退分类名称 label）
  function currentCatDir() {
    var cat = model.category[currentCat];
    if (!cat) return "";
    var d = (cat.dir || "").trim();
    return d || (cat.label || "").trim();
  }

  // ---- 分类下拉 ----
  function renderCatSelect() {
    catSel.innerHTML = "";
    model.category.forEach(function (c, i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent =
        (c.label || "分类" + (i + 1)) +
        "（" +
        (c.product ? c.product.length : 0) +
        "）";
      catSel.appendChild(opt);
    });
    if (model.category.length === 0) {
      var opt = document.createElement("option");
      opt.value = "-1";
      opt.textContent = "（暂无分类）";
      catSel.appendChild(opt);
    }
    var idx = Math.min(
      Math.max(currentCat, 0),
      Math.max(model.category.length - 1, -1),
    );
    currentCat = idx;
    catSel.value = String(idx);
    catPos.textContent =
      model.category.length === 0
        ? ""
        : currentCat + 1 + " / " + model.category.length;
  }

  // ---- 产品行 ----
  function buildProductRow(p, i) {
    var row = document.createElement("div");
    row.className = "prod-item";
    row.innerHTML =
      '<div class="prod-head"><span class="prod-idx">' +
      (i + 1) +
      "</span>" +
      '<span class="prod-title"></span>' +
      '<button class="small btn-del">✕ 删除</button></div>' +
      '<div class="prod-cols">' +
      '<div class="prod-left">' +
      '<div class="field"><label>名称</label><input type="text" class="p-label" /></div>' +
      '<div class="field"><label>动作 action</label><input type="text" class="p-action" /></div>' +
      '<div class="field"><label>图片路径（可从分类目录直接选择）</label>' +
      '<div class="p-image-row"><input type="text" class="p-image" /><img class="p-thumb hidden" alt="预览" /></div>' +
      '<select class="p-image-pick"></select>' +
      "</div>" +
      '<div class="field"><label>模型物体（可选，下拉为当前模型内的物体名）</label><select class="p-object"></select></div>' +
      '<div class="field"><label>观看角度（可选，度，0 不旋转）</label><input type="number" class="p-rotate" /></div>' +
      "</div>" +
      '<div class="prod-right">' +
      '<div class="field"><label>描述</label><textarea class="p-desc"></textarea></div>' +
      "</div>" +
      "</div>" +
      "</div>";
    row.querySelector(".p-label").value = p.label || "";
    row.querySelector(".p-action").value = p.action || "";
    row.querySelector(".p-image").value = p.image || "";
    fillObjectOptions(row.querySelector(".p-object"), p.object || "");
    row.querySelector(".p-rotate").value =
      p.rotate !== undefined ? String(p.rotate) : "";
    row.querySelector(".p-desc").value = p.description || "";
    var title = row.querySelector(".prod-title");
    title.textContent = p.label || "(未命名)";
    row.querySelector(".p-label").addEventListener("input", function () {
      title.textContent = this.value || "(未命名)";
    });
    // 图片路径实时预览：能加载则显示缩略图，否则隐藏
    var imgInput = row.querySelector(".p-image");
    var thumb = row.querySelector(".p-thumb");
    thumb.onerror = function () {
      thumb.classList.add("hidden");
    };
    function updateThumb() {
      var v = imgInput.value.trim();
      if (!v) {
        thumb.classList.add("hidden");
        thumb.removeAttribute("src");
        return;
      }
      thumb.src = v;
      thumb.classList.remove("hidden");
    }
    imgInput.addEventListener("input", updateThumb);
    updateThumb();
    // 目录图片快选：从当前分类目录（products/<目录名称>/）选图，选中即写入图片路径
    row.querySelector(".p-image-pick").addEventListener("change", function () {
      if (!this.value) return;
      imgInput.value = this.value;
      updateThumb();
    });
    row.querySelector(".btn-del").addEventListener("click", function () {
      row.remove();
      refreshIdx();
    });
    return row;
  }
  function refreshIdx() {
    prodList.querySelectorAll(".prod-item").forEach(function (row, i) {
      row.querySelector(".prod-idx").textContent = String(i + 1);
    });
  }
  function renderProducts(products) {
    prodList.innerHTML = "";
    if (!products || products.length === 0) {
      prodList.innerHTML =
        '<div class="empty">该分类下暂无产品，点击右上角「＋ 添加产品」</div>';
      $("prodCount").textContent = "";
      return;
    }
    products.forEach(function (p, i) {
      prodList.appendChild(buildProductRow(p, i));
    });
    $("prodCount").textContent = "共 " + products.length + " 项";
    refreshObjectSelects();
    fillImagePickOptions(currentCatDir()); // 按当前分类目录填充图片快选
  }

  // 填充所有产品行的「目录图片快选」下拉（拉取 products/<目录名称>/ 下的图片文件）
  function fillImagePickOptions(dir) {
    if (!prodList) return;
    var selects = prodList.querySelectorAll(".p-image-pick");
    var apply = function (files) {
      selects.forEach(function (sel) {
        var row = sel.closest(".prod-item");
        var cur = row ? (row.querySelector(".p-image").value || "").trim() : "";
        var base = dir ? "/products/" + dir + "/" : "";
        sel.innerHTML = "";
        var opt = document.createElement("option");
        opt.value = "";
        opt.textContent = dir
          ? "（从分类目录选择图片…）"
          : "（先在上方填写目录名称）";
        sel.appendChild(opt);
        (files || []).forEach(function (name) {
          var o = document.createElement("option");
          o.value = base + name;
          o.textContent = name;
          sel.appendChild(o);
          if (cur === base + name) sel.value = o.value; // 当前图片在目录中则预选
        });
        // 当前图片不在该目录（如手填了其他路径）时保留显示，避免误判
        if (cur && sel.value === "") {
          var keep = document.createElement("option");
          keep.value = cur;
          keep.textContent = "（当前）" + cur;
          sel.appendChild(keep);
          sel.value = cur;
        }
      });
    };
    if (!dir) {
      apply([]);
      return;
    }
    fetch("/api/files?kind=image&category=" + encodeURIComponent(dir), {
      cache: "no-store",
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        apply(d.ok ? d.files : []);
      })
      .catch(function () {
        apply([]);
      });
  }

  // ---- 模型物体下拉框（从当前 3D 模型枚举物体名）----
  // 填充单个“模型物体”下拉框：占位项 + 物体名列表，并尽量恢复已选值
  function fillObjectOptions(sel, value) {
    var names =
      (window.__TSModelObjects && window.__TSModelObjects.current) || [];
    sel.innerHTML = "";
    var opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（无，不关联模型物体）";
    sel.appendChild(opt);
    names.forEach(function (n) {
      var o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    // 首次渲染时模型可能仍在异步解析，先保留配置中的值，避免浏览器将其重置为空
    if (value && names.length === 0) {
      var pending = document.createElement("option");
      pending.value = value;
      pending.textContent = value;
      sel.appendChild(pending);
    }
    if (value) sel.value = value; // 列表不含该值（如已切换模型）时自动回退“（无）”
  }

  // 重新填充所有“模型物体”下拉框（模型物体列表变化 / 产品行重绘后调用），保留每行已选值
  function refreshObjectSelects() {
    prodList.querySelectorAll(".p-object").forEach(function (sel) {
      fillObjectOptions(sel, sel.value);
    });
  }

  // 确保当前模型（model.model）的物体列表已加载；加载完成或列表变化时自动刷新所有下拉
  function ensureModelObjectsLoaded() {
    var mo = window.__TSModelObjects;
    if (!mo) return; // 模块脚本未就绪（three.js 尚未加载），由 DOMContentLoaded 兜底重试
    if (!mo._hooked) {
      mo._hooked = true;
      mo.onRefresh(refreshObjectSelects); // 模型物体解析完成后自动刷新下拉
    }
    var name =
      typeof model.model === "string" && model.model.trim()
        ? model.model.trim()
        : DEFAULT_MODEL_FILE;
    mo.load(name)
      .then(refreshObjectSelects)
      .catch(function (e) {
        console.error("[admin] 解析模型物体失败：", e);
      });
  }

  // ---- 图标面板：点击选择 / 高亮，兼容旧数据中不在列表里的自定义图标 ----
  function renderIconPreview(host, val) {
    val = (val || "").trim();
    host.textContent = "";
    if (!val) return;
    if (val.indexOf("/") === 0 || /\.svg$/i.test(val)) {
      var image = document.createElement("img");
      image.src = val;
      image.alt = "";
      host.appendChild(image);
    } else {
      host.textContent = val;
    }
  }

  function setIconSelect(val) {
    var hidden = $("catIcon");
    val = (val || "").trim();
    hidden.value = val;
    renderIconPreview(iconPreview, val);
    var picker = $("iconPicker");
    var matched = null;
    picker.querySelectorAll(".icon-item").forEach(function (el) {
      var active = el.getAttribute("data-icon") === (val || "");
      el.classList.toggle("active", active);
      if (active) matched = el;
    });
    if (val && !matched) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-item active";
      btn.setAttribute("data-icon", val);
      renderIconPreview(btn, val);
      btn.addEventListener("click", function () {
        hidden.value = val;
        picker.querySelectorAll(".icon-item").forEach(function (x) {
          x.classList.toggle("active", x === btn);
        });
        markDirty(true);
        renderIconPreview(iconPreview, val);
      });
      picker.appendChild(btn);
    }
  }

  // 初始化：为图标面板每一项绑定点击选择（选择后标记未保存、自动收起）
  (function initIconPicker() {
    var hidden = $("catIcon");
    var picker = $("iconPicker");
    picker.innerHTML = "";
    [
      ["/icons/category-fire.svg", "防火系统"],
      ["/icons/category-oxygen.svg", "氧气惰化"],
      ["/icons/category-brake.svg", "刹车系统"],
      ["/icons/category-sensor.svg", "传感器"],
      ["/icons/category-recorder.svg", "记录器"],
      ["/icons/category-lighting.svg", "照明控制"],
      ["/icons/category-filter.svg", "滤芯活门"],
      ["/icons/category-hud.svg", "平视显示器"],
    ].forEach(function (item) {
      var option = document.createElement("button");
      option.type = "button";
      option.className = "icon-item";
      option.setAttribute("data-icon", item[0]);
      option.title = item[1];
      renderIconPreview(option, item[0]);
      picker.appendChild(option);
    });
    var emptyOption = document.createElement("button");
    emptyOption.type = "button";
    emptyOption.className = "icon-item";
    emptyOption.setAttribute("data-icon", "");
    emptyOption.title = "不设置";
    emptyOption.textContent = "无";
    picker.insertBefore(emptyOption, picker.firstChild);
    // 按钮首文本节点（“▾ 选择图标 ”/“▴ 收起图标”），只改文本、保留 iconPreview 元素
    var toggleText = btnToggleIcons.firstChild;
    picker.querySelectorAll(".icon-item").forEach(function (el) {
      el.addEventListener("click", function () {
        var v = el.getAttribute("data-icon") || "";
        hidden.value = v;
        picker.querySelectorAll(".icon-item").forEach(function (x) {
          x.classList.toggle("active", x === el);
        });
        markDirty(true);
        renderIconPreview(iconPreview, v);
        // 选择后自动收起面板，节省空间
        picker.classList.add("collapsed");
        toggleText.textContent = "▾ 选择图标 ";
      });
    });
    btnToggleIcons.addEventListener("click", function () {
      var collapsed = picker.classList.toggle("collapsed");
      toggleText.textContent = collapsed ? "▾ 选择图标 " : "▴ 收起图标";
    });
  })();

  // ---- 渲染当前分类表单 ----
  function renderForm() {
    if (currentCat < 0 || currentCat >= model.category.length) {
      $("catLabel").value = "";
      $("catDir").value = "";
      $("catDesc").value = "";
      setIconSelect("");
      renderProducts([]);
      $("btnAddProd").disabled = true;
      catPos.textContent = "";
      return;
    }
    $("btnAddProd").disabled = false;
    var cat = model.category[currentCat];
    $("catLabel").value = cat.label || "";
    $("catDir").value = cat.dir || "";
    setIconSelect(cat.icon || "");
    $("catDesc").value = cat.description || "";
    renderProducts(cat.product || []);
    catPos.textContent = currentCat + 1 + " / " + model.category.length;
  }

  // ---- 事件：分类下拉 / 增删 ----
  catSel.addEventListener("change", function () {
    commitForm();
    currentCat = parseInt(this.value, 10) || 0;
    if (currentCat < 0) currentCat = 0;
    renderForm();
  });
  $("btnPrevCat").addEventListener("click", function () {
    if (model.category.length === 0) return;
    commitForm();
    currentCat =
      (currentCat - 1 + model.category.length) % model.category.length;
    renderCatSelect();
    renderForm();
  });
  $("btnNextCat").addEventListener("click", function () {
    if (model.category.length === 0) return;
    commitForm();
    currentCat = (currentCat + 1) % model.category.length;
    renderCatSelect();
    renderForm();
  });
  $("btnAddCat").addEventListener("click", function () {
    commitForm();
    model.category.push({
      label: "新分类",
      icon: "📁",
      description: "",
      product: [],
    });
    currentCat = model.category.length - 1;
    renderCatSelect();
    renderForm();
    markDirty(true);
  });
  $("btnDelCat").addEventListener("click", function () {
    if (currentCat < 0 || currentCat >= model.category.length) return;
    if (
      !confirm(
        "确定删除分类「" +
        (model.category[currentCat].label || "未命名") +
        "」及其所有产品？",
      )
    )
      return;
    commitForm();
    model.category.splice(currentCat, 1);
    if (currentCat >= model.category.length)
      currentCat = model.category.length - 1;
    renderCatSelect();
    renderForm();
    markDirty(true);
  });
  $("btnAddProd").addEventListener("click", function () {
    commitForm();
    if (currentCat < 0 || currentCat >= model.category.length) return;
    model.category[currentCat].product.push({
      label: "",
      action: "",
      image: "",
      description: "",
    });
    renderProducts(model.category[currentCat].product);
    markDirty(true);
  });

  // ---- 加载 / 保存 ----
  function loadConfig(notify) {
    return fetch("/api/config", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (cfg) {
        model = cfg;
        if (currentCat >= model.category.length)
          currentCat = model.category.length - 1;
        if (currentCat < 0) currentCat = 0;
        renderCatSelect();
        renderForm();
        renderSerialForm();
        renderModelField();
        ensureModelObjectsLoaded(); // 模型可能变化 → 重新枚举物体供下拉
        renderDisplayModeSel();
        if (mode === "control") renderControlPanel(); // 远程控制列表随配置实时刷新
        if (mode === "upload") renderUploadPanel(); // 上传面板的分类/目录下拉随配置实时刷新
        editor.value = JSON.stringify(model, null, 4);
        updateJsonStatus();
        markDirty(false); // 已与服务器同步，清除“未保存”提示
        var c = countCfg(model);
        statsEl.textContent =
          "共 " +
          c.cats +
          " 个分类 / " +
          c.prods +
          " 个产品 · 服务器时间 " +
          new Date().toLocaleTimeString();
        // 若 SSE 推送已连接则显示连接态，否则显示“已加载”（避免覆盖 onopen 的连接状态）
        setStatus(
          ws && ws.readyState === WebSocket.OPEN
            ? "已连接实时推送"
            : "已加载",
          true,
        );
        if (notify) toast("已从服务器加载最新配置", true);
      })
      .catch(function (e) {
        setStatus("加载失败", false);
        if (notify) toast("加载失败：" + e.message, false);
      });
  }

  function saveConfig() {
    var payload;
    if (mode === "json") {
      try {
        payload = JSON.parse(editor.value);
      } catch (e) {
        return toast("JSON 语法错误：" + e.message, false);
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !Array.isArray(payload.category)
      ) {
        return toast(
          "格式错误：顶层必须是包含 category 数组的对象",
          false,
        );
      }
    } else {
      commitForm();
      payload = JSON.parse(JSON.stringify(model));
    }
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    fetch("/api/config", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok)
              throw new Error(data.error || "HTTP " + res.status);
            return data;
          });
      })
      .then(function () {
        model = payload;
        markDirty(false);
        editor.value = JSON.stringify(model, null, 4);
        updateJsonStatus();
        renderModelField();
        ensureModelObjectsLoaded(); // JSON 模式可能改了 model 字段 → 重新枚举物体
        renderDisplayModeSel();
        if (mode === "upload") renderUploadPanel(); // 目录名称可能变化 → 刷新上传面板
        var c = countCfg(model);
        statsEl.textContent =
          "共 " +
          c.cats +
          " 个分类 / " +
          c.prods +
          " 个产品 · 已保存 " +
          new Date().toLocaleTimeString();
        setStatus("已保存并推送", true);
        toast("已保存并推送到所有屏幕", true);
      })
      .catch(function (e) {
        toast("保存失败：" + e.message, false);
      });
  }

  $("btnSave").addEventListener("click", saveConfig);
  $("btnReload").addEventListener("click", function () {
    loadConfig(true);
  });
  $("btnFormat").addEventListener("click", function () {
    try {
      editor.value = JSON.stringify(JSON.parse(editor.value), null, 4);
      toast("已格式化", true);
    } catch (e) {
      toast("JSON 语法错误，无法格式化", false);
    }
  });
  // JSON 编辑器输入时实时校验语法
  editor.addEventListener("input", updateJsonStatus);
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveConfig();
    }
  });

  // ---- WebSocket 实时通道（管理页：订阅 config-changed / clients；断线指数退避重连）----
  var ws = null;
  var wasDown = false;
  var retryDelay = 1000; // 初始重连间隔（ms）
  var retryTimer = null;
  // 断开/重连状态延迟显示：短暂抖动（< 1.5s 内恢复）不闪烁提示，仅在持续断线时告知
  var statusTimer = null;
  var currentClients = []; // 最近一次 clients 事件里的在线客户端列表（role/name/ip/…）

  function showStatusDelayed(text, ok, delay) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      setStatus(text, ok);
    }, delay || 1500);
  }

  // 管理页实时地址：/api/ws?role=admin（展示屏连 ?role=screen）
  function liveUrl() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/api/ws?role=admin";
  }

  // 渲染「客户端」页：分组统计展示屏 / 管理页，逐行显示类型、名称、IP、连接时长、UA
  function renderClients(list) {
    var rows = Array.isArray(list) ? list : [];
    var screens = rows.filter(function (c) {
      return c.role !== "admin";
    });
    var admins = rows.filter(function (c) {
      return c.role === "admin";
    });
    clientsSummaryEl.textContent =
      "展示屏 " + screens.length + " 台 · 管理页 " + admins.length + " 个";

    var el = clientListEl;
    el.innerHTML = "";
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty">（当前无客户端连接）</div>';
      return;
    }
    var dur = function (sec) {
      if (sec == null) return "";
      if (sec < 60) return sec + " 秒";
      if (sec < 3600)
        return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
      return (
        Math.floor(sec / 3600) +
        " 时 " +
        Math.floor((sec % 3600) / 60) +
        " 分"
      );
    };
    rows.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "client-row";
      var roleTag =
        '<span class="client-tag ' +
        (c.role === "admin" ? "admin" : "screen") +
        '">' +
        (c.role === "admin" ? "管理页" : "展示屏") +
        "</span>";
      var name = c.name
        ? '<span class="client-name"></span>'
        : "";
      row.innerHTML =
        '<span class="client-dot"></span>' +
        roleTag +
        name +
        '<span class="client-now"></span>' +
        '<span class="client-meta">' +
        (c.ip || "?") +
        (c.role === "admin" ? "" : " · 连接 " + dur(c.ageSec)) +
        (c.ua ? " · " + String(c.ua).slice(0, 40) : "") +
        "</span>";
      if (c.name) {
        var nameEl = row.querySelector(".client-name");
        nameEl.textContent = c.name; // 名称可能含特殊字符，用 textContent 注入
      }
      var cur = c.current || null;
      if (c.role !== "admin") {
        var nowEl = row.querySelector(".client-now");
        nowEl.textContent = cur && cur.category
          ? cur.category + (cur.product ? " / " + cur.product : "")
          : "（未展示）";
      }
      el.appendChild(row);
    });
  }

  // 渲染「目标屏幕」下拉：全部展示屏（广播）+ 各在线展示屏（仅显示名称或 IP）
  function renderCtlTarget() {
    var cur = ctlTargetEl.value;
    var screens = (currentClients || []).filter(function (c) {
      return c.role === "screen";
    });
    var opts = [{ id: "all", label: "全部展示屏（广播）" }];
    screens.forEach(function (c) {
      opts.push({ id: c.id, label: c.name || c.ip || "展示屏" });
    });
    ctlTargetEl.innerHTML = "";
    opts.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.label;
      ctlTargetEl.appendChild(opt);
    });
    if (
      cur &&
      cur !== "all" &&
      opts.some(function (o) {
        return o.id === cur;
      })
    )
      ctlTargetEl.value = cur;
    ctlTargetHintEl.textContent =
      screens.length === 0 ? "（当前无在线展示屏）" : "";
  }

  // 主动请求最新客户端列表（进入「客户端」页 / 连接恢复时）
  function requestClients() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "get-clients" }));
      } catch (e) { }
    }
  }

  function connectLive() {
    if (ws) {
      try {
        ws.close();
      } catch (e) { }
    }
    ws = new WebSocket(liveUrl());
    ws.onopen = function () {
      var was = wasDown;
      wasDown = false;
      retryDelay = 1000; // 连接成功，重置退避
      clearTimeout(statusTimer); // 已恢复 → 取消待显示的“断开”提示，避免闪一下
      setStatus("已连接实时推送", true);
      // 断线期间可能错过推送：恢复后立即补拉一次（用户在编辑则跳过，避免覆盖表单）
      if (was && !editing) loadConfig(false);
      requestClients(); // 恢复后主动拉一次客户端列表
    };
    ws.onmessage = function (e) {
      var msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "config-changed") {
        if (editing) return;
        loadConfig(false);
      } else if (msg.type === "clients") {
        currentClients = Array.isArray(msg.data) ? msg.data : [];
        if (mode === "clients") renderClients(currentClients);
        if (mode === "control") renderCtlTarget(); // 目标屏下拉随在线屏实时更新
      }
    };
    ws.onclose = function () {
      wasDown = true;
      try {
        ws.close();
      } catch (e) { }
      ws = null;
      showStatusDelayed("推送连接已断开，正在重连…", false);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connectLive, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
    ws.onerror = function () {
      // onerror 后通常触发 onclose；主动关闭进入统一重连
      try {
        ws.close();
      } catch (e) { }
    };
  }
  connectLive();

  // ================== 串口设置 ==================
  var serialStatusEl = $("serialStatus");
  var serialDetailEl = $("serialDetail");
  var serialPortEl = $("serialPort");
  var serialTestDataEl = $("serialTestData");

  // 串口表单控件 id → model.serial 字段映射（保存时随配置一起提交）
  var SERIAL_FIELDS = {
    serialEnabled: {
      key: "enabled",
      get: function (el) {
        return el.checked;
      },
    },
    serialPort: {
      key: "port",
      get: function (el) {
        return el.value;
      },
    },
    serialBaud: {
      key: "baudRate",
      get: function (el) {
        return parseInt(el.value, 10) || 9600;
      },
    },
    serialDataBits: {
      key: "dataBits",
      get: function (el) {
        return parseInt(el.value, 10) || 8;
      },
    },
    serialStopBits: {
      key: "stopBits",
      get: function (el) {
        return parseFloat(el.value) || 1;
      },
    },
    serialParity: {
      key: "parity",
      get: function (el) {
        return el.value;
      },
    },
    serialTemplate: {
      key: "template",
      get: function (el) {
        return el.value;
      },
    },
  };

  // 模板显示为转义形式（\r \n \t），避免真实换行被浏览器从 input 中剥离，
  // 保存到 config.json 的也是转义形式，服务端 buildSerialMessage 会再还原
  function escapeTemplate(t) {
    return String(t)
      .replace(/\\/g, "\\\\")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
  }

  // 从 model 填充串口表单（model 无 serial 段时用缺省值）
  function renderSerialForm() {
    if (!model.serial || typeof model.serial !== "object")
      model.serial = {};
    var s = model.serial;
    $("serialEnabled").checked = !!s.enabled;
    serialPortEl.value = s.port || "";
    $("serialBaud").value = String(s.baudRate || 9600);
    $("serialDataBits").value = String(s.dataBits || 8);
    $("serialStopBits").value = String(s.stopBits || 1);
    $("serialParity").value = s.parity || "none";
    $("serialTemplate").value = escapeTemplate(
      s.template !== undefined ? s.template : "{action}\r\n",
    );
  }

  // ---- 3D 模型文件名 ----
  var DEFAULT_MODEL_FILE = "C919.glb";

  // 从 model 填充模型下拉框（缺省回退 C919.glb），并从服务器拉取 Models 目录文件列表
  function renderModelField() {
    var cur =
      typeof model.model === "string" && model.model.trim()
        ? model.model.trim()
        : DEFAULT_MODEL_FILE;
    var sel = $("modelFile");
    fetch("/api/models", { cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (d) {
        var list = (d && d.models) || [];
        if (list.indexOf(cur) < 0) list.unshift(cur); // 当前值不在列表时保留选项
        if (list.length === 0) list.push(DEFAULT_MODEL_FILE);
        sel.innerHTML = "";
        list.forEach(function (name) {
          var opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        });
        sel.value = cur;
      })
      .catch(function () {
        sel.value = cur;
      });
  }

  // 选择 → 写回 model.model（全局 change 监听已负责标记“未保存”）
  $("modelFile").addEventListener("change", function () {
    model.model = this.value;
    ensureModelObjectsLoaded(); // 切换模型 → 重新枚举物体并刷新下拉
  });

  // ---- 展示模式 ----
  // 可选展示模式（与展示屏 src/config.ts 白名单一致）
  var DISPLAY_MODE_OPTIONS = ["image", "model"];

  // 从 model 填充展示模式下拉（model 无 displayMode 或值非法时回退图片模式）
  function renderDisplayModeSel() {
    var v = model.displayMode;
    if (DISPLAY_MODE_OPTIONS.indexOf(v) < 0) v = "image";
    $("displayModeSel").value = v;
  }

  // 选择 → 写回 model.displayMode（全局 change 监听已负责标记“未保存”）
  $("displayModeSel").addEventListener("change", function () {
    model.displayMode = this.value;
  });

  // ---- 远程控制（切换分类/产品显示，不修改已保存配置；可定向单台屏）----
  // 发送远程控制命令：POST /api/control；带目标屏 id 则仅该屏响应，否则广播
  function currentTargetLabel() {
    if (
      !ctlTargetEl ||
      !ctlTargetEl.selectedOptions ||
      !ctlTargetEl.selectedOptions[0]
    )
      return "";
    return ctlTargetEl.selectedOptions[0].textContent || "";
  }

  function sendControl(payload) {
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    // 附带目标：select 值为屏 id（"all"/缺省 = 广播到所有屏）
    var targetId = ctlTargetEl ? ctlTargetEl.value : "all";
    if (targetId && targetId !== "all") payload.targetClientId = targetId;
    fetch("/api/control", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok)
              throw new Error(data.error || "HTTP " + res.status);
            return data;
          });
      })
      .then(function () {
        var name;
        if (payload.action === "sidebar") {
          name = payload.visible ? "显示侧边栏" : "隐藏侧边栏";
        } else {
          var cat = model.category[payload.category];
          name = (cat && cat.label) || "分类" + (payload.category + 1);
          if (
            payload.action === "product" &&
            cat &&
            cat.product[payload.product]
          )
            name += " / " + cat.product[payload.product].label;
        }
        var to = currentTargetLabel() || "全部展示屏";
        toast("已推送至 " + to + "：" + name, true);
      })
      .catch(function (e) {
        toast("切换失败：" + e.message, false);
      });
  }

  // ---- 侧边栏菜单 显示/隐藏（广播 sidebar 命令到所有展示屏）----
  $("btnSidebarShow").addEventListener("click", function () {
    sendControl({ action: "sidebar", visible: true });
  });
  $("btnSidebarHide").addEventListener("click", function () {
    sendControl({ action: "sidebar", visible: false });
  });

  // 渲染远程控制列表：按分类分组列出全部产品，每个产品一个按钮；点击分类名仅切换该分类
  function renderControlPanel() {
    renderCtlTarget(); // 目标屏幕下拉随在线屏刷新
    var list = $("ctlList");
    list.innerHTML = "";
    if (model.category.length === 0) {
      list.innerHTML = '<div class="empty">（暂无分类）</div>';
      return;
    }
    model.category.forEach(function (c, i) {
      var group = document.createElement("div");
      group.className = "ctl-group";

      var head = document.createElement("button");
      head.type = "button";
      head.className = "ctl-cat";
      head.title = "切换到此分类（不选产品）";
      head.textContent =
        (c.label || "分类" + (i + 1)) +
        "（" +
        (c.product ? c.product.length : 0) +
        "）";
      head.addEventListener("click", function () {
        sendControl({ action: "category", category: i });
      });
      group.appendChild(head);

      var prods = document.createElement("div");
      prods.className = "ctl-prods";
      (c.product || []).forEach(function (p, j) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ctl-prod";
        btn.textContent = p.label || "产品" + (j + 1);
        btn.title = "切换到此产品";
        btn.addEventListener("click", function () {
          sendControl({ action: "product", category: i, product: j });
        });
        prods.appendChild(btn);
      });
      group.appendChild(prods);
      list.appendChild(group);
    });
  }

  // 监听串口表单改动 → 写回 model.serial（全局 input/change 监听已负责标记未保存）
  Object.keys(SERIAL_FIELDS).forEach(function (id) {
    var el = $(id);
    var meta = SERIAL_FIELDS[id];
    var apply = function () {
      if (!model.serial || typeof model.serial !== "object")
        model.serial = {};
      model.serial[meta.key] = meta.get(el);
    };
    el.addEventListener("input", apply);
    el.addEventListener("change", apply);
  });

  // 刷新端口下拉列表
  function refreshSerialPorts(keepCurrent) {
    var cur = serialPortEl.value;
    fetch("/api/serial/ports", { cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (d) {
        var ports = (d && d.ports) || [];
        serialPortEl.innerHTML = "";
        if (ports.length === 0) {
          var opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "（未检测到串口）";
          serialPortEl.appendChild(opt);
        } else {
          ports.forEach(function (p) {
            var opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            serialPortEl.appendChild(opt);
          });
        }
        if (keepCurrent && cur) serialPortEl.value = cur;
        else if (model.serial && model.serial.port)
          serialPortEl.value = model.serial.port;
      })
      .catch(function () { });
  }

  // 轮询串口连接状态（状态栏：圆点 + 状态 + 详情 + 连接/断开按钮态）
  function refreshSerialStatus() {
    fetch("/api/serial/status", { cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (d) {
        var dot = $("serialDot");
        if (d.connected) {
          dot.className = "s-dot on";
          serialStatusEl.textContent = "已连接";
          serialDetailEl.textContent =
            (d.port || "") +
            " @ " +
            (d.baudRate || "") +
            " 波特" +
            (d.lastSend
              ? " · 最近发送 " +
              new Date(d.lastSend.time).toLocaleTimeString()
              : "");
          $("btnSerialConnect").disabled = true;
          $("btnSerialDisconnect").disabled = false;
        } else if (d.error) {
          dot.className = "s-dot err";
          serialStatusEl.textContent = "连接失败";
          serialDetailEl.textContent = d.error;
          $("btnSerialConnect").disabled = false;
          $("btnSerialDisconnect").disabled = true;
        } else {
          dot.className = "s-dot";
          serialStatusEl.textContent = "未连接";
          serialDetailEl.textContent = d.workerAlive
            ? "串口服务已就绪，选择端口后点「连接」"
            : "";
          $("btnSerialConnect").disabled = false;
          $("btnSerialDisconnect").disabled = true;
        }
      })
      .catch(function () { });
  }

  // 连接 / 断开 / 测试发送
  $("btnSerialConnect").addEventListener("click", function () {
    var payload = {
      serial: {
        enabled: $("serialEnabled").checked,
        port: serialPortEl.value,
        baudRate: parseInt($("serialBaud").value, 10) || 9600,
        dataBits: parseInt($("serialDataBits").value, 10) || 8,
        stopBits: parseFloat($("serialStopBits").value) || 1,
        parity: $("serialParity").value,
        template: $("serialTemplate").value,
      },
    };
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    fetch("/api/serial/connect", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (d) {
        refreshSerialStatus();
        toast(
          d.connected
            ? "✅ 已连接 " + (d.port || "")
            : "连接失败：" + (d.error || "未知错误"),
          !!d.connected,
        );
      })
      .catch(function (e) {
        toast("连接请求失败：" + e.message, false);
      });
  });
  $("btnSerialDisconnect").addEventListener("click", function () {
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    fetch("/api/serial/disconnect", { method: "POST", headers: headers })
      .then(function () {
        refreshSerialStatus();
        toast("已断开串口", true);
      })
      .catch(function (e) {
        toast("断开失败：" + e.message, false);
      });
  });
  $("btnSerialTest").addEventListener("click", function () {
    var data = serialTestDataEl.value.trim();
    if (!data) return toast("请输入测试发送内容", false);
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    fetch("/api/serial/send", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ data: data }),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return {};
        });
      })
      .then(function (d) {
        if (d.ok) toast("已发送 " + (d.len || 0) + " 字节", true);
        else toast("发送失败：" + (d.error || "未知错误"), false);
        refreshSerialStatus();
      })
      .catch(function (e) {
        toast("发送请求失败：" + e.message, false);
      });
  });
  $("btnRefreshPorts").addEventListener("click", function () {
    refreshSerialPorts(true);
    toast("已刷新串口列表", true);
  });

  // 首次加载端口列表 + 轮询状态
  refreshSerialPorts(false);
  refreshSerialStatus();
  setInterval(refreshSerialStatus, 5000);

  // ---- 资源上传（产品图片 / 3D 模型）----
  function uploadAuthHeaders() {
    var h = {};
    if (savedToken) h["x-admin-token"] = savedToken;
    return h;
  }

  // 当前选中的上传分类（下拉 value = 分类下标）与其资源目录名（dir 优先，回退 label）
  function uploadCatIdx() {
    var i = parseInt(upImageCat.value, 10);
    return Number.isFinite(i) && i >= 0 && i < model.category.length ? i : -1;
  }
  function uploadCatDir() {
    var i = uploadCatIdx();
    if (i < 0) return "";
    var c = model.category[i];
    var d = (c.dir || "").trim();
    return d || (c.label || "").trim();
  }

  function hasOption(sel, value) {
    return [].some.call(sel.options, function (o) {
      return o.value === value;
    });
  }

  // 目标产品下拉：跟随所选分类（value 为产品下标，便于精确定位）
  function renderUploadProdSelect() {
    var i = uploadCatIdx();
    var found = i >= 0 ? model.category[i] : null;
    var prev = upImageProd.value;
    upImageProd.innerHTML = "";
    var none = document.createElement("option");
    none.value = "-1";
    none.textContent = "（不绑定，仅上传文件）";
    upImageProd.appendChild(none);
    (found && Array.isArray(found.product) ? found.product : []).forEach(
      function (p, i) {
        var opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = p.label || "(未命名)";
        upImageProd.appendChild(opt);
      },
    );
    if (hasOption(upImageProd, prev)) upImageProd.value = prev;
    updateUploadTargetHint();
  }

  // 上传目标路径预览（选择分类 / 文件、切换产品后更新）
  function updateUploadTargetHint() {
    var def = "支持 png / jpg / jpeg / webp / gif / svg；同名文件直接覆盖";
    if (!upImageTarget) return;
    var f = upImageFile.files && upImageFile.files[0];
    if (uploadCatIdx() < 0) {
      upImageTarget.textContent = def;
      return;
    }
    var base = "/products/" + uploadCatDir() + "/";
    var text = f
      ? "保存到 " + base + f.name
      : "目标目录 " + base + "（目录不存在会自动创建）";
    if (f && upImageProd.value !== "-1") {
      text +=
        "，并将作为「" +
        upImageProd.options[upImageProd.selectedIndex].textContent +
        "」的产品图片";
    }
    upImageTarget.textContent = text;
  }

  // 渲染上传面板：分类 / 产品下拉 + 已有文件列表（切到上传页时调用）
  function renderUploadPanel() {
    var prev = upImageCat.value;
    upImageCat.innerHTML = "";
    if (model.category.length === 0) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "（暂无分类，请先到表单页添加）";
      upImageCat.appendChild(empty);
    } else {
      model.category.forEach(function (c, i) {
        var opt = document.createElement("option");
        opt.value = String(i);
        var dir = (c.dir || "").trim();
        var label = c.label || "分类" + (i + 1);
        opt.textContent =
          dir && dir !== label ? label + "（目录：" + dir + "）" : label;
        upImageCat.appendChild(opt);
      });
      if (hasOption(upImageCat, prev)) upImageCat.value = prev;
    }
    renderUploadProdSelect();
    refreshUploadFiles("image");
    refreshUploadFiles("model");
  }

  // 拉取并渲染文件列表（image → 当前分类目录；model → /Models/）
  function refreshUploadFiles(kind) {
    var box = kind === "image" ? upImageFiles : upModelFiles;
    if (kind === "image" && uploadCatIdx() < 0) {
      box.innerHTML = '<div class="empty">（暂无分类，请先到表单页添加）</div>';
      return;
    }
    var url =
      kind === "image"
        ? "/api/files?kind=image&category=" + encodeURIComponent(uploadCatDir())
        : "/api/files?kind=model";
    if (!box) return;
    fetch(url, { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        box.innerHTML = "";
        if (!d.ok) throw new Error(d.error || "HTTP 错误");
        if (!d.files || d.files.length === 0) {
          box.innerHTML = '<div class="empty">（该目录暂无文件）</div>';
          return;
        }
        d.files.forEach(function (name) {
          var item = document.createElement("div");
          item.className = "up-file";
          var href = d.dir + "/" + encodeURIComponent(name);
          if (kind === "image") {
            item.innerHTML =
              '<img src="' + href + '" alt="" loading="lazy" />' +
              '<a href="' + href + '" target="_blank" rel="noopener"></a>';
          } else {
            item.innerHTML =
              '<a href="' + href + '" target="_blank" rel="noopener"></a>';
          }
          item.querySelector("a").textContent = name;
          box.appendChild(item);
        });
      })
      .catch(function (e) {
        box.innerHTML =
          '<div class="empty">列表加载失败：' + e.message + "</div>";
      });
  }

  // 执行上传：image 需先选分类；成功后刷新列表，选了目标产品则自动绑定 image 字段
  function doUpload(kind) {
    var input = kind === "image" ? upImageFile : upModelFile;
    var btn = kind === "image" ? btnUpImage : btnUpModel;
    var f = input.files && input.files[0];
    if (!f) return toast("请先选择文件", false);
    if (kind === "image" && uploadCatIdx() < 0)
      return toast("请先选择分类（目录 products/<目录名称>/ 会自动创建）", false);
    var fd = new FormData();
    fd.append("kind", kind);
    if (kind === "image") fd.append("category", uploadCatDir());
    fd.append("file", f);
    var prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "上传中…";
    fetch("/api/upload", {
      method: "POST",
      headers: uploadAuthHeaders(),
      body: fd,
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (d) {
            if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
            return d;
          });
      })
      .then(function (d) {
        toast("已上传 " + d.file + " → " + d.path, true);
        input.value = "";
        if (kind === "image" && upImageProd.value !== "-1") {
          bindUploadToProduct(d.path); // 绑定产品并保存推送
        } else {
          refreshUploadFiles(kind);
        }
        updateUploadTargetHint();
      })
      .catch(function (e) {
        toast("上传失败：" + e.message, false);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = prevLabel;
      });
  }

  // 把上传后的图片路径写入所选产品的 image 字段并保存推送（展示屏即时刷新）
  function bindUploadToProduct(path) {
    if (mode !== "json") commitForm(); // 表单模式下先把当前编辑合入 model，避免丢改动
    var ci = uploadCatIdx();
    var cat = ci >= 0 ? model.category[ci] : null;
    var idx = parseInt(upImageProd.value, 10);
    if (!cat || !Array.isArray(cat.product) || !cat.product[idx]) {
      refreshUploadFiles("image");
      return;
    }
    cat.product[idx].image = path;
    var headers = { "Content-Type": "application/json" };
    if (savedToken) headers["x-admin-token"] = savedToken;
    fetch("/api/config", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(model),
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (d) {
            if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
          });
      })
      .then(function () {
        editor.value = JSON.stringify(model, null, 4);
        updateJsonStatus();
        markDirty(false);
        if (mode === "form") {
          renderCatSelect();
          renderForm();
        }
        toast("已绑定到产品并推送到所有屏幕", true);
        refreshUploadFiles("image");
      })
      .catch(function (e) {
        markDirty(true); // 保留待保存状态，用户可手动保存
        toast("图片已上传，但绑定产品失败：" + e.message, false);
        refreshUploadFiles("image");
      });
  }

  // 上传面板交互
  upImageCat.addEventListener("change", function () {
    renderUploadProdSelect();
    refreshUploadFiles("image");
  });
  upImageFile.addEventListener("change", updateUploadTargetHint);
  btnUpImage.addEventListener("click", function () {
    doUpload("image");
  });
  btnUpModel.addEventListener("click", function () {
    doUpload("model");
  });

  // ---- 初始化 ----
  loadConfig(false);
  // 模块脚本（three.js 枚举模型物体）在 DOM 解析完成后执行，晚于本脚本；
  // 故在 DOMContentLoaded（模块脚本已执行）后再加载物体列表，保证 __TSModelObjects 已就绪
  document.addEventListener("DOMContentLoaded", ensureModelObjectsLoaded);
})();

