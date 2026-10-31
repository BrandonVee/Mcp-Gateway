# 参与贡献

欢迎提交问题、文档改进和 Pull Request，中英文均可。较大的功能或架构调整，请先创建 Issue 说明使用场景和方案，便于讨论范围。

## 报告问题

在 [Issues](https://github.com/BrandonVee/Mcp-Gateway/issues) 中提供版本或提交号、部署方式、复现步骤、预期与实际结果，以及已脱敏的日志。安全漏洞请按照 [安全政策](SECURITY.md) 私下报告。

请勿提交 `.env.local`、生产配置、数据库备份、访问令牌、用户信息或包含这些内容的截图。

## 本地开发

需要 Node.js 20.19+（20.x）或 ≥ 22.12、pnpm 10.33.0，以及 PostgreSQL 和 Redis。首次运行按 [开发文档](docs/development.md#方式一容器运行数据库宿主机运行应用) 配置依赖和本地环境，再执行：

```bash
pnpm install --frozen-lockfile
pnpm dev:local
```

模块边界与数据流见 [架构说明](docs/architecture.md)，路径别名和开发约定见 [开发文档](docs/development.md#路径别名与工具边界)。优先复用已有组件和工具，保持改动聚焦；行为或部署方式发生变化时同步对应文档。

## 提交 Pull Request

1. Fork 仓库，从 `main` 创建分支。
2. 在描述中说明解决的问题、最终行为和验证结果，关联相关 Issue；界面改动附桌面和移动端效果。
3. 逻辑改动优先运行直接相关的现有测试。关键逻辑、复杂边界或易复发的缺陷补充回归测试；文案、样式等小改动通常不需要新增测试。
4. 提交前检查差异，移除临时文件、调试代码和敏感信息。

CI 会执行以下检查：

```bash
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm build:admin
pnpm build:runtime
pnpm audit --prod --audit-level high
```

只对修改过的文件运行 `pnpm exec prettier --write <文件路径>`，避免无关的全仓格式变更。端到端测试使用独立测试数据库和 `tests/fixtures/`，不要对生产数据执行测试或导入测试用户；运行方式及 CI 覆盖见 [冒烟测试说明](docs/development.md#冒烟测试)。

## 许可证

提交用于合入本项目的贡献按 [Apache License 2.0](LICENSE) 接收。请确认有权提交相应代码、文档和资源；引入第三方内容时保留其许可证和版权声明，并更新 [第三方声明](THIRD_PARTY_NOTICES.md)。
