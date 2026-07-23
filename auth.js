// auth.js —— 访问口令统一处理，所有页面共用，必须在各页自己的脚本之前加载。
// 解决两件事：
//   1) PWA（添加到主屏幕）启动地址是 manifest 的 start_url，不带 ?key=，且存储与 Safari 隔离，
//      导致口令读不到 → 接口 401。
//   2) 口令不该写进 manifest（公开文件）。
// 做法：包一层 window.fetch。对「同源 + 带 body 的请求」自动补上 x-tutor-key；
// 若仍返回 401，就弹窗让用户输入口令一次，存进本页面（含 PWA）自己的 localStorage 并自动重试。
(function () {
  const LS_KEY = "tutorAccessKey";

  // 首次带 ?key= 打开时记下来（浏览器直接访问的老路径仍兼容）。
  try {
    const fromUrl = new URLSearchParams(location.search).get("key");
    if (fromUrl) localStorage.setItem(LS_KEY, fromUrl);
  } catch (_) {}

  function getKey() {
    try { return localStorage.getItem(LS_KEY) || ""; } catch (_) { return ""; }
  }
  function setKey(v) {
    try { localStorage.setItem(LS_KEY, v); } catch (_) {}
  }

  const origFetch = window.fetch.bind(window);

  // 判断是否是「打到本服务、需要口令」的请求。
  // 两种场景都要覆盖：
  //   H5 网页版：同源 POST（接口都在自己域名下）。
  //   插件：页面是 chrome-extension:// 协议，请求跨域打到 config.js 的线上域名，
  //         这时按目标 origin 是否等于线上服务地址来判断。
  function isServiceOrigin(u) {
    if (u.origin === location.origin) return true;
    try {
      const remote = window.NUANCE_REMOTE_ORIGIN;
      if (remote && u.origin === new URL(remote).origin) return true;
    } catch (_) {}
    return false;
  }
  function needsKey(url, opts) {
    try {
      const u = new URL(url, location.href);
      if (!isServiceOrigin(u)) return false; // 第三方（如 Google 翻译）不碰
      const method = (opts && opts.method ? opts.method : "GET").toUpperCase();
      return method === "POST";
    } catch (_) { return false; }
  }

  function withKey(opts, key) {
    const next = Object.assign({}, opts);
    const headers = new Headers((opts && opts.headers) || {});
    if (key) headers.set("x-tutor-key", key);
    next.headers = headers;
    return next;
  }

  window.fetch = async function (url, opts) {
    if (!needsKey(url, opts)) return origFetch(url, opts);

    let key = getKey();
    let res = await origFetch(url, withKey(opts, key));
    if (res.status !== 401) return res;

    // 401：口令缺失或错误。最多让用户重输 2 次。
    for (let attempt = 0; attempt < 2; attempt++) {
      const entered = window.prompt(
        attempt === 0
          ? "请输入访问口令（首次使用需要，之后会记住）："
          : "口令不对，请重新输入："
      );
      if (entered == null) return res;           // 用户取消，把原始 401 交回去
      const trimmed = entered.trim();
      if (!trimmed) return res;
      setKey(trimmed);
      key = trimmed;
      res = await origFetch(url, withKey(opts, key));
      if (res.status !== 401) return res;
    }
    return res; // 两次仍失败，交回最后一次 401
  };
})();
