# 矿山三语实时翻译助手 V0.4.1 FREE — iPhone兼容修正版

## 修复内容
- 不再在页面打开时直接导入 Transformers.js。
- 点击“初始化免费模型”后才动态加载 AI 引擎。
- iPhone 先只加载 Whisper Tiny；翻译模型按语言需要再下载，降低内存压力。
- 使用独立缓存版本 V041，避免 Safari/GitHub Pages 一直读取旧 app.js。
- 初始化失败时会把具体错误直接显示在页面上。
- 仍然不需要 OpenAI API Key，也没有 API 调用费用。

## 更新 GitHub
把本压缩包解压后，将以下文件覆盖上传到原仓库根目录：
- index.html
- app.js
- sw.js
- README.md

styles.css 与 manifest.webmanifest 没变化，也可以全部覆盖上传。

上传并 Commit 后，GitHub Pages 会自动重新发布。
建议在 iPhone Safari 中关闭旧页面后重新打开网站。
