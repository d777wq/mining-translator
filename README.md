# V0.5.1 手机独立稳定版

修复 V0.5 初始化失败问题：

- 不再仅凭 `navigator.gpu` 判断 WebGPU 可用。
- 初始化时实际执行 `requestAdapter()` + `requestDevice()`。
- WebGPU Whisper Base 使用更稳的 per-module dtype：
  - encoder_model: fp32
  - decoder_model_merged: q4
- WebGPU Base 加载失败时自动回退：
  1. WASM Whisper Base q8
  2. WASM Whisper Tiny q8
- 翻译模型固定使用 WASM q8，减少手机 WebGPU 兼容问题。
- 新缓存版本 v051，避免 Safari 继续使用 V0.5 旧脚本。

更新原 GitHub 仓库即可，无需新建：
将解压后的全部文件拖入 `mining-translator` 根目录覆盖，然后 Commit。
等待 GitHub Pages 重新部署后关闭旧网页，再打开网站。
