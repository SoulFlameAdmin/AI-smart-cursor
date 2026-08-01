"use strict";

const crypto = require("crypto");
const { matchSkill, renderTemplate } = require("./skill-matcher.cjs");
const { validateSkill } = require("./skill-schema.cjs");

class SkillEngine {
  constructor({
    store,
    teacher,
    executor,
    maxAttempts,
    sendStatus,
    contextProvider,
    builtInSkills = []
  }) {
    this.store = store;
    this.teacher = teacher;
    this.executor = executor;
    this.maxAttempts = maxAttempts;
    this.sendStatus = sendStatus;
    this.contextProvider = contextProvider;
    this.builtInSkills = Array.isArray(builtInSkills)
      ? builtInSkills
      : [];
    this.processingJobs = new Set();
  }

  async handleCommand(command) {
    const existing = matchSkill(command, [
      ...this.builtInSkills,
      ...this.store.getSkills()
    ]);

    if (existing) {
      this.sendStatus(
        `Използвам skill: ${existing.skill.title}`,
        "working"
      );
      return this.executeAndLearn({
        command,
        skill: existing.skill,
        variables: existing.variables,
        requestId: null,
        jobId: null
      });
    }

    this.sendStatus(
      "Няма готов skill. Изпращам задачата към GPT Teacher.",
      "training"
    );

    let previousSkill = null;
    let lastRun = null;
    let requestId = null;
    let lastResult = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const plan = await this.teacher.requestSkill({
        command,
        context: this.contextProvider(),
        previousSkill,
        lastRun,
        requestId
      });

      requestId = plan.requestId;
      const skill = validateSkill(plan.skill);
      const matched = matchSkill(command, [skill]);
      const variables = matched ? matched.variables : {};

      this.sendStatus(
        `Тест ${attempt}/${this.maxAttempts}: ${skill.title}`,
        "training"
      );

      lastResult = await this.executeAndLearn({
        command,
        skill,
        variables,
        requestId,
        jobId: plan.jobId,
        saveOnSuccess: true
      });

      if (lastResult.cancelled) {
        return {
          ok: false,
          cancelled: true,
          message: "Отказа предложения план. Нищо не беше изпълнено."
        };
      }

      if (lastResult.ok) {
        return {
          ok: true,
          message: `Научих и изпълних: ${skill.title}`,
          skill: skill.skill_key,
          attempt
        };
      }

      previousSkill = skill;
      lastRun = lastResult.run;
      this.sendStatus(
        `Тестът се провали. GPT надгражда версия ${Number(skill.version || 0) + 1}...`,
        "training"
      );
    }

    const message =
      lastResult?.run?.error ||
      "Skill-ът не премина успешно максималния брой тестове.";

    this.sendStatus(`Неуспешно обучение: ${message}`, "error");
    return { ok: false, message };
  }

  async executeAndLearn({
    command,
    skill,
    variables,
    requestId,
    jobId,
    saveOnSuccess = false
  }) {
    const renderedSteps = renderTemplate(skill.steps, variables);

    if (typeof this.executor.confirmPlan === "function") {
      const allowed = await this.executor.confirmPlan({
        command,
        skill: { ...skill, steps: renderedSteps }
      });

      if (!allowed) {
        this.sendStatus("Планът беше отказан. Нищо не е изпълнено.", "warning");
        return { ok: false, cancelled: true, run: null };
      }
    }

    const run = await this.executor.run(renderedSteps);

    const localRun = {
      id: crypto.randomUUID(),
      command,
      skill_key: skill.skill_key,
      skill_version: skill.version,
      request_id: requestId,
      job_id: jobId,
      ...run
    };

    this.store.addRun(localRun);

    try {
      await this.teacher.reportRun({
        requestId,
        skill,
        result: run,
        command,
        jobId
      });
    } catch (error) {
      this.sendStatus(
        `Изпълнението е локално записано, но Supabase report се провали: ${error.message}`,
        "warning"
      );
    }

    if (run.ok) {
      if (saveOnSuccess || !["approved", "local_verified"].includes(skill.status)) {
        const verified = { ...skill, status: "local_verified" };
        this.store.upsertSkill(verified);

        try {
          await this.teacher.markSkillVerified(verified);
        } catch (error) {
          this.sendStatus(
            `Skill-ът е локално запазен, но remote verify се провали: ${error.message}`,
            "warning"
          );
        }
      }

      this.sendStatus(`Готово: ${skill.title}`, "success");
      return { ok: true, run };
    }

    this.sendStatus(`Провалена стъпка: ${run.error}`, "error");
    return { ok: false, run };
  }

  async executeRemoteJob(job, skill) {
    if (this.processingJobs.has(job.id)) return;
    this.processingJobs.add(job.id);

    try {
      validateSkill(skill);
      const command = job.command_text || "";
      const matched = matchSkill(command, [skill]);
      const variables = matched ? matched.variables : {};

      await this.executeAndLearn({
        command,
        skill,
        variables,
        requestId: job.request_id,
        jobId: job.id,
        saveOnSuccess: true
      });
    } finally {
      this.processingJobs.delete(job.id);
    }
  }
}

module.exports = { SkillEngine };
