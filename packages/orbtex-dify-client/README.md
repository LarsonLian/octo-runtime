# @orbtex-ai/orbtex-dify-client

Dify adapters 共用的远程 HTTP/SSE client。它负责 API key header、基础 URL、`/parameters` probe、SSE framing、HTTP 错误和停止请求，不负责把 Dify native event 映射成 Orbtex canonical event。

## 安全约束

- 默认只允许 HTTPS；测试时允许 `localhost` / `127.0.0.1`。
- API key 默认从 adapter 指定的环境变量读取，不写入 manifest、prompt、event 或日志。
- 错误响应最多保留 4 KiB 文本，不记录请求 header。
- SSE parser 支持 UTF-8 网络分片、LF/CRLF、多行 `data:`、注释心跳和最大 frame 限制。

业务用法见 [`dify-chatflow`](../orbtex-adapter-dify-chatflow/README.md) 与 [`dify-workflow`](../orbtex-adapter-dify-workflow/README.md)。
