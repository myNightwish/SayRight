#!/bin/bash
# 打包 Nuance 语差 为可上架 Chrome 网上应用店的 zip。
# 只收录扩展运行必需的前端文件，排除服务端(.mjs)、.env、文档、图标生成脚本等。
set -e
cd "$(dirname "$0")"

VER=$(node -e "console.log(require('./manifest.json').version)")
OUT="nuance-语差-v${VER}.zip"
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  config.js auth.js sync.js \
  popup.html popup.js \
  collection.html collection.js \
  scene.html scene.js \
  chat.html chat.js \
  quiz.html quiz.js \
  privacy.html \
  styles.css \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
  >/dev/null

echo "已生成: $OUT"
unzip -l "$OUT"
