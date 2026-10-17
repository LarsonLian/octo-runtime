export const toolIntent = {
  service_subject_id: "loop",
  allowed_tools: [
    "task_get_materials",
    "task_prepare_output",
    "task_commit_output",
    "task_fail_output"
  ],
  resource_refs: ["task:task-1"]
};
export const issuedGrant = () => ({
  ...toolIntent,
  token: "octo_run_fixture",
  octo_space_id: "space-1",
  namespace: "task",
  expires_at: new Date(Date.now() + 60_000).toISOString()
});
