export const name = "log-output";
export default async function load(context) {
  context.log("info", "fixture.started", {
    status: "running",
    text: "private body",
    token: "bf_secret"
  });
  context.onDispose(() => {
    context.log("info", "fixture.disposed", { status: "stopped" });
  });
}
