# Always Curious

一个使用原生 HTML、CSS 和 JavaScript 编写的个人网站前端原型。没有 React、Vue、Next.js 或 TypeScript，也不需要 npm 依赖。文章、专栏和项目内容目前均为明确标注的示例。

## 本地查看

安装 Python 3 后，在仓库根目录运行：

```sh
python3 -m http.server 8080 --directory dist
```

浏览器打开 `http://localhost:8080`。

`dist/` 已包含可直接运行的网页源文件和本地资源，无需先构建。请通过 HTTP 静态服务查看，不要直接双击 `index.html`；JavaScript 模块和以 `/assets/` 开头的路径依赖网站根目录。

## 页面与交互

- 首页：三张毛毡人物图片每 3 秒轮换；单屏双排艺术作品墙自动反向移动；ABOUT ME 自我介绍；ARTICLE 星空指针揭露；COLUMNS 专栏叠板。
- 文章：分类筛选、文章详情、章节目录和前后篇导航。
- 专栏：四个专栏目录，文章数从关联数据计算。
- 知识库、项目、生活随记和关于页面。
- 窄屏布局、键盘操作、暂停控件及减少动态效果的静态回退。

人物舞台是二维图片景深轮播，不是实时三维模型。艺术图和项目封面为示意素材，不代表作者的商业项目或摄影成果。

## 目录

```text
dist/
  index.html           页面入口与首页静态回退
  app.js               示例内容、页面渲染和 hash 路由
  style.css            基础样式及内页
  collectible.*        毛毡人物轮播
  gallery.*            双排作品墙和图片查看器
  about-stage.*        自我介绍区域
  article-index.css    文章索引排版
  article-sky.js       星空指针揭露
  columns.*            专栏叠板与响应式布局
  assets/              图片、视频、字体及来源许可
build-static.mjs       同步首页静态回退
validate.mjs           路由与资源校验
THIRD_PARTY_ASSETS.md  素材和字体说明
```

样式和脚本未经过打包或压缩，`dist/` 在本项目中同时是可编辑源码目录和静态部署目录。路由由 `app.js` 监听 `hashchange` 实现，例如 `#/articles`、`#/article/understand-the-code`、`#/column/frontend`。

## 修改与验证

需要运行开发辅助脚本时，安装现代 Node.js；推荐 Node.js 20 或更新版本。脚本只使用 Node.js 内置模块，不需要 `npm install`。

```sh
node --check dist/app.js
node build-static.mjs
node validate.mjs
```

修改 `app.js` 中的首页结构或内容后，运行 `build-static.mjs`，让 `index.html` 的静态回退保持同步。`validate.mjs` 检查 20 个页面视图、资源引用、分类、文章目录与四个专栏的关联；动画和视觉效果仍应在浏览器中验证。

这是纯前端项目，没有服务器业务逻辑、数据库、登录系统或 CMS。内容暂时通过修改前端数据维护。

## 部署

将 `dist/` 的内容作为网站根目录发布到普通静态服务器即可。由于脚本和资源使用根路径，若部署到 `/repository-name/` 这样的子路径，需要先统一调整资源与模块路径。仓库本身不配置或启用在线托管。

## 素材与许可

第三方图片和字体的作者、来源及许可文件已随资源保留，详见 [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md)。本仓库没有给整个项目指定统一的开源许可证；公开源码不会改变各项素材原有的许可条件。
