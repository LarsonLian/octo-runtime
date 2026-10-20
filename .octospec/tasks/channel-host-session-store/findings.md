---
type: Task
title: Issue 57 实施发现
description: 调用链、所有权与停止收尾边界。
tags: [channel, session, extra]
timestamp: 2026-10-20T00:00:00Z
---

# Issue 57 源码结论

- SDK 函数依赖在本进程保留，Gateway 未声明/消费工厂。
- Runtime 默认 Memory，借用 sessions 不关闭；Manager 需要拥有工厂句柄。
- Runtime 停止后立即跳出事件消费，会丢弃在途 session.update；需要有界收尾。
- Extra loader 已有 5 秒共享清理期限和失败阻止重载，无需新增通用卸载协议。
- Store 接口读写同步；只把 close 放宽为 void | Promise<void>。

- 工厂 disabled Bot 不分配句柄；校验后的配置再次复制，宿主改动不影响 Runtime。
- Manager 初始化等待也需要清理期限：关闭立即启动已创建实例清理，不能先无限等待配置队列。

第二轮发现：SDK LocalExtras 的 signal 直接销毁订阅 socket，Gateway 收尾依赖的尾事件实际收不到；Manager 未监听 owner abort，卡住的 initializer 会推迟全部 disposer；Runtime 吞掉的 draining 存储异常须由租约记录为 cleanup failure；关闭后忽略终态会误入未知结果展示；无效 async 工厂的 Promise 拒绝也须消费并回收迟到句柄。
