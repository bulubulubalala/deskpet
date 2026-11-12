# Third-Party Notices

本项目包含以下第三方运行时代码。分发时请一并保留本文件与各组件原始许可声明。

## Live2D Cubism Core 5

- 文件：`app/renderer/vendor/live2dcubismcore.min.js`
- 版权：Copyright (C) Live2D Inc.
- 许可：**Live2D Proprietary Software License Agreement**
- 链接：<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 说明：该文件是 Live2D Cubism SDK for Web 的 **Redistributable Code**，不是 MIT/Apache 开源库。随应用分发时必须保留文件头中的版权与许可声明，并遵守 Live2D 的许可条款。

## PixiJS

- 包：`pixi.js@8`
- 许可：MIT
- 仓库：<https://github.com/pixijs/pixijs>

## @naari3/pixi-live2d-display

- 包：`@naari3/pixi-live2d-display@1.2.5`
- 许可：MIT
- 仓库：<https://github.com/naari3/pixi-live2d-display>

## onnxruntime

- 包：`onnxruntime>=1.20`（Windows x64 wheel）
- 许可：MIT
- 版权：Copyright (c) Microsoft Corporation
- 用途：运行内置的中文向量模型（T2.40 语义检索）

## tokenizers

- 包：`tokenizers>=0.20`
- 许可：Apache-2.0
- 版权：Copyright Hugging Face SAS
- 用途：内置向量模型的 BERT 分词

## bge-small-zh-v1.5 模型权重

- 文件：`models/embedding/model_quantized.onnx`、`models/embedding/tokenizer.json`
- 模型：BAAI `bge-small-zh-v1.5`（int8 量化，512 维）
- 许可：MIT
- 来源：<https://huggingface.co/BAAI/bge-small-zh-v1.5>；ONNX 量化导出取自 ModelScope 上
  Xenova/bge-small-zh-v1.5 的 `onnx/model_quantized.onnx` 与 `tokenizer.json`
- 说明：约 24 MB，随安装包分发，仅供本项目的本地语义检索使用。

## 角色模型


`characters/snow/model/` 中的小雪 Live2D 模型由项目所有者提供并授权用于本项目；
不随本仓库的代码许可证单独授权给第三方。角色模型的再分发请先取得模型权利人的同意。
