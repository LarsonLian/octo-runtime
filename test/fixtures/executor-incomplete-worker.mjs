import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createExecutorFixture } from "../../test-support/executor-adapter.mjs";

const adapter = createExecutorFixture();
adapter.invoke = () => {
  let first = true;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (!first) return new Promise(() => {});
      first = false;
      return Promise.resolve({
        done: false,
        value: { kind: "native", messageKind: "notification", payload: { ready: true } }
      });
    },
    async return() {
      throw new Error("fixture cleanup remains incomplete");
    }
  };
};
serveAdapterHost([adapter]);
