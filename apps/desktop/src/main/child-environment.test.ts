import { expect, it } from "vitest";
import { childEnvironment } from "./child-environment.js";
it("does not pass developer credentials, proxy configuration or Node options to the backend", () => {
  expect(childEnvironment({ SystemRoot: "C:\\Windows", TEMP: "temp", GH_TOKEN: "synthetic-canary",
    OPENAI_API_KEY: "synthetic-canary", HTTPS_PROXY: "synthetic-canary", NODE_OPTIONS: "--inspect" }))
    .toEqual({ SystemRoot: "C:\\Windows", TEMP: "temp" });
});
