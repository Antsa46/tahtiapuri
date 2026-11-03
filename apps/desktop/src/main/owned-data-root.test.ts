import { expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prepareOwnedDataRoot } from "./owned-data-root.js";
it("creates only the owned root and refuses a linked existing ancestor before creating a child", async () => {
  await mkdir(".artifacts/tests/t08", { recursive: true }); const root = await mkdtemp(resolve(".artifacts/tests/t08/data-root-"));
  try {
    const own = prepareOwnedDataRoot(join(root, "own", "data")); expect(own).toBe(join(root, "own", "data"));
    const outside = join(root, "outside"); await mkdir(outside);
    await symlink(outside, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareOwnedDataRoot(join(root, "alias", "should-not-exist"))).toThrow("Data root unavailable");
    await expect(access(join(outside, "should-not-exist"))).rejects.toThrow();
    expect(() => prepareOwnedDataRoot("relative/data")).toThrow("Data root unavailable");
    expect(() => prepareOwnedDataRoot("//synthetic.invalid/share/data")).toThrow("Data root unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
