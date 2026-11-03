import { expect, it } from "vitest";
import { isTrustedSender } from "./sender-policy.js";
import { PAGE_URL } from "./local-page.js";
function fixture() {
  const frame = { url: PAGE_URL };
  const owner = { isDestroyed: () => false, mainFrame: frame };
  return { frame, owner, event: { sender: owner, senderFrame: frame } };
}
it("accepts only the owned top frame at the exact local page URL", () => {
  const { owner, event } = fixture();
  expect(isTrustedSender(event as never, owner as never, PAGE_URL)).toBe(true);
});
it.each(["window", "subframe", "origin", "destroyed"])("rejects a forged sender: %s", kind => {
  const { owner, event } = fixture();
  if (kind === "window") event.sender = { ...owner };
  if (kind === "subframe") event.senderFrame = { ...owner.mainFrame };
  if (kind === "origin") owner.mainFrame.url = PAGE_URL + "?forged";
  if (kind === "destroyed") owner.isDestroyed = () => true;
  expect(isTrustedSender(event as never, owner as never, PAGE_URL)).toBe(false);
});
