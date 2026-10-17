/** Count JSON bytes without allocating the complete serialized input. */
export function assertJsonByteLimit(value: unknown, limit: number, code: string): void {
  let bytes = 0;
  const parents = new Set<object>();
  const add = (count: number): void => {
    bytes += count;
    if (bytes > limit) throw Object.assign(new Error(code), { code });
  };
  const string = (text: string): void => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      if (char === 34 || char === 92 || [8, 9, 10, 12, 13].includes(char)) add(2);
      else if (char < 32) add(6);
      else if (char < 128) add(1);
      else if (char < 2048) add(2);
      else if (char >= 0xd800 && char <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          add(4);
          i++;
        } else add(6);
      } else if (char >= 0xdc00 && char <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError("JSON_DEPTH_EXCEEDED");
    if (typeof item === "string") {
      string(item);
      return;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      add(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== "object") throw new TypeError("JSON_VALUE_REQUIRED");
    if (parents.has(item)) throw new TypeError("JSON_CIRCULAR_REFERENCE");
    const array = Array.isArray(item);
    if (
      !array &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("JSON_OBJECT_REQUIRED");
    parents.add(item);
    add(2);
    let first = true;
    if (array) {
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor && !("value" in descriptor))
          throw new TypeError("JSON_ACCESSOR_UNSUPPORTED");
        if (!first) add(1);
        first = false;
        visit(descriptor?.value ?? null, depth + 1);
      }
    } else {
      for (const key in item) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor) continue;
        if (!("value" in descriptor)) throw new TypeError("JSON_ACCESSOR_UNSUPPORTED");
        if (descriptor.value === undefined) continue;
        if (!first) add(1);
        first = false;
        string(key);
        add(1);
        visit(descriptor.value, depth + 1);
      }
    }
    parents.delete(item);
  };
  visit(value, 0);
}
