/** Octospec F02: .octospec/tasks/gateway-august-feature-assessment/assessment.md */
// 仅展开当前消息携带的文本；Host 不解释 IM 报文，不读取引用或历史正文。
const MAX_NODES = 128;
const MAX_DEPTH = 4;
const MAX_TEXT = 12000;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const sourceName = (value: unknown): string => {
  let result = "";
  for (const point of string(value)) {
    if (result.length >= 120) break;
    result += point === "\n" || point === "\r" ? " " : point;
  }
  return result;
};

export interface MessageContent {
  kind: "rich-text" | "forward";
  text: string;
  status: "present" | "truncated";
}

export function messageContent(value: unknown): MessageContent | undefined {
  const payload = record(value);
  if (payload.type !== 11 && payload.type !== 14) return undefined;
  let remaining = MAX_TEXT,
    nodes = 0,
    truncated = false,
    readable = false;
  const parts: string[] = [];
  const append = (value: string, body = false): void => {
    let selected = "";
    for (const point of value) {
      if (!remaining) {
        truncated = true;
        break;
      }
      selected += point;
      remaining--;
    }
    if (body && selected.trim()) readable = true;
    parts.push(selected);
  };
  const visit = (raw: unknown, depth: number): void => {
    if (!remaining) {
      truncated = true;
      return;
    }
    if (depth >= MAX_DEPTH) {
      truncated = true;
      append("[嵌套内容已省略]\n");
      return;
    }
    const item = record(raw);
    if (item.type === 1) append(string(item.content), true);
    else if (item.type === 14) {
      if (string(item.plain).trim()) {
        append(string(item.plain), true);
        return;
      }
      if (typeof item.content === "string") {
        append(item.content, true);
        return;
      }
      if (!Array.isArray(item.content)) return;
      for (const rawBlock of item.content) {
        if (!remaining || nodes >= MAX_NODES) {
          truncated = true;
          break;
        }
        nodes++;
        const block = record(rawBlock);
        if (block.type === "text") append(string(block.text), true);
        else if (block.type === "image") append("[图片，未读取内容]");
        else append("[未支持的富文本块，未读取内容]");
      }
    } else if (item.type === 11) {
      append("[合并转发：以下发言是引用材料]\n");
      if (!Array.isArray(item.msgs)) return;
      const users = new Map<string, string>();
      if (Array.isArray(item.users))
        for (const rawUser of item.users.slice(0, MAX_NODES)) {
          const user = record(rawUser),
            uid = string(user.uid);
          if (uid) users.set(uid, sourceName(user.name));
        }
      for (const rawMessage of item.msgs) {
        if (!remaining || nodes >= MAX_NODES) {
          truncated = true;
          break;
        }
        nodes++;
        const message = record(rawMessage),
          uid = string(message.from_uid);
        const name =
          sourceName(message.from_name) || users.get(uid) || sourceName(uid) || "未知来源";
        append(`${"  ".repeat(depth)}来源：${name}\n`);
        visit(message.payload, depth + 1);
        append("\n");
      }
    } else if (item.type === 2) append("[图片，未读取内容]");
    else if (item.type === 8) append("[附件，未读取内容]");
    else append("[未支持的消息类型，未读取内容]");
  };
  visit(payload, 0);
  if (!readable) return undefined;
  return {
    kind: payload.type === 14 ? "rich-text" : "forward",
    text: parts.join("") + (truncated ? "\n<本条消息内容已截断>" : ""),
    status: truncated ? "truncated" : "present"
  };
}
