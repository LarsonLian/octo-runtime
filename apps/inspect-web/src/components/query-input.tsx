import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { queryCompletions, type QueryCompletion, type QueryField } from "../query";

interface QueryInputProps {
  value: string;
  error?: { message: string; offset: number };
  values: Partial<Record<QueryField, readonly string[]>>;
  onChange(value: string): void;
}

export function QueryInput({ value, error, values, onChange }: QueryInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const completions = useMemo(() => queryCompletions(value, cursor, values), [cursor, value, values]);

  const choose = (completion: QueryCompletion): void => {
    const next = value.slice(0, completion.from) + completion.insert + value.slice(completion.to);
    const nextCursor = completion.from + completion.insert.length;
    onChange(next);
    setCursor(nextCursor);
    setOpen(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" />
      <input
        ref={inputRef}
        id="query"
        role="combobox"
        aria-label="事件查询表达式"
        aria-autocomplete="list"
        aria-expanded={open && completions.length > 0}
        aria-controls="query-completions"
        aria-invalid={Boolean(error)}
        value={value}
        placeholder="筛选事件，例如 adapter_type=codebuddy"
        className="h-9 w-full border border-slate-300 bg-white pl-9 pr-3 font-mono text-xs text-slate-900 outline-none transition-colors placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        onChange={event => {
          onChange(event.target.value);
          setCursor(event.target.selectionStart ?? event.target.value.length);
          setActive(0);
          setOpen(true);
        }}
        onClick={event => {
          setCursor(event.currentTarget.selectionStart ?? value.length);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" && completions.length) {
            event.preventDefault();
            setOpen(true);
            setActive(index => (index + 1) % completions.length);
          } else if (event.key === "ArrowUp" && completions.length) {
            event.preventDefault();
            setOpen(true);
            setActive(index => (index - 1 + completions.length) % completions.length);
          } else if ((event.key === "Enter" || event.key === "Tab") && open && completions[active]) {
            event.preventDefault();
            choose(completions[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && completions.length > 0 && (
        <div
          id="query-completions"
          role="listbox"
          className="absolute left-0 top-10 z-30 max-h-64 w-full max-w-md overflow-auto rounded border border-slate-300 bg-white py-1 shadow-xl"
        >
          {completions.map((completion, index) => (
            <button
              key={`${completion.kind}:${completion.label}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className="flex h-8 w-full items-center justify-between px-3 text-left font-mono text-xs text-slate-700 hover:bg-slate-100 aria-selected:bg-indigo-50 aria-selected:text-indigo-800"
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(completion)}
            >
              <span>{completion.label}</span>
              <span className="font-sans text-[10px] uppercase text-slate-400">{completion.kind}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="absolute left-0 top-10 z-20 border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          第 {error.offset + 1} 个字符：{error.message}
        </div>
      )}
    </div>
  );
}
