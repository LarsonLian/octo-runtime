---
type: Task
title: Gateway 宿主会话存储工厂接线
description: Issue 57 的公开工厂合同、逐 Bot 装配和存储句柄生命周期。
tags: [channel, session, extra]
timestamp: 2026-10-20T00:00:00Z
---

# 目标与范围

宿主显式注入会话存储后，Gateway 经公开三参数 loadExtra 实际消费，每个 Bot 使用自己的句柄，重载可恢复逻辑 session 与可恢复 Provider session。需求来源为 Issue 57，用户已授权实现、测试和 SDK 文档；初次实现及复审阶段禁止提交推送，2026-10-20 后续明确授权提交、推送并创建 PR。发布仍未授权。

决定权在宿主：数据库、scope、加密、保留期限与账号租约由宿主管理；Gateway 只负责消费存储和受控收尾。未配置工厂仍使用有界 Memory，不让持久化成为其他产品默认行为，不修改 Core/Provider/WeCom。函数及数据库不进入 IPC/JSON。保留直接注入 sessions 的借用语义。

# 关键合同

- GatewayDependencies 继承 ChannelDependencies，增加同步 createSessionStore(JsonObject): ImSessionStore；配置已验证并独立复制，保留扩展字段，不能从入站消息选择宿主 scope。
- 工厂返回句柄由 Manager 拥有，旧实例收尾成功后才释放并替换；close 可异步，幂等且失败不冒充成功。直接 sessions 不关闭。
- 停止接纳、取消执行、等待尾任务；收尾阶段只消费合法的 session.update，不继续模型展示、交互或最终投递。同 session/generation 校验防止 reset 后迟到覆盖。
- 关闭后拒绝迟到访问；清理有界且失败阻止重载。宿主在 draining 期间允许收尾写入，失败/超时负责最终撤权，句柄 close 不关闭共享数据库。
- 工厂/接口/存储异常可观察，不回退 Memory；逐 Bot 错误沿现有 Extra 状态暴露。

# 验收

1. 公开类型无需断言编译；Extra 实际调用工厂并完成存储读写。
2. 临时 SQLite 关闭重开及 Extra 重载恢复逻辑及 Provider session；Bot/scope/聊天隔离。
3. reset 幂等、generation 递增、旧任务迟到更新无效；存储失败不回退。
4. 默认 Memory、借用存储、remove/upsert、初始化失败、在途卸载、重复关闭、失败/超时阻止替换和 SDK stop/账号切换。
5. SDK 文档说明接口、scope、错误状态、5 秒宽限、句柄和数据库所有权。
6. 构建、类型、lint、跨包测试与 OKF 检查；真实 IM/Provider 联调另记，不能以 fake 验收代替。


# 第二轮复审补充验收

- SDK owner abort 与强制 detach 分开：接纳 ACK 即可取消，不等 Provider 首帧；get 返回值严格提取 receipt 字段，锁定原 stream/invocation/session/generation/protocol。
- 取消失败、身份或 stream 冲突、提前停止消费、断流和 5 秒超时均不能伪装已收尾；ACK 丢失时保留原安全取消路径，不因抑制重复取消而遗留执行。
- 真实 Gateway + 工厂 + LocalExtras + JSON-RPC socket 验证取消后 binding 进入存储再释放；普通 caller abort 语义不变。
- 挂起初始化收到 owner abort 后即开始撤权计时；draining 读写失败持续报告 cleanup failure；正常收尾不刷新 presentation、不额外取消。
- 无效 Promise 工厂继续拒绝，但消费其拒绝并回收迟到返回句柄，不能使 Node 因 unhandledRejection 退出。
