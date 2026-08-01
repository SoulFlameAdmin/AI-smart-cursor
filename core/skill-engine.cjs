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
      this.sendStatus(`РР·РїРѕР»Р·РІР°Рј skill: ${existing.skill.title}`, "working");
      return this.executeAndLearn({
        command,
        skill: existing.skill,
        variables: existing.variables,
        requestId: null,
        jobId: null
      });
    }

    this.sendStatus("РќСЏРјР° skill. РР·РїСЂР°С‰Р°Рј Р·Р°РґР°С‡Р°С‚Р° Р·Р° РѕР±СѓС‡РµРЅРёРµ.", "training");

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
        `РўРµСЃС‚ ${attempt}/${this.maxAttempts}: ${skill.title}`,
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

      if (lastResult.ok) {
        return {
          ok: true,
          message: `РќР°СѓС‡РёС… Рё РёР·РїСЉР»РЅРёС…: ${skill.title}`,
          skill: skill.skill_key,
          attempt
        };
      }

      previousSkill = skill;
      lastRun = lastResult.run;
      this.sendStatus(
        `РўРµСЃС‚СЉС‚ СЃРµ РїСЂРѕРІР°Р»Рё. GPT РЅР°РґРіСЂР°Р¶РґР° РІРµСЂСЃРёСЏ ${Number(skill.version || 0) + 1}...`,
        "training"
      );
    }

    const message =
      lastResult?.run?.error ||
      "Skill-СЉС‚ РЅРµ РїСЂРµРјРёРЅР° СѓСЃРїРµС€РЅРѕ РјР°РєСЃРёРјР°Р»РЅРёСЏ Р±СЂРѕР№ С‚РµСЃС‚РѕРІРµ.";

    this.sendStatus(`РќРµСѓСЃРїРµС€РЅРѕ РѕР±СѓС‡РµРЅРёРµ: ${message}`, "error");
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
        `РР·РїСЉР»РЅРµРЅРёРµС‚Рѕ Рµ Р»РѕРєР°Р»РЅРѕ Р·Р°РїРёСЃР°РЅРѕ, РЅРѕ Supabase report СЃРµ РїСЂРѕРІР°Р»Рё: ${error.message}`,
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
            `Skill-СЉС‚ Рµ Р»РѕРєР°Р»РЅРѕ Р·Р°РїР°Р·РµРЅ, РЅРѕ remote verify СЃРµ РїСЂРѕРІР°Р»Рё: ${error.message}`,
            "warning"
          );
        }
      }

      this.sendStatus(`Р“РѕС‚РѕРІРѕ: ${skill.title}`, "success");
      return { ok: true, run };
    }

    this.sendStatus(`РџСЂРѕРІР°Р»РµРЅР° СЃС‚СЉРїРєР°: ${run.error}`, "error");
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

