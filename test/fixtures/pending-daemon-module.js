export function createPendingModule({ signal }) {
  return {
    status: {},
    async start() {
      if (signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    async handle() {
      return "unreachable";
    },
    async close() {}
  };
}
