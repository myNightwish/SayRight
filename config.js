// config.js —— 全站共享的运行期配置，必须最先加载（在 auth.js 和各页脚本之前）。
//
// 线上服务地址：插件（chrome-extension:// 协议）没有自己的后端，必须打到这个线上域名；
// H5 网页版由该服务自己托管，跟随 location.origin，不用这里的值。
//
// ⚠️ 注意：Render 免费实例的域名可能变动（曾从 sayright-1 变成 say-50s9）。
// 域名一旦变，已上架的插件不会自动更新——发布前建议绑定一个稳定的自定义域名，
// 只在这一处维护。
window.NUANCE_REMOTE_ORIGIN = "https://say-50s9.onrender.com";
