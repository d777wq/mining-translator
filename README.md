# 矿山三语实时翻译助手 V0.5.2 FREE — 手机独立单路径版

## 这版专门解决 V0.5.1 的 iPhone 初始化失败

旧逻辑：
Base WebGPU 失败 → Base WASM → Tiny WASM
这会导致前面失败的模型可能仍占用内存，最后 Tiny 下载到 100% 也创建失败。

V0.5.2 改为：
- 正常高精度模式：只加载 Whisper Base + WebGPU
- 兼容模式：只加载 Whisper Tiny + WASM
- 同一页面绝不连续加载多个 ASR 模型
- 高精度失败时出现“切换兼容模式”按钮
- 点击按钮后整页刷新，释放旧页面内存，再干净地加载 Tiny
- 检测微信等内嵌浏览器时，默认直接进入兼容模式
- 连续识别时会用上一段语言作为下一段 Whisper language hint，提高连续中文的识别稳定性

## 更新 GitHub
把解压后的全部文件覆盖上传到原 mining-translator 仓库根目录，Commit changes。
等待 GitHub Pages 自动部署。
重新打开后顶部应显示 V0.5.2。

## 推荐
- iPhone 最好使用 Safari
- 若高精度模式初始化失败，点“切换兼容模式”
- 兼容模式速度快、占内存低；中文准确率不如 Base，但稳定性更高
