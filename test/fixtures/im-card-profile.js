// 可用卡片能力的最小服务端 manifest；用于测试协商，不冒充真实 Bot 的在线配置。
export const imCardProfile = () => ({
  available: true,
  enabled: true,
  card_version: "1.5",
  profiles: ["octo/v1", "octo/v2"],
  config: {
    card_enabled: true,
    display_enabled: true,
    interaction_enabled: true,
    reasoning_enabled: true,
    reasoning_template_ref: { id: "ai.reasoning-process", version: "0.4.0" }
  },
  templating: {
    supported: true,
    wire: "template-ref/v1",
    templates: [
      {
        id: "ai.reasoning-process",
        version: "0.4.0",
        available: true,
        views: [
          {
            name: "active",
            wire_profile: "octo/v2",
            states: ["reasoning", "answering"],
            submit_actions: ["reasoning_stop"]
          },
          {
            name: "error",
            wire_profile: "octo/v2",
            states: ["error"],
            submit_actions: ["reasoning_retry"]
          },
          {
            name: "result",
            wire_profile: "octo/v1",
            states: ["completed", "stopped"],
            submit_actions: []
          }
        ]
      }
    ]
  }
});
