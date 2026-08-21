"use strict";

const assert = require("assert");
const {
  AUTONOMOUS_TASK_PROTOCOL,
  DEFAULT_PASS_CRITERIA,
  MANDATORY_CONFIRMATION_CATEGORIES,
  createAutonomousTask,
  requiresHumanConfirmation,
  transitionTask,
  validateAutonomousTask
} = require("../core/autonomous-task-protocol.cjs");

const task = createAutonomousTask(
  "@sfadmin upgreidni se tazi nosht i ne prikluchvai dokato testovete ne sa PASS",
  {
    task_id: "protocol-v1-control",
    max_rounds: 80,
    metadata: { source: "soul" }
  }
);

assert.strictEqual(task.protocol, AUTONOMOUS_TASK_PROTOCOL);
assert.strictEqual(task.task_id, "protocol-v1-control");
assert.strictEqual(task.state, "queued");
assert.strictEqual(
  task.goal,
  "upgreidni se tazi nosht i ne prikluchvai dokato testovete ne sa PASS"
);
assert.strictEqual(task.max_rounds, 80);
assert.deepStrictEqual(task.pass_criteria, [...DEFAULT_PASS_CRITERIA]);
assert.strictEqual(task.metadata.source, "soul");
assert.strictEqual(validateAutonomousTask(task), true);

for (const category of MANDATORY_CONFIRMATION_CATEGORIES) {
  assert.ok(task.mandatory_confirmation_categories.includes(category));
  assert.strictEqual(requiresHumanConfirmation(category), true);
}

assert.strictEqual(requiresHumanConfirmation("run_tests"), false);

const observing = transitionTask(task, "observe", {
  repository_clean: true,
  baseline_commit: "a7cf857"
});
assert.strictEqual(observing.state, "observe");
assert.strictEqual(observing.last_evidence.repository_clean, true);
assert.ok(observing.last_transition_at);

const custom = createAutonomousTask({
  goal: "@sfadmin napravi kontrolirana testova promqna",
  pass_criteria: ["control_test_pass"],
  allowed_actions: ["inspect_repository", "run_tests"],
  mandatory_confirmation_categories: []
});

assert.deepStrictEqual(custom.pass_criteria, ["control_test_pass"]);
assert.deepStrictEqual(custom.allowed_actions, ["inspect_repository", "run_tests"]);
for (const category of MANDATORY_CONFIRMATION_CATEGORIES) {
  assert.ok(
    custom.mandatory_confirmation_categories.includes(category),
    `mandatory risk gate missing: ${category}`
  );
}
assert.strictEqual(validateAutonomousTask(custom), true);

assert.throws(
  () => createAutonomousTask("@sfadmin"),
  /non-empty goal/u
);

assert.throws(
  () => validateAutonomousTask({ protocol: "wrong", state: "queued", goal: "x" }),
  /Unsupported autonomous task protocol/u
);

console.log("DAVID AUTONOMOUS TASK PROTOCOL V1 CONTRACT PASS");
