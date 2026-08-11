# 矿山三语实时翻译助手 V0.6 FREE

## 为什么做 V0.6
V0.5.x 在部分 iPhone Safari 上会出现模型文件已经下载 100%，但 ONNX/WebGPU/WASM 推理会话仍无法创建的问题。
V0.6 不再把 Whisper 模型装进手机浏览器。

## 架构
手机 GitHub Pages
→ 录制 1~7 秒语音片段
→ Cloudflare Worker
→ Whisper Large V3 Turbo 自动语音识别
→ M2M100 中/西/英直接翻译
→ 手机三栏显示
→ 手机系统 TTS 朗读

手机不需要电脑，也不需要 OpenAI API Key。

## 费用
Cloudflare Workers AI Free 计划提供每日免费额度。
这是“免费额度方案”，不是无限量永久免费算力；免费额度用完后请求会失败，不会在 Free 计划自动产生超额收费。

## 第一步：更新 GitHub Pages
把根目录这些文件覆盖上传到原 mining-translator 仓库：
- index.html
- app.js
- styles.css
- sw.js
- manifest.webmanifest

Commit 后等待 GitHub Pages 更新。

## 第二步：部署 Cloudflare Worker
推荐电脑安装 Node.js 后操作：

1. 注册/登录 Cloudflare。
2. 解压本包，进入 `worker` 文件夹。
3. 命令行：
   npm install
   npx wrangler login
   npm run deploy
4. Wrangler 会创建 Worker 并配置 `AI` binding。
5. 部署后会显示类似：
   https://mining-translator-ai.xxxxx.workers.dev

如果 Cloudflare Dashboard 要求确认 Workers AI，请按页面提示启用 Free plan。

## 第三步：手机连接
打开：
https://d777wq.github.io/mining-translator/

点：
“配置免费服务”

粘贴：
https://mining-translator-ai.xxxxx.workers.dev

点“保存并测试”。

以后网址保存在手机 localStorage，不需要每次填写。

## 隐私提醒
V0.6 的音频片段会发送到 Cloudflare Workers AI 进行识别和翻译，因此不再是纯本地离线模式。
不要用于禁止上传到外部云服务的保密会议，除非公司政策允许。
