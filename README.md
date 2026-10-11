# 后端历史恢复归档（不完整）

此 recovery/backend-records-20261011 分支保存 felt-personal-blog 后端的**压缩恢复档案**。它不是展开后的源码仓库，不是最终后端，也不能构建或部署。

原 [main 分支](https://github.com/gaogo21/felt-personal-blog/tree/main) 的前端历史继续保留；本分支的恢复材料不替换原前端历史。

## 下载与核对

- [felt-backend-records-20261011.zip](felt-backend-records-20261011.zip)：含完整历史目录结构的恢复归档，378 个文件，解压后共 18,770,817 字节。
- [PUBLICATION-MANIFEST.json](PUBLICATION-MANIFEST.json)：逐文件原恢复 SHA-256 与公开副本 SHA-256 对照，以及本 ZIP 的信息。
- [CHECKSUMS.txt](CHECKSUMS.txt)：本目录 ZIP、README 与清单的 SHA-256。

ZIP SHA-256：`49ad846992c95282a8cdd369e4873db9eb39dad0bcc4b7d398490d05b3d9717b`。

解压目录为 felt-backend-records-20261011/，内含 snapshots/、fragments/、patch-records/、inventory.json、known-paths.csv、缺失清单及说明。不同历史版本分开保存，没有拼成一个声称可构建的项目。

## 已恢复与仍缺失

已知 710 个去重路径，其中 182 个至少有完整历史内容、38 个只有片段、490 个仅有路径或哈希。完整历史内容包括 77 个产品 C# 路径；35 个完整文件与保留的最终源码哈希相符，但产品 C# 最终版本验证仍为 0 个。

完整 BlogDbContext、EF Core 模型与迁移链、若干服务和 PostgreSQL 实现、完整测试树仍缺失。历史阶段及审查前后版本混杂，部分补丁没有基础文件。没有补写缺失实现，也没有对该恢复归档执行构建、数据库迁移、上线或部署验收。

目标原源码提交 5f6f048a3e4c77c5ef86638bcff280badc4f19ab 与目标原发布提交 f550a60fe54a9e7b0f108ad9fdbb8e98a51d1f5a 的完整 Git 对象和文件树仍不可用。不能由本归档精确还原此前报告的 270 个 src 文件或 1,473 个发布树文件。

## 来源和脱敏范围

原恢复 ZIP 的 SHA-256 为 d26858c5c1f11445bd15901832bc96a114e12e7ad98b329b65f0344cb66eacd7，原包保持不变。本归档为明确标注的 sanitized derivative（脱敏衍生副本）：仅规范化 11 份补丁文件头的绝对工作目录前缀、两份历史辅助脚本的 ROOT 路径及来源清单中的执行/输出记录标识。补丁正文与其余代码逻辑未改变。

每项字节变化均记录原恢复哈希和公开哈希；脱敏后的字节不沿用原哈希验证结论。归档内 ORIGINAL-SHA256SUMS.txt 保留原恢复校验值，SHA256SUMS.txt 校验当前公开内容。原版本、来源时间、内容范围、已知缺失和最终版本限制均保留。

输入 ZIP 哈希、所有原 CRC、374 项原文件校验值、358 项来源内容的 SHA-256/Git blob SHA-1、51 项补丁哈希及本次输出 ZIP 的全部条目均已核验。此核验只确认材料完整保存及脱敏范围，不表示产品安全审计或功能验收通过。

本归档未新增整体许可证；原有许可证及资源来源记录只适用于各自范围。
