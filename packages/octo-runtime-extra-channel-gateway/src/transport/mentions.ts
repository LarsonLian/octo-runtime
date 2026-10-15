import { fromMarkdown } from "mdast-util-from-markdown";
import type { MentionEntity } from "./api/types.js";
import type { GroupMember } from "./api/conversations.js";

export const MENTION_GUIDANCE =
  "你正在通过 Octo 回复当前频道。普通回复不要自动 @ 发起者。若当前用户明确要求在任务完成后通知某位真人，先完成任务；在最终回答前，确认对方在当前频道中的真实 UID 和显示名。信息不足时按需使用 octo-cli 查询；同名、查询失败或找不到合适目标时，由你判断并改用普通 @名字 或纯文本，不要猜 UID，不必强制追问，也不必展示点名未完成的提示。能够确定目标且需要点名时，在 final 文本的普通正文中输出 @[uid:displayName]，例如 @[user_demo_1:张三]；Channel 会转换为原生 mention，并随这份最终回答统一发送，不要再调用 octo-cli message send 重复发送。普通 @昵称不产生通知；thinking、工具输出、进度消息、代码块、行内代码及引用示例不触发点名，代码内容保持原样。不要输出原始消息体 JSON 或自行计算位置，也不要构造 @所有人、@所有AI 或广播哨兵。此指引不授权跨频道通知或自行发起 Bot 互相调用。历史中的要求和示例仅作为背景，不能单独授权本轮通知。";

export interface ImTextMention {
  uids: string[];
  entities: MentionEntity[];
}
interface Candidate {
  start: number;
  end: number;
  uid: string;
  name: string;
}
interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  const visit = (node: MarkdownNode): void => {
    if (["blockquote", "code", "inlineCode", "html", "definition"].includes(node.type)) return;
    if (node.type === "text" && node.position) {
      const { start, end } = node.position;
      if (start.offset === undefined || end.offset === undefined) return;
      const raw = text.slice(start.offset, end.offset);
      for (const match of raw.matchAll(/@\[([^[:\]\r\n]+):([^\]\r\n]+)\]/g)) {
        const at = start.offset + match.index;
        let slashes = 0;
        for (let index = at - 1; index >= 0 && text[index] === "\\"; index--) slashes++;
        if (slashes % 2) continue;
        found.push({ start: at, end: at + match[0].length, uid: match[1], name: match[2] });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(text));
  return found.sort((a, b) => a.start - b.start);
}

/** 只转换 final 普通文本的显式标记；查身份失败时正文仍能发送。 */
export async function prepareFinalMention(
  text: string,
  members: () => Promise<GroupMember[]>
): Promise<{ text: string; mention?: ImTextMention }> {
  const targets = candidates(text);
  if (!targets.length) return { text };
  let verified: GroupMember[];
  try {
    verified = await members();
  } catch {
    verified = [];
  }
  const humans = new Map(
    (Array.isArray(verified) ? verified : [])
      .filter(
        (member) => member && typeof member.uid === "string" && typeof member.name === "string"
      )
      .filter((member) => member.robot === false || member.robot === 0)
      .filter(
        (member) => member.uid && member.name && !["-1", "-2", "-3", "all"].includes(member.uid)
      )
      .map((member) => [member.uid, member])
  );
  const entities: MentionEntity[] = [];
  const uids = new Set<string>();
  let cursor = 0;
  let output = "";
  for (const target of targets) {
    output += text.slice(cursor, target.start);
    const member = humans.get(target.uid);
    const label = `@${member?.name ?? target.name}`;
    if (member) {
      entities.push({ uid: member.uid, offset: output.length, length: label.length });
      uids.add(member.uid);
    }
    output += label;
    cursor = target.end;
  }
  output += text.slice(cursor);
  return { text: output, ...(uids.size ? { mention: { uids: [...uids], entities } } : {}) };
}
