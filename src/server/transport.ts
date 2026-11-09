import "server-only";
import { deliverXmtp, type XmtpDelivery } from "./xmtp";

export type Transport = {
  send(input: XmtpDelivery): Promise<{ messageId: string; status: "sent" | "skipped" }>;
};

export function transport(): Transport {
  return {
    async send(input) {
      try {
        const status = await deliverXmtp(input);
        return { messageId: input.messageId, status };
      } catch {
        return { messageId: input.messageId, status: "skipped" };
      }
    },
  };
}

/** Wake carries a pointer. The inbox text stays in Collective. */
export async function notifyInbox(input: {
  toPlatformId: string;
  fromPlatformId: string;
  messageId: string;
}): Promise<"sent" | "skipped"> {
  const sent = await transport().send({
    kind: "pointer",
    fromPlatformId: input.fromPlatformId,
    toPlatformId: input.toPlatformId,
    messageId: input.messageId,
    jobId: "",
    turn: "inbox",
  });
  return sent.status;
}
