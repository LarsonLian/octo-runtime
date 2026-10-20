import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createExecutorFixture } from "../../test-support/executor-adapter.mjs";

serveAdapterHost([createExecutorFixture()]);
