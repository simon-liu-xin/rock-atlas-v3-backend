# Rock Atlas V3 后端

离线多源数据后端：MusicBrainz、Discogs、Wikidata 获取与校验，身份归一、
交叉验证、规范 SQL generation、完整性与许可证检查、更新与恢复。后端在本机
或构建机运行，线上网站使用 JSON，不提供实时 SQL 查询 API。

```bash
npm ci
npm run check
```

## 当前限定目录

```bash
npm run data:catalog:build
npm run data:catalog:postgres
```

来源聚合输入已保留，原有多源合并和交叉验证不变。`data:catalog:postgres` 需要
Docker，会建立或复核隔离 SQL generation 并导出受审内部投影。

输出在 `data/published/rock-catalog-v2/`，目录名是内部输入 schema，不能作为
V3 网站数据直接上传。这些生成文件被 Git 忽略。数据源全量获取与当前代表样本
是不同执行范围，首次全量运行必须满足容量、来源完整性与授权要求。

## 全量编排

把 JSON builder 克隆到相邻 `rock-atlas-v3-json-builder` 目录并安装其依赖。
全量流水线后两个阶段会调用该仓库；目录不相邻时设置
`ROCK_ATLAS_JSON_BUILDER_ROOT` 为绝对路径。

`npm run data:full:pipeline` 仍默认 dry-run，必须提供受审 plan 等参数。
只有显式执行、独立磁盘、下载授权、完整输入和 Gate A 满足后才进行全量获取
和发布；本仓库不包含真实全量 archive 或生产数据库。

不要把源归档、数据库密码、数据缓存、SQL 备份或 generation 输出提交到 Git。
共享契约 `schemas/` 修改后需同步 JSON builder 与前端。
