# 用 Docker 部署 KeyWord

推送到 `main` 后，GitHub Actions 会运行自动检查、前端构建和词库检查，再构建并真实启动容器，验证登录、管理员隔离、邀请码、备份及重启后词库和练习记录保留。全部通过后发布：

```text
ghcr.io/curtaintears/wendys-keyword:latest
ghcr.io/curtaintears/wendys-keyword:sha-<完整提交号>
```

镜像支持 `linux/amd64` 与 `linux/arm64`。推送 `v2.5.0` 这样的标签还会发布 `2.5.0`、`2.5`；版本标签不改写 `latest`。PR 只检查，不登录镜像仓库或发布；也可在 Actions 中手动运行主分支工作流。

工作流使用仓库自动提供的 `GITHUB_TOKEN`，只在镜像任务授予 `packages: write`，无需额外保存 Docker Hub 密钥。依照 [Docker 官方构建文档](https://docs.docker.com/build/ci/github-actions/multi-platform/)，用 Buildx 发布双架构镜像；第三方 Action 固定到具体提交。

开发交付以推送到 `main`、确认 GitHub Actions 检查及镜像发布成功为完成。生产环境的备份、镜像拉取和容器更新由站点所有者执行；以下部署与更新步骤供站点所有者操作。

## 首次启动

服务器需要 Docker Engine 与 Compose v2，并由 HTTPS 反向代理把公开域名转发到 `127.0.0.1:3000`，保留公开域名的 Host。

1. 下载本仓库的 `compose.yaml` 和 `.env.example`，将后者复制为 `.env`。
2. 将 `.env` 的 `APP_ORIGIN` 改为实际 HTTPS 地址，并增加 `BETTER_AUTH_SECRET`，使用私下生成的至少 32 字符随机值，例如 `openssl rand -base64 48` 的输出。不要提交或分享此文件。
3. 拉取并启动：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

新建 GHCR 包可能默认为私有。私有包需先按 [GitHub 官方说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry) 使用具有读取包权限的凭据登录 `ghcr.io`；若希望任何人直接拉取，由仓库所有者将该包设为公开。

数据库位于持久化卷 `keyword-data` 的 `/app/data/keyword.sqlite`。镜像内使用非 root 的 `node` 用户，工作目录只读，只允许数据卷和临时目录写入。不要把数据库放到网络文件系统，不要用多个数据库副本充当跨设备同步。

默认访问域名显示登录页；配置支付并开放有限销售后，也可在登录前购买邀请码。初始化你的管理员账号，在部署主机运行一次：

```bash
docker compose exec keyword node tools/invite.mjs create --admin --label "站点所有者"
```

用输出的专用邀请码注册自己的账号，密码由你自己填写。之后登录并点击“管理”，即可在页面给普通用户生成、查看、复制和撤销邀请码。管理员初始化码不要转发给普通用户；它也只能使用一次。

## 更新与回退

先保存当前镜像标签并做一致性备份：

```bash
docker compose exec keyword node tools/backup.mjs
```

容器备份默认写入数据卷内的 `/app/data/backups/`，命令会显示具体文件名。使用 `docker compose cp keyword:/app/data/backups/<文件名> ./<文件名>` 复制到主机，并定期保存到另一存储位置。备份含账号和私人数据，不要公开上传；登录密钥需要单独保管。

然后更新：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

数据卷和 `.env` 中的登录密钥必须保留。管理员权限、邀请码状态、词库与练习记录都在数据库中，替换容器不会清空。不要运行 `docker compose down -v`，它会删除数据卷。

若新镜像启动或检查失败，先保留数据卷，在 `.env` 设置 `KEYWORD_TAG=sha-<上一个可用提交号>` 后重新 `pull` 和 `up -d`。数据库格式不兼容时，应停止容器并在保留当前数据副本后按 [数据库恢复步骤](../README.md#备份恢复与更新) 恢复更新前备份；不要直接覆盖运行中的 SQLite 或遗留 WAL 文件。

## 运行边界

- `APP_ORIGIN` 必须与浏览器实际访问的公开地址一致；生产模式强制 HTTPS 与私有密钥。
- 未登录不能读取词库、练习记录或旧榜单，普通账号的管理 API 返回 `403`。除登录注册、身份查询、静态资源和最小健康检查外，还开放[可选购买、凭据保护的订单操作、支付宝验签通知与结果页](PAYMENTS.md#接口)；不会因此开放词库或管理内容。
- 默认只把容器端口绑定到主机回环地址，由反向代理处理 TLS、请求大小和连接限流。`TRUSTED_PROXY_CIDRS` 默认留空，不采信转发 IP；由所有者填写应用实际看到的可信代理连接源 IP/CIDR 后，才沿 `X-Forwarded-For` 的可信链识别访客，分别计算购买和登录/注册限额。Compose 已传入这个可选变量；不要信任访客网段或全部来源，具体规则见[反向代理配置](PAYMENTS.md#nginx-proxy-manager-后按真实访客限流)。未配置时仍由代理地址共享额度。
- 保持相同的登录密钥。更换后旧会话失效，旧邀请码密文不能回显；账号数据及邀请码散列校验保留。
- 镜像不包含 `.env`、数据库、密钥、本机备份、依赖缓存或 Git 目录；`.dockerignore` 使用构建输入白名单。
