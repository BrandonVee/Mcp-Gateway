# 第三方声明

MCP Gateway 自有代码采用 [Apache License 2.0](LICENSE)。第三方组件和资源保留各自的许可证，项目许可证不替代下列授权。

## 归档字体

下列字体子集随源码保留用于历史参考，当前界面使用系统字体，未导入这些字体。重新分发字体时须同时保留相应版权声明和完整许可证。

| 资源                                                                | 来源与版权                                                                                                                                                                                            | 许可证                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/admin-web/src/assets/fonts/ResourceHanRoundedCN-UI.woff2` | [Resource Han Rounded CN v1.910](https://github.com/CyanoHao/Resource-Han-Rounded/releases/tag/v1.910) 的中文子集。Copyright © 2018–2022 Cyano Hao；部分内容 © 2014–2021 Adobe，保留字体名 `Source`。 | [SIL Open Font License 1.1](packages/admin-web/src/assets/fonts/OFL-License.txt) |
| `packages/admin-web/src/assets/fonts/Nunito-UI.woff2`               | [Nunito](https://github.com/google/fonts/tree/main/ofl/nunito) 的拉丁文子集。Copyright 2014 The Nunito Project Authors。                                                                              | [SIL Open Font License 1.1](packages/admin-web/src/assets/fonts/Nunito-OFL.txt)  |

## 软件依赖

JavaScript 依赖及其版本记录在各工作区 `package.json` 和根目录 `pnpm-lock.yaml` 中，各依赖附带的 `LICENSE`、`NOTICE` 等文件仍然适用。安装依赖后，可使用 `pnpm licenses list --prod` 查看生产依赖的许可证清单。

`pnpm build:admin` 自动从已安装的管理端和共享包生产依赖生成 `packages/admin-web/dist/THIRD_PARTY_LICENSES.txt`，保留完整许可证、版权声明和 `NOTICE`（包括 ECharts 的补充许可文件）。此文件随静态管理端产物和生产镜像一起分发，可通过 `/THIRD_PARTY_LICENSES.txt` 访问。缺少许可正文的新增依赖会使构建失败，需先核对上游授权。

容器还包含 Node.js、Nginx 和 Alpine Linux 等上游软件，分别适用其原有许可证和声明。重新打包或分发时，应保留随上游发行物提供的许可材料。
