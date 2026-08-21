"use strict";

const assert = require("assert");
const path = require("path");
const {
  extractTeacherGoal,
  isAutonomousGoal,
  runAutonomousWorkerGoal
} = require("../core/david-teacher-client.cjs");

(async () => {
  const command = "@sfadmin upgreidni se dokato vsichko e PASS";

  assert.strictEqual(isAutonomousGoal(command), true);
  assert.strictEqual(isAutonomousGoal("@worker proveri testovete"), false);
  assert.strictEqual(extractTeacherGoal(command), command);
  assert.strictEqual(
    extractTeacherGoal("ъпгрейд: proveri testovete"),
    "proveri testovete"
  );

  const orchestratorPath = require.resolve("../core/autonomous-orchestrator.cjs");
  const originalExports = require(orchestratorPath);

  let constructorOptions = null;
  let runInput = null;

  class FakeAutonomousOrchestrator {
    constructor(options) {
      constructorOptions = options;
    }

    async run(input, overrides) {
      runInput = { input, overrides };
      return {
        ok: true,
        status: "completed",
        attempts: 2,
        task: {
          task_id: "autonomous-route-control",
          goal: "upgreidni se dokato vsichko e PASS"
        },
        worker_result: {
          round: 4,
          status: "completed"
        },
        verification: {
          ok: true,
          source: "control"
        }
      };
    }
  }

  require.cache[orchestratorPath].exports = {
    ...originalExports,
    AutonomousOrchestrator: FakeAutonomousOrchestrator
  };

  const statuses = [];
  const progress = [];

  try {
    const result = await runAutonomousWorkerGoal({
      goal: command,
      projectRoot: path.join(__dirname, ".."),
      sendStatus: (message, kind, meta) => {
        statuses.push({ message, kind, meta });
      },
      onProgress: (event) => {
        progress.push(event);
      }
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.autonomous, true);
    assert.strictEqual(result.task_id, "autonomous-route-control");
    assert.strictEqual(result.round, 2);
    assert.match(result.summary, /^AUTONOMOUS PASS/u);

    assert.ok(constructorOptions, "AutonomousOrchestrator must be constructed.");
    assert.strictEqual(
      path.resolve(constructorOptions.projectRoot),
      path.resolve(path.join(__dirname, ".."))
    );
    assert.ok(constructorOptions.maxAttempts >= 1);

    assert.ok(runInput, "@sfadmin command must be delegated to orchestrator.run().");
    assert.strictEqual(runInput.input, command);
    assert.strictEqual(runInput.overrides.metadata.source, "soul");
    assert.strictEqual(runInput.overrides.metadata.route, "@sfadmin");
    assert.ok(runInput.overrides.max_rounds >= 1);

    assert.ok(
      statuses.some((entry) => /DAVID AUTONOMOUS/u.test(entry.message)),
      "Soul must receive autonomous status."
    );
    assert.ok(
      progress.some((entry) => entry.stage === "autonomous_started"),
      "Soul progress bridge must receive autonomous_started."
    );
  } finally {
    require.cache[orchestratorPath].exports = originalExports;
  }

  const source = require("fs").readFileSync(
    path.join(__dirname, "..", "core", "david-teacher-client.cjs"),
    "utf8"
  );

  assert.match(source, /DAVID_AUTONOMOUS_SOUL_ROUTE_V1/u);
  assert.match(source, /require\("\.\/autonomous-orchestrator\.cjs"\)/u);
  assert.match(source, /if \(isAutonomousGoal\(goal\)\)/u);

  console.log("DAVID AUTONOMOUS SOUL ROUTING V1 CONTRACT PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
