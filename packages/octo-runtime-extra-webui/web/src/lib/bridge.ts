import { api } from "./api";
import type { ApprovalView } from "../shared/work-state";
import type { InteractionResponse } from "@mininglamp-oss/octo-runtime-protocol";
let invocationId = "";
let interactions: ApprovalView[] = [];
export const images = new Map<string, string>();
export function bindInteractions(id: string, values: ApprovalView[]) {
  invocationId = id;
  interactions = values;
}
export function ipcErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
export const octoWork = {
  async readConversationImage(input: { owner: unknown; resourceId: string }) {
    const image = images.get(input.resourceId);
    if (!image) throw new Error("IMAGE_UNAVAILABLE");
    return image;
  },
  agentAccess: {
    async respondInteraction(input: InteractionResponse & { owner: unknown }) {
      const response = {
        interactionId: input.interactionId,
        outcome: input.outcome,
        ...(input.value === undefined ? {} : { value: input.value })
      };
      await api(`/invocations/${invocationId}/respond`, "POST", response);
      return { status: "responding" };
    },
    async getInteraction(input: { owner: unknown; interactionId: string }) {
      const interaction = interactions.find((item) => item.interactionId === input.interactionId);
      if (!interaction) throw new Error("INTERACTION_UNAVAILABLE");
      return interaction;
    }
  }
};
