import type { HostFrame, HostRunReceipt, ProtocolMode } from "../src/run-protocol.js";

function consume(frame: HostFrame): unknown {
  if (frame.kind === "native") {
    const mode: "native" = frame.protocol_mode;
    // @ts-expect-error A native frame has no canonical event.
    void frame.event;
    return [mode, frame.payload, frame.messageKind];
  }
  if (frame.kind === "canonical") {
    const mode: "canonical" = frame.protocol_mode;
    // @ts-expect-error A canonical frame has no native payload.
    void frame.payload;
    return [mode, frame.event];
  }
  const mode: ProtocolMode = frame.protocol_mode;
  return [mode, frame.control];
}

function receipt(frame: HostFrame): HostRunReceipt {
  return {
    run_id: frame.run_id,
    invocation_id: frame.invocation_id,
    stream_id: frame.stream_id,
    agent_session_id: frame.agent_session_id,
    session_generation: frame.session_generation,
    protocol_mode: frame.protocol_mode,
    protocol: frame.protocol
  };
}

void consume;
void receipt;
