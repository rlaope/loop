export const demoWorkflows = [
  {
    title: "Product quality loop",
    description: "Improve a real dashboard through UX review, bug fixes, visual QA, docs, and follow-up issue capture.",
    commands: [
      "mkdir dashboard-quality-loop",
      "cd dashboard-quality-loop",
      "loop doctor",
      "loop \"Improve the current dashboard until a real user can understand it. Repeat through UX review, bug fixes, visual QA, documentation updates, and follow-up issue creation.\"",
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
  lines.push("loop \"Improve this product workflow until a real user can understand what is happening, what to read, and what to do next.\"");
  lines.push("```");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
