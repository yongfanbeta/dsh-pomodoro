#!/usr/bin/env bash
#
# dsh-pomodoro installer (macOS / Linux).
#
# Windows users: use scripts/install.ps1 instead (it does the same thing).
#
# Copies the plugin into the active DSH profile's node_modules and registers it
# in that profile's bundle list + dependency table, so a restart of DSH picks
# it up and the marketplace "已安装" tab lists it.
#
# Usage:
#   bash scripts/install.sh               # auto-detect the profile
#   bash scripts/install.sh -Profile web  # force a profile name
#   bash scripts/install.sh --uninstall   # remove instead
#
# Requires: bash, node (^22 or >=24, matching DSH itself). JSON editing is
# delegated to node so it works identically wherever jq is absent.

set -euo pipefail

PLUGIN_NAME='@yongfanbeta/dsh-pomodoro'

# --- locate the plugin root (parent of this script's dir) --------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- args --------------------------------------------------------------------
PROFILE=""
UNINSTALL=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -Profile|--profile)   PROFILE="${2:-}"; shift 2 ;;
    -Profile=*|--profile=*) PROFILE="${1#*=}"; shift ;;
    -Uninstall|--uninstall) UNINSTALL=1; shift ;;
    -Force|--force)       FORCE=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_ROOT="$DSH_HOME/profiles"

if [ ! -d "$PROFILES_ROOT" ]; then
  echo "找不到 profiles 目录：$PROFILES_ROOT（DSH 是否已运行过？）" >&2
  exit 1
fi

# --- pick the profile (RUNNING profile wins) ---------------------------------
# Precedence matches install.ps1: explicit -> $DSH_PROFILE -> $DSH_PROFILE_DIR
# -> prefer 'desktop' -> newest package.json-bearing profile.
if [ -z "$PROFILE" ]; then
  if [ -n "${DSH_PROFILE:-}" ]; then
    PROFILE="$DSH_PROFILE"
    echo "profile 来自 \$DSH_PROFILE：$PROFILE"
  elif [ -n "${DSH_PROFILE_DIR:-}" ] && [ -d "$DSH_PROFILE_DIR" ]; then
    PROFILE="$(basename "$DSH_PROFILE_DIR")"
    echo "profile 来自 \$DSH_PROFILE_DIR：$PROFILE"
  else
    # Candidates: subdirs of profiles that have a package.json.
    preferred=""
    newest=""; newest_mtime=0
    for d in "$PROFILES_ROOT"/*/; do
      [ -f "$d/package.json" ] || continue
      name="$(basename "$d")"
      if [ "$name" = "desktop" ]; then preferred="$name"; fi
      # Portable newest-by-mtime.
      mtime="$(node -e "console.log(Math.floor(require('fs').statSync('$d').mtimeMs))" 2>/dev/null || echo 0)"
      if [ "$mtime" -gt "$newest_mtime" ]; then newest_mtime="$mtime"; newest="$name"; fi
    done
    PROFILE="${preferred:-$newest}"
    if [ -z "$PROFILE" ]; then
      echo "在 $PROFILES_ROOT 下没有找到任何 profile。" >&2
      exit 1
    fi
    echo "自动选择 profile：$PROFILE（若不对请用 -Profile 指定）"
  fi
fi

PROFILE_DIR="$PROFILES_ROOT/$PROFILE"
PROFILE_JSON="$PROFILE_DIR/package.json"
if [ ! -f "$PROFILE_JSON" ]; then
  echo "profile '$PROFILE' 不存在或缺少 package.json：$PROFILE_JSON" >&2
  exit 1
fi

TARGET_DIR="$PROFILE_DIR/node_modules/$PLUGIN_NAME"

# --- uninstall ---------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  if [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
    echo "已删除 $TARGET_DIR"
  fi
  node -e '
    const fs = require("fs");
    const [path, name] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(path, "utf8"));
    const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || [];
    m.dsh.profile.bundles = bundles.filter(b => b !== name);
    if (m.dependencies && Object.prototype.hasOwnProperty.call(m.dependencies, name)) {
      delete m.dependencies[name];
      console.log("已从 dependencies 中移除 " + name + "（市场『已安装』列表同步更新）。");
    }
    fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
    console.log("已从 bundles 中移除 " + name);
  ' "$PROFILE_JSON" "$PLUGIN_NAME"
  echo "请重启 DSH 使改动生效。"
  exit 0
fi

# --- copy the package --------------------------------------------------------
FILES=(package.json cordis.patch.yml README.md LICENSE lib)
if [ ! -d "$TARGET_DIR" ]; then
  mkdir -p "$TARGET_DIR"
fi
for f in "${FILES[@]}"; do
  src="$PLUGIN_ROOT/$f"
  if [ ! -e "$src" ]; then
    echo "插件缺少文件：$src" >&2
    exit 1
  fi
  dst="$TARGET_DIR/$f"
  [ -e "$dst" ] && rm -rf "$dst"
  cp -R "$src" "$dst"
done
echo "已安装到 $TARGET_DIR"

# --- register bundle + dependency (delegated to node) ------------------------
node -e '
  const fs = require("fs");
  const [profileJson, name, pluginRoot] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(profileJson, "utf8"));
  if (!m.dsh) throw new Error("profile 的 package.json 缺少 dsh 字段：" + profileJson);
  if (!m.dsh.profile) throw new Error("profile 的 package.json 缺少 dsh.profile 字段：" + profileJson);
  m.dsh.profile.bundles = m.dsh.profile.bundles || [];
  if (m.dsh.profile.bundles.includes(name)) {
    console.log("bundles 已包含 " + name + "，无需修改。");
  } else {
    m.dsh.profile.bundles.push(name);
    console.log("已把 " + name + " 加入 bundles。");
  }
  m.dependencies = m.dependencies || {};
  if (Object.prototype.hasOwnProperty.call(m.dependencies, name)) {
    console.log("dependencies 已包含 " + name + "，无需修改。");
  } else {
    m.dependencies[name] = "file:" + pluginRoot;
    console.log("已把 " + name + " 加入 dependencies（版本指向本地：file:" + pluginRoot + "）。");
  }
  fs.writeFileSync(profileJson, JSON.stringify(m, null, 2) + "\n");
' "$PROFILE_JSON" "$PLUGIN_NAME" "$PLUGIN_ROOT"

echo ''
echo '安装完成。下一步：'
echo '  1. 重启 DSH（例如重新运行 dsh web，或重启桌面端）。'
echo '  2. 左侧边栏会出现番茄钟图标，点击进入独立面板。'
echo "  3. 数据保存在：$DSH_HOME/storages/pomodoro/state.json"
