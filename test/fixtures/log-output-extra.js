export const name = "log-output";
export default function load(context) {
  return async () => {
    context.log("info", "fixture.started", {
      status: "running",
      text: "private body",
      token: "bf_secret"
    });
    context.onDispose(() => {
      context.log("info", "fixture.disposed", { status: "stopped" });
    });
  };
}
