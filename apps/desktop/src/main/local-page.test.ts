import { expect, it } from "vitest";
import { localPageResponse } from "./local-page.js";
it.each([
  "tahtiapuri://other/index.html", "tahtiapuri://app/.env",
  "tahtiapuri://app/assets/..%5csecret.js", "tahtiapuri://app/index.html?file=secret",
])("rejects a non-application asset without reading it: %s", async url => {
  const response = await localPageResponse(new Request(url), "nonexistent-root");
  expect(response.status).toBeGreaterThanOrEqual(400);
});
