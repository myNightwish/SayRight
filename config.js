// config.js —— 全站共享的运行期配置，必须最先加载（在 auth.js 和各页脚本之前）。
//
// 收藏始终走同一线上环境；扩展模型请求走本机内网桥接服务。
window.NUANCE_REMOTE_ORIGIN = "https://nuance-drfi.onrender.com";
window.NUANCE_LOCAL_MODEL_ORIGIN = "http://127.0.0.1:48773";
window.NUANCE_MODEL_ORIGIN = location.protocol === "chrome-extension:"
  ? window.NUANCE_LOCAL_MODEL_ORIGIN
  : location.origin;

// H5 移动端共享底栏。Chrome 插件弹窗保持原布局，不注入导航。
(() => {
  if (location.protocol === "chrome-extension:") return;

  const path = location.pathname.replace(/\/+$/, "");
  const page = path.split("/").pop() || "index.html";
  const active = page === "collection.html"
    ? "collection"
    : page === "scene.html"
      ? "scene"
      : page === "chat.html"
        ? "chat"
        : page === "quiz.html"
          ? "quiz"
          : "polish";

  const items = [
    { key: "collection", href: "collection.html", image: "images/mascot-success-v2.png", label: "表达库" },
    { key: "scene", href: "scene.html", image: "images/mascot-study-v2.png", label: "场景" },
    { key: "polish", href: "polish.html", image: "images/mascot-encourage-v2.png", label: "表达", primary: true },
    { key: "chat", href: "chat.html?talk=1", image: "images/mascot-waiting-v2.png", label: "对练" },
    { key: "quiz", href: "quiz.html", image: "images/mascot-thinking-v2.png", label: "练习" },
  ];

  const style = document.createElement("style");
  style.textContent = `
    .nuance-mobile-nav,
    .nuance-quick-entry { display: none; }
    @media (max-width: 768px) {
      body.has-mobile-nav .app,
      body.has-mobile-nav .wrap {
        padding-bottom: calc(98px + env(safe-area-inset-bottom)) !important;
      }
      .nuance-mobile-nav {
        position: fixed;
        z-index: 1000;
        left: max(10px, env(safe-area-inset-left));
        right: max(10px, env(safe-area-inset-right));
        bottom: calc(9px + env(safe-area-inset-bottom));
        height: 68px;
        display: grid;
        grid-template-columns: 1fr 1fr 1.14fr 1fr 1fr;
        align-items: end;
        padding: 6px 8px 7px;
        border: 1px solid rgba(255,255,255,0.86);
        border-radius: 22px;
        background: rgba(252,251,255,0.92);
        box-shadow:
          0 16px 38px rgba(70,40,160,0.2),
          inset 0 1px 0 rgba(255,255,255,0.9);
        backdrop-filter: blur(20px) saturate(165%);
      }
      .nuance-mobile-nav,
      .nuance-mobile-nav * { box-sizing: border-box; }
      .nuance-mobile-nav a {
        position: relative;
        min-width: 0;
        height: 54px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 3px;
        color: #77718f;
        font-size: 10px;
        font-weight: 700;
        line-height: 1;
        text-decoration: none;
        -webkit-tap-highlight-color: transparent;
      }
      .nuance-mobile-nav a[aria-current="page"] { color: #5b3fd6; }
      .nuance-mobile-nav-icon {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px;
        overflow: hidden;
        border-radius: 12px;
        background: rgba(124,92,255,0.06);
        transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
      }
      .nuance-mobile-nav-icon img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 10px;
      }
      .nuance-mobile-nav a[aria-current="page"] .nuance-mobile-nav-icon {
        background: rgba(124,92,255,0.14);
        box-shadow: 0 5px 12px rgba(124,92,255,0.16);
        transform: translateY(-1px);
      }
      .nuance-mobile-nav-label { white-space: nowrap; }
      .nuance-mobile-nav-primary {
        height: 70px;
        transform: translateY(-10px);
      }
      .nuance-mobile-nav-primary .nuance-mobile-nav-icon {
        width: 54px;
        height: 54px;
        padding: 3px;
        border: 4px solid rgba(249,247,255,0.96);
        border-radius: 19px;
        background: linear-gradient(135deg, #7c5cff, #c44bff);
        box-shadow: 0 10px 24px rgba(124,92,255,0.34);
      }
      .nuance-mobile-nav-primary .nuance-mobile-nav-icon img {
        border-radius: 13px;
        background: #fff;
      }
      .nuance-mobile-nav-primary .nuance-mobile-nav-label {
        color: #5b3fd6;
        font-size: 11px;
        font-weight: 800;
      }
      .nuance-mobile-nav a:active .nuance-mobile-nav-icon { transform: scale(0.94); }
      .nuance-mobile-nav-primary:active .nuance-mobile-nav-icon,
      .nuance-mobile-nav-primary.is-holding .nuance-mobile-nav-icon {
        transform: scale(0.94);
        box-shadow: 0 6px 16px rgba(124,92,255,0.28);
      }
      .nuance-mobile-nav-primary { touch-action: manipulation; user-select: none; }
      .nuance-quick-entry {
        position: fixed;
        z-index: 1100;
        inset: 0;
        display: flex;
        align-items: flex-end;
        padding: 16px 14px calc(18px + env(safe-area-inset-bottom));
        background: rgba(25,20,45,0.28);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease;
      }
      .nuance-quick-entry.is-open {
        opacity: 1;
        pointer-events: auto;
      }
      .nuance-quick-entry-sheet {
        width: 100%;
        padding: 12px;
        border: 1px solid rgba(255,255,255,0.84);
        border-radius: 20px;
        background: rgba(252,251,255,0.96);
        box-shadow: 0 18px 46px rgba(48,30,105,0.28);
        backdrop-filter: blur(20px) saturate(160%);
        transform: translateY(12px);
        transition: transform 0.18s ease;
      }
      .nuance-quick-entry.is-open .nuance-quick-entry-sheet { transform: translateY(0); }
      .nuance-quick-entry-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        color: #5b3fd6;
        font-size: 12px;
        font-weight: 800;
      }
      .nuance-quick-entry-close {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 10px;
        background: rgba(124,92,255,0.08);
        color: #5b3fd6;
        font-size: 18px;
      }
      .nuance-quick-entry-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }
      .nuance-quick-entry textarea {
        box-sizing: border-box;
        width: 100%;
        min-height: 88px;
        resize: none;
        padding: 11px 12px;
        border: 1px solid rgba(124,92,255,0.22);
        border-radius: 14px;
        outline: none;
        background: #fff;
        color: #211b3b;
        font: inherit;
        font-size: 16px;
        line-height: 1.45;
      }
      .nuance-quick-entry textarea:focus {
        border-color: rgba(124,92,255,0.62);
        box-shadow: 0 0 0 3px rgba(124,92,255,0.1);
      }
      .nuance-quick-entry-submit {
        align-self: stretch;
        min-width: 58px;
        padding: 0 12px;
        border: 0;
        border-radius: 14px;
        color: #fff;
        background: linear-gradient(135deg, #7c5cff, #c44bff);
        font-size: 13px;
        font-weight: 800;
      }
    }
  `;
  document.head.appendChild(style);

  const nav = document.createElement("nav");
  nav.className = "nuance-mobile-nav";
  nav.setAttribute("aria-label", "移动端主导航");
  nav.innerHTML = items.map((item) => {
    const classes = item.primary ? "nuance-mobile-nav-primary" : "";
    const current = item.key === active ? ' aria-current="page"' : "";
    const label = item.primary ? ' aria-label="表达，轻点打开，按住快速输入"' : "";
    return `<a class="${classes}" href="${item.href}"${current}${label}><span class="nuance-mobile-nav-icon" aria-hidden="true"><img src="${item.image}" alt="" /></span><span class="nuance-mobile-nav-label">${item.label}</span></a>`;
  }).join("");

  document.body.classList.add("has-mobile-nav");
  document.body.appendChild(nav);

  const primary = nav.querySelector(".nuance-mobile-nav-primary");
  let quickEntry = null;

  function focusPolishInput() {
    const source = document.getElementById("sourceText");
    if (!source) return false;
    source.focus({ preventScroll: true });
    const end = source.value.length;
    try { source.setSelectionRange(end, end); } catch (_) {}
    setTimeout(() => {
      const panel = source.closest(".polish-input-panel") || source;
      panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return true;
  }

  function closeQuickEntry() {
    if (!quickEntry) return;
    quickEntry.classList.remove("is-open");
    setTimeout(() => {
      quickEntry?.remove();
      quickEntry = null;
    }, 180);
  }

  function openQuickEntry() {
    if (focusPolishInput()) return;
    if (quickEntry) return;

    quickEntry = document.createElement("div");
    quickEntry.className = "nuance-quick-entry";
    quickEntry.innerHTML = `
      <div class="nuance-quick-entry-sheet" role="dialog" aria-modal="true" aria-label="快速输入表达">
        <div class="nuance-quick-entry-label">
          <span>说出或输入你想表达的内容</span>
          <button class="nuance-quick-entry-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="nuance-quick-entry-row">
          <textarea placeholder="使用键盘或输入法语音输入…"></textarea>
          <button class="nuance-quick-entry-submit" type="button">继续</button>
        </div>
      </div>`;
    document.body.appendChild(quickEntry);

    const input = quickEntry.querySelector("textarea");
    const submit = quickEntry.querySelector(".nuance-quick-entry-submit");
    quickEntry.querySelector(".nuance-quick-entry-close").addEventListener("click", closeQuickEntry);
    quickEntry.addEventListener("pointerdown", (event) => {
      if (event.target === quickEntry) closeQuickEntry();
    });
    submit.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      try { sessionStorage.setItem("nuanceQuickInput", text); } catch (_) {}
      location.href = "polish.html?quick=1";
    });

    input.focus();
    requestAnimationFrame(() => quickEntry?.classList.add("is-open"));
  }

  if (primary) {
    let holdTimer = null;
    let longPress = false;
    let startX = 0;
    let startY = 0;

    const clearHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      primary.classList.remove("is-holding");
    };

    primary.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      longPress = false;
      startX = event.clientX;
      startY = event.clientY;
      primary.classList.add("is-holding");
      holdTimer = setTimeout(() => {
        longPress = true;
        try { navigator.vibrate?.(16); } catch (_) {}
      }, 450);
    });
    primary.addEventListener("pointermove", (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) <= 10) return;
      longPress = false;
      clearHold();
    });
    primary.addEventListener("pointerup", (event) => {
      const shouldOpen = longPress;
      clearHold();
      if (shouldOpen) {
        event.preventDefault();
        openQuickEntry();
      }
    });
    primary.addEventListener("pointercancel", () => {
      longPress = false;
      clearHold();
    });
    primary.addEventListener("click", (event) => {
      if (!longPress) return;
      event.preventDefault();
      longPress = false;
    });
    primary.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  if (active === "polish") {
    try {
      const pending = sessionStorage.getItem("nuanceQuickInput");
      if (pending) {
        sessionStorage.removeItem("nuanceQuickInput");
        const source = document.getElementById("sourceText");
        if (source) source.value = pending;
      }
    } catch (_) {}
  }
})();
