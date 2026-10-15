export const name = "log-output";
export default async function load(context) {
  process.stdout.write("hourly-test-stdout\n");
  process.stderr.write("hourly-test-stderr\n");
  context.onDispose(() => {
    process.stderr.write("hourly-test-disposed\n");
  });
}
