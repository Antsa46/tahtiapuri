import type { IpcMainInvokeEvent, WebContents } from "electron";
export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  owner: WebContents,
  pageUrl: string,
): boolean {
  return !owner.isDestroyed() && event.sender === owner
    && event.senderFrame !== null && event.senderFrame === owner.mainFrame
    && event.senderFrame.url === pageUrl;
}
