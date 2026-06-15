export const demoWorkflows = [
  {
    title: "Darkwear luxury exhibition site",
    description: "Start a fresh local project, let Loop create a git boundary, and watch the agent run.",
    commands: [
      "mkdir darkwear-exhibit",
      "cd darkwear-exhibit",
      "loop doctor",
      "loop \"Build a darkwear luxury exhibition site MVP\"",
      "loop status",
      "loop logs --follow",
      "loop wiki"
    ]
  },
  {
    title: "Explicit Codex run",
    description: "Skip the agent picker when you already know which coding agent should receive the objective.",
    commands: [
      "loop run --agent codex \"Build a quiet SaaS metrics dashboard MVP\"",
      "loop runs",
      "loop wiki list"
    ]
  },
  {
    title: "Safe planning and follow-up",
    description: "Record a dry-run plan first, then continue with a scoped write-capable loop when the goal is clear.",
    commands: [
      "loop --dry-run --objective \"Audit failing tests and propose the smallest safe fix plan\"",
      "loop wiki read <note-id>",
      "loop run --agent codex --parent-run <run-id> \"Fix the failing test with the smallest safe change\""
    ]
  }
];

export function renderDemoGuide() {
  const lines = [
    "Loop Demo",
    "",
    "This command prints examples only. It does not write .loop, launch agents, start services, or call the network.",
    ""
  ];

  for (const workflow of demoWorkflows) {
    lines.push(`## ${workflow.title}`);
    lines.push(workflow.description);
    lines.push("");
    lines.push("```sh");
    lines.push(...workflow.commands);
    lines.push("```");
    lines.push("");
  }

  lines.push("Most users start with:");
  lines.push("");
  lines.push("```sh");
  lines.push("loop \"Build the thing you want\"");
  lines.push("```");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
