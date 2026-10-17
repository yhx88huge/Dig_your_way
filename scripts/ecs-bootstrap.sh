#!/usr/bin/env bash
# 华为云 ECS（或其他 Linux 云服务器）一键部署脚本
# 用法（在源码目录下执行）：
#   bash scripts/ecs-bootstrap.sh [对外端口] [公网访问地址，可留空]
# 例：
#   bash scripts/ecs-bootstrap.sh 8080
#   bash scripts/ecs-bootstrap.sh 8080 http://120.46.214.10:8080
# 脚本会：安装 Docker → 配置镜像加速 → 生成 .env → 构建镜像 → 启动 → 自检。
set -euo pipefail

WEB_PORT="${1:-8080}"
PUBLIC_ORIGIN="${2:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 执行：sudo bash scripts/ecs-bootstrap.sh $*"
  exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1. Docker
say "检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  say "安装 Docker（Aliyun 镜像源）"
  curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
fi
if ! docker compose version >/dev/null 2>&1; then
  say "安装 Docker Compose 插件"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker-compose-plugin || yum install -y docker-compose
  else
    warn "未识别的包管理器，请手动安装 Docker Compose 插件后重跑本脚本。"
    exit 1
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ------------------------------------------------------- 2. 镜像加速（关键）
# 华为云 ECS 直连 Docker Hub 经常超时，registry-mirrors 是能否构建成功的关键。
say "配置 Docker 镜像加速"
mkdir -p /etc/docker
MIRROR="https://docker.1panel.live"
if [ -f /etc/docker/daemon.json ] && grep -q registry-mirrors /etc/docker/daemon.json; then
  warn "daemon.json 已存在 registry-mirrors，保留原配置不动。"
else
  if [ -f /etc/docker/daemon.json ]; then
    # 已有配置时手工合并，避免覆盖用户自定义项
    python3 - "$MIRROR" <<'PY' || warn "合并 daemon.json 失败，请手动添加 registry-mirrors 后重跑。"
import json, sys
mirror = sys.argv[1]
try:
    cfg = json.load(open('/etc/docker/daemon.json'))
except Exception:
    cfg = {}
cfg.setdefault('registry-mirrors', [])
if mirror not in cfg['registry-mirrors']:
    cfg['registry-mirrors'].append(mirror)
json.dump(cfg, open('/etc/docker/daemon.json', 'w'), indent=2, ensure_ascii=False)
PY
  else
    cat > /etc/docker/daemon.json <<JSON
{
  "registry-mirrors": ["$MIRROR"]
}
JSON
  fi
  systemctl daemon-reload || true
  systemctl restart docker || true
  sleep 3
fi

# ------------------------------------------------------------------ 3. .env
say "准备 .env"
if [ ! -f .env ]; then
  if command -v openssl >/dev/null 2>&1; then
    PG_PASS="$(openssl rand -hex 12)"
  else
    PG_PASS="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  if [ -z "$PUBLIC_ORIGIN" ]; then
    PUBLIC_IP="$(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || true)"
    [ -n "$PUBLIC_IP" ] && PUBLIC_ORIGIN="http://${PUBLIC_IP}:${WEB_PORT}"
  fi
  cat > .env <<ENV
POSTGRES_PASSWORD=$PG_PASS
WEB_PORT=$WEB_PORT
ALLOWED_ORIGINS=$PUBLIC_ORIGIN
TURN_SECONDS=90
ENV
  say "已生成 .env（数据库密码随机；如要改端口或域名，直接编辑该文件）"
else
  warn ".env 已存在，不覆盖。如需重设请删除后重跑。"
fi

# ---------------------------------------------------------------- 4. 构建启动
say "构建并启动容器（首次约 5-10 分钟，请耐心等待）"
docker compose up --build -d

# ------------------------------------------------------------------ 5. 自检
say "等待服务健康"
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 3
done

say "自检结果"
echo "--- /api/health ---"
curl -fsS --max-time 5 "http://127.0.0.1:${WEB_PORT}/api/health" || warn "健康检查失败，请查看日志：docker compose logs app"
echo
echo "--- 首页 ---"
curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 "http://127.0.0.1:${WEB_PORT}/"
echo "--- Socket.IO 握手 ---"
curl -s --max-time 5 "http://127.0.0.1:${WEB_PORT}/socket.io/?EIO=4&transport=polling" | head -c 120; echo
echo "--- 容器状态 ---"
docker compose ps

cat <<TIP

================================================================
部署脚本执行完毕。最后一步需要你手动完成：

  在华为云控制台 → 安全组 → 入方向规则，放行 TCP ${WEB_PORT}（源 0.0.0.0/0）。
  华为云默认只开 22 端口，不放行的话公网访问会一直超时。

放行后用浏览器打开：
  ${PUBLIC_ORIGIN:-http://<公网IP>:${WEB_PORT}}

常用命令：
  docker compose logs -f app     查看应用日志
  docker compose ps              查看容器状态
  docker compose restart app     重启应用
  docker compose down            停止（数据卷保留）
================================================================
TIP
