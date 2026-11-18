#!/usr/bin/env bash
# install.sh — dsh-tts 一键安装（Linux/macOS）
# 做两件事：① 复制包到 ~/.dsh/profiles/web/node_modules/dsh-tts
#           ② 在 ~/.dsh/profiles/web/cordis.patch.yml 追加接线块（幂等）
set -euo pipefail

PKG="dsh-tts"
SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$HOME/.dsh/profiles/web"
NODE_DIR="$PROFILE_DIR/node_modules/$PKG"
PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "未找到 profile 目录: $PROFILE_DIR" >&2
  echo "先启动一次 dsh web 让它生成 profile，再运行本脚本。" >&2
  exit 1
fi

# ① 复制包
mkdir -p "$NODE_DIR/lib"
cp "$SRC/package.json" "$NODE_DIR/package.json"
cp "$SRC/lib/index.js" "$NODE_DIR/lib/index.js"
cp "$SRC/lib/client.js" "$NODE_DIR/lib/client.js"
echo "✓ 包已复制到 $NODE_DIR"

# ② 接线（幂等）
if [ -f "$PATCH" ] && grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-tts[[:space:]]*$' "$PATCH"; then
  echo "• cordis.patch.yml 已有 dsh-tts 条目，跳过"
else
  cat >> "$PATCH" <<'EOF'

# ── installed-by: dsh-tts ──
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
EOF
  echo "✓ cordis.patch.yml 已追加接线块"
fi

echo ""
echo "完成。请重启一次 harness（关掉窗口重新打开）让宿主半部加载。"
echo "然后点会话头部「朗读」芯片配置 TTS 端点。"
