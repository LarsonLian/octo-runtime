import type { InspectRecord } from "./domain";

export const QUERY_FIELDS = [
  "profile",
  "runtime_key",
  "source",
  "stage",
  "direction",
  "type",
  "adapter_type",
  "session_id",
  "run_key",
  "invocation_id",
  "status"
] as const;
export type QueryField = typeof QUERY_FIELDS[number];

type TokenKind = "word" | "string" | "operator" | "and" | "or" | "left" | "right";
interface Token { kind: TokenKind; value: string; offset: number }
type Predicate = (record: InspectRecord) => boolean;

export interface CompiledQuery {
  predicate: Predicate;
  error?: { message: string; offset: number };
}

export interface QueryCompletion {
  label: string;
  insert: string;
  from: number;
  to: number;
  kind: "field" | "operator" | "value" | "logic";
}

export function compileQuery(input: string): CompiledQuery {
  if (!input.trim()) return { predicate: () => true };
  try {
    const tokens = tokenize(input);
    let cursor = 0;
    const peek = (): Token | undefined => tokens[cursor];
    const take = (kind?: TokenKind): Token => {
      const token = tokens[cursor];
      if (!token) throw syntaxError("表达式不完整", input.length);
      if (kind && token.kind !== kind) throw syntaxError(`这里需要 ${tokenLabel(kind)}`, token.offset);
      cursor += 1;
      return token;
    };
    const primary = (): Predicate => {
      if (peek()?.kind === "left") {
        take("left");
        const nested = orExpression();
        take("right");
        return nested;
      }
      const fieldToken = take("word");
      if (!QUERY_FIELDS.includes(fieldToken.value as QueryField)) {
        throw syntaxError(`未知字段 ${fieldToken.value}`, fieldToken.offset);
      }
      const operator = take("operator");
      const value = take();
      if (value.kind !== "word" && value.kind !== "string") {
        throw syntaxError("运算符后需要一个值", value.offset);
      }
      return comparison(fieldToken.value as QueryField, operator.value, value.value);
    };
    const andExpression = (): Predicate => {
      const predicates = [primary()];
      while (peek()?.kind === "and") {
        take("and");
        predicates.push(primary());
      }
      return record => predicates.every(predicate => predicate(record));
    };
    function orExpression(): Predicate {
      const predicates = [andExpression()];
      while (peek()?.kind === "or") {
        take("or");
        predicates.push(andExpression());
      }
      return record => predicates.some(predicate => predicate(record));
    }
    const predicate = orExpression();
    const trailing = peek();
    if (trailing) throw syntaxError(`无法识别 ${trailing.value}`, trailing.offset);
    return { predicate };
  } catch (error) {
    const parsed = error as Error & { offset?: number };
    return {
      predicate: () => true,
      error: { message: parsed.message, offset: parsed.offset ?? 0 }
    };
  }
}

export function queryCompletions(
  input: string,
  cursor: number,
  values: Partial<Record<QueryField, readonly string[]>>
): QueryCompletion[] {
  const prefix = input.slice(0, cursor);
  const fieldMatch = prefix.match(/(?:^|\(|\b(?:and|or)\s+)([a-z_]*)$/i);
  if (fieldMatch) {
    const partial = fieldMatch[1] ?? "";
    return QUERY_FIELDS.filter(field => field.startsWith(partial.toLowerCase())).map(field => ({
      label: field,
      insert: `${field}=`,
      from: cursor - partial.length,
      to: cursor,
      kind: "field"
    }));
  }
  const valueMatch = prefix.match(/\b(profile|runtime_key|source|stage|direction|type|adapter_type|session_id|run_key|invocation_id|status)\s*(?:=|!=|~=)\s*([\w.\-:/]*)$/i);
  if (valueMatch) {
    const field = valueMatch[1].toLowerCase() as QueryField;
    const partial = valueMatch[2] ?? "";
    return [...new Set(values[field] ?? [])]
      .filter(value => value.toLowerCase().includes(partial.toLowerCase()))
      .slice(0, 12)
      .map(value => ({ label: value, insert: value, from: cursor - partial.length, to: cursor, kind: "value" }));
  }
  const operatorMatch = prefix.match(/\b(profile|runtime_key|source|stage|direction|type|adapter_type|session_id|run_key|invocation_id|status)\s*([!~=]*)$/i);
  if (operatorMatch) {
    const partial = operatorMatch[2] ?? "";
    return ["=", "!=", "~="].filter(operator => operator.startsWith(partial)).map(operator => ({
      label: operator,
      insert: operator,
      from: cursor - partial.length,
      to: cursor,
      kind: "operator"
    }));
  }
  if (/\b[\w.\-:/"']+\s+$/i.test(prefix)) {
    return ["and", "or"].map(value => ({ label: value, insert: `${value} `, from: cursor, to: cursor, kind: "logic" }));
  }
  return [];
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < input.length) {
    if (/\s/.test(input[offset])) { offset += 1; continue; }
    const start = offset;
    const char = input[offset];
    if (char === "(") { tokens.push({ kind: "left", value: char, offset }); offset += 1; continue; }
    if (char === ")") { tokens.push({ kind: "right", value: char, offset }); offset += 1; continue; }
    const operator = input.slice(offset).match(/^(?:!=|~=|=)/)?.[0];
    if (operator) { tokens.push({ kind: "operator", value: operator, offset }); offset += operator.length; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      offset += 1;
      let value = "";
      while (offset < input.length && input[offset] !== quote) {
        if (input[offset] === "\\" && offset + 1 < input.length) offset += 1;
        value += input[offset] ?? "";
        offset += 1;
      }
      if (input[offset] !== quote) throw syntaxError("字符串缺少结束引号", start);
      offset += 1;
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    const word = input.slice(offset).match(/^[\w.\-:/]+/)?.[0];
    if (!word) throw syntaxError(`无法识别字符 ${char}`, offset);
    const lowered = word.toLowerCase();
    tokens.push({ kind: lowered === "and" || lowered === "or" ? lowered : "word", value: word, offset });
    offset += word.length;
  }
  return tokens;
}

function comparison(field: QueryField, operator: string, expected: string): Predicate {
  const normalizedExpected = expected.toLowerCase();
  return record => {
    const actual = fieldValue(record, field).toLowerCase();
    if (operator === "=") return actual === normalizedExpected;
    if (operator === "!=") return actual !== normalizedExpected;
    return actual.includes(normalizedExpected);
  };
}

function fieldValue(record: InspectRecord, field: QueryField): string {
  switch (field) {
    case "profile": return record.profile;
    case "runtime_key": return record.runtimeKey;
    case "source": return record.source;
    case "stage": return record.stage;
    case "direction": return record.direction;
    case "type": return record.type;
    case "adapter_type": return record.adapterType;
    case "session_id": return record.sessionId;
    case "run_key": return record.runKey;
    case "invocation_id": return record.invocationId;
    case "status": return record.status;
  }
}

function syntaxError(message: string, offset: number): Error & { offset: number } {
  return Object.assign(new Error(message), { offset });
}

function tokenLabel(kind: TokenKind): string {
  if (kind === "operator") return "运算符";
  if (kind === "right") return ")";
  return "条件";
}
