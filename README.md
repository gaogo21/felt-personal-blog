# Always Curious

个人博客：现有原生 HTML/CSS/JavaScript 页面 + ASP.NET Core 10 管理后台 + PostgreSQL 17。文章、专栏、知识库、项目、生活随记、首页和关于页现在从后端读取内容。原有毛毡人物轮播、画廊、星空与专栏动效保留。

后端依据 `recovery/backend-records-20261011` 的历史记录重建；完整源码无法恢复的部分已重新实现。恢复来源与哈希见 [恢复说明](docs/recovery-audit.md) 和 [源码来源清单](docs/recovery-sources.json)。初始 8 篇文章、2 个项目均保留“示例”标识；不是旧电脑上的真实业务数据。

## 本地运行

需要 .NET SDK 10、Node.js 24、PostgreSQL 17、FFmpeg/FFprobe 和 ClamAV 官方签名库。也可以使用下面的 Docker 方式。

```sh
npm ci --prefix frontend/editor
npm run build --prefix frontend/editor
npm ci --prefix frontend/admin
npm run build --prefix frontend/admin
# 将下列配置写入仅本机保存的 runtime/dev.env，或直接设置环境变量。
export ASPNETCORE_ENVIRONMENT=Development
export ASPNETCORE_URLS=http://127.0.0.1:5080
export ConnectionStrings__Blog='Host=127.0.0.1;Port=55432;Database=felt_blog;Username=felt;Password=你的数据库密码'
export Blog__StoragePath="$PWD/runtime/private"
export Blog__AdminName=admin
export Blog__AdminPassword='至少12个字符的随机密码'
export Media__FfmpegPath=/usr/bin/ffmpeg
export Media__FfprobePath=/usr/bin/ffprobe
export Media__ScannerPath=/usr/bin/clamscan
export Media__ScannerDatabasePath=/var/lib/clamav
./eng/dev.sh --migrate --init-admin --seed-demo
./eng/dev.sh
```

macOS Homebrew 的三个工具通常位于 `/opt/homebrew/bin/`，应配置实际绝对路径。`--seed-demo` 可选且只向空内容库首次导入示例；重复执行不会覆盖修改。数据库迁移必须显式运行；普通启动不自动迁移。初始化已有管理员时会拒绝覆盖；需要改密码时使用 `--reset-admin`，原会话随之失效。

网站：`http://127.0.0.1:5080/`；管理后台：`http://127.0.0.1:5080/admin`。

后台使用 Tabler + 定制 CSS，保留 Razor 与原生 JavaScript。首页画廊固定 10 张、精选固定 3 篇、每个专栏固定 3 张图片；图片位置与自我介绍换行同步到公开页面。模块、保存边界和构建说明见 [管理员工作台](docs/admin-ui.md)。

`dist/` 仍是可编辑的网页源码目录。现在需要后端 API，单独运行 Python 静态服务器只适合查看静态资源。

## Docker 运行

```sh
cp .env.example .env
# 编辑 .env：设置数据库密码与管理员密码；本地使用 Development。
docker compose up -d db
docker compose --profile app build app
docker compose --profile app run --rm app --migrate --init-admin --seed-demo
docker compose --profile app up -d app
```

首次启动会下载 ClamAV 官方签名；失败会停止启动，已运行时扫描不可用则上传不会进入就绪状态。更新签名：`docker compose --profile app exec app freshclam --stdout --user=app --datadir=/var/lib/clamav`。私有媒体、备份、Cookie 密钥使用独立持久卷；数据库使用单独卷。完整生产配置与恢复步骤见 [运维说明](docs/operations.md)。

## 内容业务流程

1. 管理后台创建或编辑专栏，选三张就绪图片后启用。
2. 在媒体库上传图片/视频；扫描、解码检查和图片重编码完成后才能引用。图片支持 JPEG/PNG/WebP；视频支持 MP4 H.264，可含 AAC。
3. 新建文章或随记，选择专栏并编辑正文，手动保存、预览、发布。
4. 访客页面读取发布快照。保存后续草稿不改变已发布内容；再次发布才更新。
5. 知识库章节关联文章；首页推荐、画廊、关于内容和项目通过对应管理页面维护。

文章支持撤回、回收站、恢复和永久清空；历史版本恢复到工作草稿后还需发布。媒体被草稿、历史版本或公开内容引用时不能删除。永久清空需要再次验证密码和输入标识。项目采用独立草稿与发布快照。管理写入使用版本条件和幂等键，避免多窗口覆盖与重复提交。

## 验证

```sh
npm test --prefix frontend/editor
npm run build --prefix frontend/editor
npm test --prefix frontend/admin
npm run build --prefix frontend/admin
node validate.mjs
dotnet build src/Blog.Web
dotnet tool restore
dotnet tool run dotnet-ef migrations has-pending-model-changes --project src/Blog.Web
python3 tests/integration.py
dotnet publish src/Blog.Web -c Release -o artifacts/publish
```

集成测试需要上述环境变量和数据库创建/删除权限，自动创建 `felt_test_*` 和 `felt_restore_*` 测试库并清理。使用 Docker 数据库时可设置 `TEST_DB_CONTAINER=容器名`；否则需要 `psql`。测试实际运行 ClamAV 和 FFmpeg，不使用扫描模拟器。浏览器验收记录见 [交付验证](docs/verification.md)。

同一套 GitHub Actions 检查配置保存在 [工作流模板](eng/github-verify.yaml)，目前尚未启用：本机 GitHub OAuth 登录缺少 `workflow` 权限，GitHub 拒绝新增工作流的推送。获得该权限后，将模板放到 `.github/workflows/verify.yaml` 并提交即可启用。

## 目录

```text
src/Blog.Web/        后端源码、Razor 管理入口、管理页面脚本
frontend/editor/    从历史记录恢复的 Tiptap 编辑器及测试
frontend/admin/     锁定版本的 Tabler 样式构建与后台交互测试
Infrastructure/     位于 src/Blog.Web 下：数据库、媒体处理、身份与备份
data/               受校验的示例内容
eng/                开发启动、恢复记录校验、示例转换脚本
Dockerfile          前后端构建和运行环境
compose.yaml        数据库、应用及持久卷
```

`node build-static.mjs` 同步首页静态回退；`eng/extract-demo.mjs` 从已审计的原型 Git 提交重新生成示例，需已安装编辑器依赖和 FFprobe。

## 素材与许可

第三方图片和字体来源见 [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md)。编辑器依赖许可由锁定的 npm 包生成，见 [编辑器许可](frontend/editor/THIRD_PARTY_LICENSES.md)；后端依赖说明见 [依赖说明](docs/dependencies.md)。本仓库未指定统一开源许可证，各素材及依赖保留原许可。
