import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  Home,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  X,
  ChevronRight,
  ArrowUp
} from "lucide-react";
import { createParser } from "eventsource-parser";
import type {
  ApprovalMode,
  CanonicalEvent,
  ModelInputPart
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ConversationMessage, RuntimeAdapter } from "./shared/contracts";
import { workbenchReducer, initialWorkbenchState, type WorkbenchState } from "./shared/work-state";
import { RawRunPresentation } from "./shared/raw-presentation";
import { TranscriptScroller } from "./surfaces/TranscriptScroller";
import { ModelPicker } from "./surfaces/ModelPicker";
import { ApprovalPolicyPicker } from "./surfaces/ApprovalPolicyPicker";
import { ApprovalCards } from "./surfaces/ApprovalCards";
import { ConversationComposer } from "./components/ConversationComposer";
import { Modal } from "./components/Modal";
import { api, bootstrap, invoke, type Session } from "./lib/api";
import { bindInteractions, images } from "./lib/bridge";
import { providerName } from "./lib/provider-names";

const owner = { type: "local", id: "webui" };
const projectKey = "octo-runtime-webui.projects.v1";
interface Directory {
  path: string;
  parent: string;
  directories: Array<{ name: string; path: string }>;
}
interface Attachment {
  id: string;
  name: string;
  url: string;
  part: ModelInputPart;
}
export function App() {
  const [projects, setProjects] = useState<string[]>([]),
    [project, setProject] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<Session>();
  const selectedRef = useRef<Session | undefined>(undefined);
  const [adapters, setAdapters] = useState<RuntimeAdapter[]>([]),
    [adapter, setAdapter] = useState(""),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState("medium");
  const [approval, setApproval] = useState<ApprovalMode>("ask"),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(""),
    [stopping, setStopping] = useState(false);
  const [work, setWork] = useState<WorkbenchState>(initialWorkbenchState),
    [historyCount, setHistoryCount] = useState(0),
    [attachments, setAttachments] = useState<Attachment[]>([]);
  const [directory, setDirectory] = useState<Directory>(),
    [directoryPath, setDirectoryPath] = useState(""),
    [settings, setSettings] = useState(false),
    [models, setModels] = useState<string[]>(() => {
      try {
        return JSON.parse(sessionStorage.getItem("octo-runtime-webui.models") ?? "[]");
      } catch {
        return [];
      }
    }),
    [newModel, setNewModel] = useState(""),
    [search, setSearch] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [clear, setClear] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    run = useRef<
      | { id: string; sessionId: string; controller: AbortController; state: WorkbenchState }
      | undefined
    >(undefined);
  const persistQueue = useRef(Promise.resolve()),
    alive = useRef(true),
    clearedSessions = useRef(new Set<string>());
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  async function refresh() {
    const next = await api<Session[]>("/sessions");
    setSessions(next);
    if (selectedRef.current && !next.some((session) => session.id === selectedRef.current?.id))
      choose(undefined);
  }
  async function refreshAdapters() {
    const values = await api<RuntimeAdapter[]>("/adapters");
    setAdapters(values);
    setAdapter(
      (current) =>
        current ||
        ["codex", "claude-code", "codebuddy", "openclaw"].find((type) =>
          values.some((value) => value.providerType === type && value.available)
        ) ||
        values.find((value) => value.available)?.providerType ||
        ""
    );
  }
  useEffect(() => {
    alive.current = true;
    void bootstrap()
      .then(async (value) => {
        let saved: string[] = [];
        try {
          const parsed: unknown = JSON.parse(sessionStorage.getItem(projectKey) ?? "[]");
          if (Array.isArray(parsed))
            saved = parsed.filter((path): path is string => typeof path === "string");
        } catch {
          saved = [];
        }
        const paths = [...new Set([value.defaultProjectPath, ...saved])];
        setProjects(paths);
        const preferred = sessionStorage.getItem("octo-runtime-webui.project");
        const currentProject = preferred && paths.includes(preferred) ? preferred : paths[0];
        choose(undefined, currentProject, false);
        await Promise.all([refresh(), refreshAdapters()]);
        const id = /^#\/sessions\/([a-f0-9-]+)$/.exec(location.hash)?.[1];
        if (id) choose(await api<Session>(`/sessions/${id}`), currentProject, false);
      })
      .catch(report);
    const listener = () => setSettings(true);
    const navigate = () => {
      const id = /^#\/sessions\/([a-f0-9-]+)$/.exec(location.hash)?.[1];
      if (id)
        void api<Session>(`/sessions/${id}`)
          .then((session) => choose(session, session.projectPath, false))
          .catch(report);
      else choose(undefined, sessionStorage.getItem("octo-runtime-webui.project") ?? "", false);
    };
    window.addEventListener("popstate", navigate);
    window.addEventListener("webui:settings", listener);
    return () => {
      alive.current = false;
      run.current?.controller.abort();
      window.removeEventListener("webui:settings", listener);
      window.removeEventListener("popstate", navigate);
    };
  }, []);
  function draftKey(id?: string, path = project) {
    return `octo-runtime-webui.draft:${id ?? path}`;
  }
  function editDraft(value: string) {
    setDraft(value);
    try {
      sessionStorage.setItem(draftKey(selectedRef.current?.id), value);
    } catch (cause) {
      report(cause);
    }
  }
  function choose(session: Session | undefined, nextProject = project, updateUrl = true) {
    images.clear();
    for (const message of session?.messages ?? [])
      for (const part of message.parts ?? []) {
        if (part.type === "image" && part.dataUrl)
          images.set(part.artifact.artifact_id, part.dataUrl);
      }
    selectedRef.current = session;
    setSelected(session);
    const activeRun = run.current?.sessionId === session?.id ? run.current : undefined;
    const firstLive = activeRun?.state.messages.findIndex(
      (message) => message.executionId === activeRun.id
    );
    setHistoryCount(activeRun && firstLive !== undefined && firstLive >= 0
      ? firstLive : session?.messages.length ?? 0);
    setWork(
      run.current?.sessionId === session?.id && run.current
        ? run.current.state
        : {
            ...initialWorkbenchState,
            messages:
              session?.messages.map((message) =>
                message.status === "streaming" || message.status === "queued"
                  ? {
                      ...message,
                      status: "disconnected",
                      transportError: "连接已结束，请发送新消息继续。"
                    }
                  : message
              ) ?? []
          }
    );
    const path = session?.projectPath ?? nextProject;
    setProject(path);
    setAttachments([]);
    try {
      sessionStorage.setItem("octo-runtime-webui.project", path);
      setDraft(sessionStorage.getItem(draftKey(session?.id, path)) ?? "");
    } catch (cause) {
      report(cause);
    }
    if (updateUrl) history.pushState(null, "", session ? `#/sessions/${session.id}` : "#/");
    if (session) {
      setProject(session.projectPath);
      setAdapter(session.adapter || adapter);
      setModel(session.model);
      setEffort(session.effort || "medium");
    }
    setSidebar(false);
    setError("");
  }
  async function openSession(id: string) {
    await persistQueue.current;
    choose(await api<Session>(`/sessions/${id}`));
  }
  function checkpoint(session: Session, state: WorkbenchState) {
    if (clearedSessions.current.has(session.id)) return;
    const snapshot = structuredClone({ ...session, messages: state.messages });
    persistQueue.current = persistQueue.current
      .then(async () => {
        if (clearedSessions.current.has(session.id)) return;
        const saved = await api<Session>(`/sessions/${snapshot.id}`, "PATCH", {
          ...snapshot,
          revision: session.revision
        });
        session.revision = saved.revision;
        if (selectedRef.current?.id === session.id) {
          selectedRef.current = { ...saved };
          setSelected(saved);
        }
        await refresh();
      })
      .catch(report);
  }
  async function browse(path = project) {
    const value = await api<Directory>(`/directories?path=${encodeURIComponent(path)}`);
    setDirectory(value);
    setDirectoryPath(value.path);
  }
  function addProject(path: string) {
    const next = [...new Set([...projects, path])];
    try {
      sessionStorage.setItem(projectKey, JSON.stringify(next));
    } catch (cause) {
      report(cause);
      return;
    }
    setProjects(next);
    setProject(path);
    choose(undefined, path);
    setDirectory(undefined);
  }
  async function addImages(files: File[]) {
    try {
      const result: Attachment[] = [];
      if (files.length + attachments.length > 8) throw new Error("最多添加 8 张图片");
      for (const item of files) {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(item.type) ||
          item.size > 5 * 1024 * 1024
        )
          throw new Error("请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片");
        const bytes = new Uint8Array(await item.arrayBuffer());
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        const data = await new Promise<string>((accept, reject) => {
          const reader = new FileReader();
          reader.onload = () => accept(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(item);
        });
        const id = crypto.randomUUID();
        images.set(id, data);
        result.push({
          id,
          name: item.name,
          url: data,
          part: {
            id,
            type: "image",
            mimeType: item.type as "image/png",
            data: data.split(",")[1],
            byteSize: item.size,
            sha256
          }
        });
      }
      setAttachments((current) => [...current, ...result]);
    } catch (cause) {
      report(cause);
    }
  }
  async function send() {
    if (busy || run.current || (!draft.trim() && !attachments.length) || !adapter) return;
    setBusy(true);
    setError("");
    let session: Session | undefined,
      state: WorkbenchState = work;
    try {
      await persistQueue.current;
      const wasNew = !selectedRef.current;
      session =
        selectedRef.current ?? (await api<Session>("/sessions", "POST", { projectPath: project }));
      session = {
        ...session,
        title: session.messages.length ? session.title : draft.trim().slice(0, 80) || "图片",
        adapter,
        model,
        effort
      };
      selectedRef.current = session;
      setSelected(session);
      const id = crypto.randomUUID(),
        clientMessageId = crypto.randomUUID(),
        controller = new AbortController();
      const inputs: ModelInputPart[] = [
        ...(draft.trim() ? [{ type: "text" as const, text: draft }] : []),
        ...attachments.map((image) => image.part)
      ];
      const parts = attachments.map((image) => ({
        id: image.id,
        type: "image" as const,
        artifact: {
          artifact_id: image.id,
          mediaType: image.part.type === "image" ? image.part.mimeType : "",
          byteSize: image.part.type === "image" ? image.part.byteSize : 0,
          sha256: image.part.type === "image" ? image.part.sha256 : ""
        },
        name: image.name,
        dataUrl: image.url
      }));
      state = workbenchReducer(state, {
        type: "sending",
        clientMessageId,
        prompt: draft,
        parts,
        agentName: providerName(adapter)
      });
      state = workbenchReducer(state, {
        type: "acknowledged",
        clientMessageId,
        ack: {
          accepted: true,
          executionId: id,
          status: "queued",
          clientMessageId,
          conversationId: session.id
        }
      });
      setWork(state);
      editDraft("");
      if (wasNew) sessionStorage.removeItem(draftKey(undefined, session.projectPath));
      setAttachments([]);
      run.current = { id, sessionId: session.id, controller, state };
      history.replaceState(null, "", `#/sessions/${session.id}`);
      setRunning(id);
      // Persist the optimistic turn before opening the stream; never reconstruct provider binding.
      checkpoint(session, state);
      await persistQueue.current;
      const response = await invoke(
        {
          inputs,
          contexts: {
            schema: "octo.context-envelope/v3",
            items: [{ namespace: "octo.execution", name: "adapter", payload: { type: adapter } }]
          },
          sessionId: session.id,
          runId: id,
          invocationId: id,
          protocol_mode: "canonical",
          workdir: session.projectPath,
          approvalMode: approval,
          agentConfig: { ...(model ? { model } : {}), effort },
          ...(session.providerSession ? { providerSession: session.providerSession } : {}),
          continuityMode: session.providerSession ? "continue" : "fresh"
        },
        controller.signal
      );
      if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
      if (!response.body) throw new Error("SSE_STREAM_UNAVAILABLE");
      const presentation = new RawRunPresentation(id);
      presentation.run.startedAt = state.messages.at(-1)?.createdAt;
      let sourceSeq = 0,
        seq = 0,
        lastCheckpoint = Date.now(),
        terminal = false;
      const decoder = new TextDecoder();
      const parser = createParser({
        onEvent(frame) {
          if (frame.event === "error") throw new Error("HOST_INVOKE_FAILED");
          const event = JSON.parse(frame.data) as CanonicalEvent;
          sourceSeq++;
          if (event.type === "session.update" && event.payload.providerSession) {
            session!.providerSession = event.payload.providerSession as Record<string, unknown>;
            checkpoint(session!, state);
          }
          const projected = presentation.receive({
            jsonrpc: "2.0",
            method: "agent_run.event",
            params: {
              run_id: id,
              stream_id: id,
              seq: sourceSeq,
              event: { run_id: id, seq: sourceSeq, ...event, occurred_at: new Date().toISOString() }
            }
          });
          if (projected) {
            const snapshot = presentation.snapshot();
            state = workbenchReducer(state, {
              type: "event",
              event: {
                executionId: id,
                seq: ++seq,
                type: "presentation.snapshot",
                payload: snapshot.payload,
                tsMs: Date.now()
              }
            });
            bindInteractions(
              id,
              state.messages.flatMap((message) => message.interactions ?? [])
            );
            if (run.current) run.current.state = state;
            if (selectedRef.current?.id === session!.id) setWork(state);
          }
          if (["run.completed", "run.failed", "run.cancelled"].includes(event.type))
            terminal = true;
          if (Date.now() - lastCheckpoint > 1500) {
            lastCheckpoint = Date.now();
            checkpoint(session!, state);
          }
        },
        onError(error) {
          throw error;
        }
      });
      const reader = response.body.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          parser.feed(decoder.decode(item.value, { stream: true }));
        }
        parser.feed(decoder.decode());
      } finally {
        reader.releaseLock();
      }
      if (!terminal) throw new Error("执行连接已断开，未收到终态。");
    } catch (cause) {
      if (!session || selectedRef.current?.id === session.id) report(cause);
      state = {
        ...state,
        messages: state.messages.map((message) =>
          message.role === "assistant" && ["queued", "streaming"].includes(message.status ?? "")
            ? {
                ...message,
                status: "disconnected",
                transportError: cause instanceof Error ? cause.message : String(cause)
              }
            : message
        )
      };
      if (session && selectedRef.current?.id === session.id) setWork(state);
    } finally {
      run.current = undefined;
      setRunning("");
      setBusy(false);
      setStopping(false);
      bindInteractions("", []);
      if (session) checkpoint(session, state);
      editor.current?.focus();
    }
  }
  async function stop() {
    if (!run.current) return;
    setStopping(true);
    try {
      await api(`/invocations/${run.current.id}/cancel`, "POST", {});
    } catch (cause) {
      report(cause);
      setStopping(false);
    }
  }
  async function remove(id?: string) {
    setBusy(true);
    const removedIds = id ? [id] : sessions.map((session) => session.id);
    for (const key of removedIds) clearedSessions.current.add(key);
    try {
      if (run.current && (!id || run.current.sessionId === id)) run.current.controller.abort();
      await persistQueue.current;
      await api(id ? `/sessions/${id}` : "/sessions", "DELETE");
      if (!id || selectedRef.current?.id === id) choose(undefined);
      await refresh();
      setClear(false);
    } catch (cause) {
      for (const key of removedIds) clearedSessions.current.delete(key);
      report(cause);
    } finally {
      setBusy(false);
    }
  }
  const currentRunning = run.current?.sessionId === selected?.id ? running : "";
  const live = work.messages.slice(historyCount);
  const historical = work.messages
    .slice(0, historyCount)
    .map((message): ConversationMessage => ({
      ...message,
      conversationId: selected?.id ?? "",
      text: message.content,
      agentName: message.author ?? undefined,
      status: message.status === "stopped" ? "cancelled" : message.status ?? "completed"
    }));
  const visibleSessions = sessions.filter(
    (session) =>
      session.projectPath === project && session.title.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="webui-shell">
      <aside className={`webui-sidebar ${sidebar ? "is-open" : ""}`}>
        <header>
          <strong>工作台</strong>
          <button
            title="搜索对话"
            aria-label="搜索对话"
            onClick={() => document.getElementById("session-search")?.focus()}
          >
            <Search size={19} />
          </button>
        </header>
        <button className="webui-new" onClick={() => choose(undefined)}>
          <SquarePen size={18} />
          新对话
        </button>
        <div className="webui-section">
          <span>项目</span>
          <button
            title="添加项目"
            aria-label="添加项目"
            disabled={busy}
            onClick={() => void browse().catch(report)}
          >
            <FolderPlus size={17} />
          </button>
        </div>
        <nav aria-label="项目">
          {projects.map((path) => (
            <button
              key={path}
              className={`webui-project ${project === path ? "is-selected" : ""}`}
              disabled={busy}
              title={path}
              onClick={() => {
                setProject(path);
                choose(undefined, path);
              }}
            >
              <Folder size={18} />
              <span>{path.split("/").pop() || path}</span>
            </button>
          ))}
        </nav>
        <div className="webui-section">
          <span>会话</span>
          <div>
            <button
              title="刷新会话"
              aria-label="刷新会话"
              onClick={() => void refresh().catch(report)}
            >
              <RefreshCw size={16} />
            </button>
            <button
              title="清理全部会话"
              aria-label="清理全部会话"
              disabled={!sessions.length}
              onClick={() => setClear(true)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        <input
          id="session-search"
          className="webui-search"
          placeholder="搜索对话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="webui-sessions">
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              className={`webui-session ${selected?.id === session.id ? "is-selected" : ""}`}
            >
              <button onClick={() => void openSession(session.id).catch(report)}>
                <MessageSquare size={15} />
                <span>{session.title}</span>
              </button>
              <button
                title="删除会话"
                aria-label={`删除 ${session.title}`}
                disabled={busy}
                onClick={() => void remove(session.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {!visibleSessions.length && <p className="webui-muted">暂无对话</p>}
        </div>
        <footer>
          <span className="webui-brand">Octo Runtime</span>
          <button
            title="刷新引擎"
            aria-label="刷新引擎"
            onClick={() => void refreshAdapters().catch(report)}
          >
            <RefreshCw size={16} />
          </button>
        </footer>
      </aside>
      <main className="webui-main">
        <header className="webui-header">
          <button
            className="webui-mobile-menu"
            title="项目和会话"
            aria-label="项目和会话"
            onClick={() => setSidebar(!sidebar)}
          >
            <Menu size={20} />
          </button>
          <Folder size={17} />
          <span>{project.split("/").pop()}</span>
          {selected && (
            <>
              <ChevronRight size={14} />
              <span>{selected.title}</span>
            </>
          )}
        </header>
        {work.messages.length ? (
          <TranscriptScroller
            key={selected?.id ?? "new"}
            history={historical}
            historyError=""
            live={live}
            executionStatusById={{}}
            owner={owner}
          />
        ) : (
          <div className="webui-empty">
            <Home size={38} strokeWidth={1.4} />
            <h1>今天有什么工作要处理？</h1>
          </div>
        )}
        <div className="webui-compose-area">
          <ApprovalCards
            interactions={work.messages.flatMap((message) => message.interactions ?? [])}
            owner={owner}
            connected={!!currentRunning}
            onResponsePending={(interactionId, pending) =>
              setWork((state) =>
                workbenchReducer(state, { type: "approval_response", interactionId, pending })
              )
            }
          />
          {error && (
            <div className="webui-error" role="alert">
              <span>{error}</span>
              <button title="关闭错误" aria-label="关闭错误" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="composer work-composer">
            <ConversationComposer
              header={
                <div className="webui-project-picker">
                  <label>
                    <Folder size={16} />
                    <select
                      aria-label="选择项目"
                      value={project}
                      disabled={busy || !!selected}
                      onChange={(event) =>
                        event.target.value === "__add__"
                          ? void browse().catch(report)
                          : choose(undefined, event.target.value)
                      }
                    >
                      {projects.map((path) => (
                        <option key={path} value={path}>
                          {path.split("/").pop()}
                        </option>
                      ))}
                      <option value="__add__">添加项目…</option>
                    </select>
                  </label>
                  <button
                    title="选择目录"
                    aria-label="选择目录"
                    disabled={busy || !!selected}
                    onClick={() => void browse().catch(report)}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              }
              editor={
                <>
                  <input
                    type="file"
                    ref={file}
                    className="composer-image-file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(event) => {
                      void addImages([...(event.target.files ?? [])]);
                      event.target.value = "";
                    }}
                  />
                  {attachments.length > 0 && (
                    <div className="composer-images">
                      {attachments.map((image) => (
                        <div className="composer-image" key={image.id}>
                          <img src={image.url} alt={image.name} />
                          <button
                            className="composer-image__remove"
                            aria-label={`移除 ${image.name}`}
                            title="移除图片"
                            onClick={() =>
                              setAttachments((current) =>
                                current.filter((value) => value.id !== image.id)
                              )
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={editor}
                    className="composer-input"
                    placeholder="发消息"
                    aria-label="发消息"
                    rows={3}
                    disabled={busy}
                    value={draft}
                    onChange={(event) => editDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        event.keyCode !== 229
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    onPaste={(event) => {
                      const files = [...event.clipboardData.files];
                      if (files.length) {
                        event.preventDefault();
                        void addImages(files);
                      }
                    }}
                  />
                </>
              }
              toolbarLeft={
                <>
                  <button
                    className="composer-control"
                    title="添加图片"
                    aria-label="添加图片"
                    disabled={busy}
                    onClick={() => file.current?.click()}
                  >
                    <Paperclip size={19} />
                  </button>
                  <ApprovalPolicyPicker value={approval} disabled={busy} onChange={setApproval} />
                </>
              }
              toolbarRight={
                <ModelPicker
                  adapter={adapter}
                  adapters={adapters}
                  model={model}
                  models={models}
                  effort={effort}
                  disabled={busy}
                  adapterLocked={!!selected?.providerSession}
                  modelEnabled={true}
                  effortEnabled={true}
                  onAdapter={setAdapter}
                  onModel={setModel}
                  onEffort={setEffort}
                />
              }
              sendLabel="发送消息"
              sendDisabled={!project || !adapter || (!draft.trim() && !attachments.length)}
              sending={busy && !running}
              onSend={() => void send()}
              running={!!currentRunning}
              stopping={stopping}
              stopLabel="停止执行"
              onStop={() => void stop()}
            />
          </div>
        </div>
      </main>
      {directory && (
        <Modal title="选择项目目录" onClose={() => setDirectory(undefined)}>
          <form
            className="webui-directory-path"
            onSubmit={(event) => {
              event.preventDefault();
              void browse(directoryPath).catch(report);
            }}
          >
            <input
              aria-label="目录路径"
              value={directoryPath}
              onChange={(event) => setDirectoryPath(event.target.value)}
            />
            <button title="打开目录" aria-label="打开目录">
              <ArrowUp size={17} />
            </button>
          </form>
          <div className="webui-directories">
            <button onClick={() => void browse(directory.parent).catch(report)}>
              <Folder size={17} />
              ..
            </button>
            {directory.directories.map((item) => (
              <button key={item.path} onClick={() => void browse(item.path).catch(report)}>
                <Folder size={17} />
                {item.name}
              </button>
            ))}
          </div>
          <button className="webui-primary" onClick={() => addProject(directory.path)}>
            选择此目录
          </button>
        </Modal>
      )}
      {settings && (
        <Modal title="模型与引擎" onClose={() => setSettings(false)}>
          <div className="webui-settings">
            {adapters.map((item) => (
              <div key={item.providerType}>
                <span>{providerName(item.providerType)}</span>
                <span>{item.available ? "可用" : item.unavailableReason || "不可用"}</span>
              </div>
            ))}
            <button onClick={() => void refreshAdapters().catch(report)}>
              <RefreshCw size={15} />
              刷新引擎
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!newModel.trim()) return;
                const next = [...new Set([...models, newModel.trim()])];
                try {
                  sessionStorage.setItem("octo-runtime-webui.models", JSON.stringify(next));
                  setModels(next);
                  setNewModel("");
                } catch (cause) {
                  report(cause);
                }
              }}
            >
              <label>
                模型 ID
                <input
                  value={newModel}
                  onChange={(event) => setNewModel(event.target.value)}
                  placeholder="模型 ID"
                />
              </label>
              <button type="submit">
                <Plus size={16} />
                添加
              </button>
            </form>
            {models.map((value) => (
              <div key={value}>
                <span>{value}</span>
                <button
                  title="移除模型"
                  aria-label={`移除模型 ${value}`}
                  onClick={() => {
                    const next = models.filter((item) => item !== value);
                    sessionStorage.setItem("octo-runtime-webui.models", JSON.stringify(next));
                    setModels(next);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {clear && (
        <Modal
          title="清理全部会话？"
          description="将移除 WebUI 保存的会话与 Provider 会话绑定。"
          onClose={() => setClear(false)}
        >
          <div className="webui-confirm">
            <button onClick={() => setClear(false)}>取消</button>
            <button className="webui-primary" onClick={() => void remove()}>
              清理
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
