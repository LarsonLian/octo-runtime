import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { testAdapter } from "./test-adapter.js";

const mode = process.env.OCTO_TEST_HOST_SELECTION;
serveAdapterHost(mode === "empty" ? [] : mode === "duplicate" ? [testAdapter, testAdapter] : [testAdapter]);
