"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AUTONOMOUS_ORCHESTRATOR_VERSION,
  AutonomousOrchestrator,
  buildAutonomousTeacherGoal,
  isAutonomousCommand,
  normalizeProgressState
} = require("../core/autonomous-orchestrator.cjs");
const { createAutonomousTask } = require("../core/autonomous-task-protocol.cjs");

assert.strictEqual(
  AUTONOMOUS_ORCHESTRATOR_VERSION,
  "david_autonomous_orchestrator_v1"
);
assert.strictEqual(isAutonomousCommand("@sfadmin napravi test"), true);
assert.strictEqual(isAutonomousCommand("normalen soul vupros"), false);
assert.strictEqual(normalizeProgressState({ stage: "powershell_output" }), "act");
assert.strictEqual(normalizeProgressState({ stage: "regression_tests" }), "test");
assert.strictEqual(normalizeProgressState({ stage: "gpt_thinking" }), "think");

const contractTask = createAutonomousTask("@sfadmin napravi kontrolirana promqna", {
  task_id: "orchestrator-contract-control"
});
const teacherGoal = buildAutonomousTeacherGoal(contractTask, { attempt: 2 });
assert.match(teacherGoal, /DAVID AUTONOMOUS ORCHESTRATOR V1/u);
assert.match(teacherGoal, /A failed test is not task completion/u);
assert.match(teacherGoal, /stdout, stderr, exit_code/u);
assert.match(teacherGoal, /Return completed only after/u);
assert.match(teacherGoal, /ORCHESTRATOR_ATTEMPT=2/u);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "david-autonomous-v1-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "david-autonomous-test", private: true }, null, 2),
    "utf8"
  );

  try {
    let workerCalls = 0;
    let verifierCalls = 0;
    const statuses = [];

    const orchestrator = new AutonomousOrchestrator({
      projectRoot: root,
      maxAttempts: 3,
      sendStatus: (message, kind, meta) => {
        statuses.push({ message, kind, meta });
      },
      runWorker: async ({ goal, onProgress }) => {
        workerCalls += 1;
        assert.match(goal, /GOAL=napravi kontrolirana testova promqna/u);
        await onProgress?.({
          stage: "powershell_output",
          message: `attempt ${workerCalls}`,
          meta: { exit_code: workerCalls === 1 ? 1 : 0 }
        });
        return {
          ok: true,
          status: "completed",
          round: workerCalls,
          summary: workerCalls === 1
            ? "Target behavior claimed complete but final verifier will reject it."
            : "Target behavior completed after repair."
        };
      },
      finalVerifier: async (_workerResult, context) => {
        verifierCalls += 1;
        if (context.attempt === 1) {
          return {
            ok: false,
            target_tests_pass: false,
            regression_tests_pass: true,
            reason: "CONTROL_TARGET_TEST_FAILED"
          };
        }
        return {
          ok: true,
          target_tests_pass: true,
          regression_tests_pass: true,
          final_verification_pass: true
        };
      }
    });

    const result = await orchestrator.run(
      "@sfadmin napravi kontrolirana testova promqna",
      {
        task_id: "orchestrator-repair-loop-control",
        max_rounds: 20
      }
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.task.state, "completed");
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(workerCalls, 2);
    assert.strictEqual(verifierCalls, 2);
    assert.strictEqual(result.verification.target_tests_pass, true);
    assert.ok(fs.existsSync(result.state_path));
    assert.ok(fs.existsSync(result.journal_path));

    const journal = fs.readFileSync(result.journal_path, "utf8");
    assert.match(journal, /verification_failed_retrying/u);
    assert.match(journal, /CONTROL_TARGET_TEST_FAILED/u);
    assert.match(journal, /state_completed/u);
    assert.ok(statuses.some((entry) => /AUTONOMOUS \| COMPLETED/u.test(entry.message)));

    let blockedWorkerCalls = 0;
    const blocked = new AutonomousOrchestrator({
      projectRoot: root,
      maxAttempts: 3,
      runWorker: async () => {
        blockedWorkerCalls += 1;
        return {
          ok: false,
          status: "blocked",
          summary: "production_write requires human confirmation"
        };
      }
    });

    const blockedResult = await blocked.run(
      "@sfadmin napravi production write",
      { task_id: "orchestrator-risk-gate-control" }
    );

    assert.strictEqual(blockedResult.ok, false);
    assert.strictEqual(blockedResult.status, "blocked");
    assert.strictEqual(blockedResult.task.state, "blocked");
    assert.strictEqual(blockedWorkerCalls, 1);

    await assert.rejects(
      () => orchestrator.run("normalen soul vupros"),
      /must start with @sfadmin/u
    );

    console.log("DAVID AUTONOMOUS ORCHESTRATOR V1 CONTRACT PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
