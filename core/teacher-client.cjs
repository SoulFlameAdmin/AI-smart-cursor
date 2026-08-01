"use strict";

const { SupabaseBridge } = require("./supabase-bridge.cjs");
const { createDemoPlan } = require("./demo-teacher.cjs");
const { validateSkill } = require("./skill-schema.cjs");

class TeacherClient {
  constructor({ config, store, sendStatus }) {
    this.config = config;
    this.store = store;
    this.sendStatus = sendStatus;
    this.bridge = new SupabaseBridge({ config, store, sendStatus });
    this.connected = false;
  }

  async initialize(onRemoteJob) {
    if (!this.bridge.isConfigured()) {
      this.sendStatus(
        "DAVID работи в local demo режим · Supabase не е настроен",
        "warning"
      );
      return;
    }

    this.connected = await this.bridge.initialize(onRemoteJob);
    this.sendStatus("DAVID Teacher е свързан със Supabase", "ready");
  }

  isConnected() {
    return this.connected;
  }

  async requestSkill({
    command,
    context,
    previousSkill = null,
    lastRun = null,
    requestId = null
  }) {
    if (!this.connected) {
      const plan = await createDemoPlan(command, previousSkill);
      validateSkill(plan.skill);
      return plan;
    }

    let id = requestId;

    if (!id) {
      id = await this.bridge.createTrainingRequest(command, context);
    }

    this.sendStatus("GPT Teacher създава нов skill...", "training");

    const response = await this.bridge.invokeTeacher({
      request_id: id,
      previous_skill: previousSkill,
      last_run: lastRun
    });

    const skill = {
      ...response.skill,
      version: response.version,
      status: response.status || "candidate",
      db_version_id: response.skill_version_id
    };

    validateSkill(skill);

    return {
      requestId: id,
      jobId: response.job_id || null,
      skill
    };
  }

  async reportRun(data) {
    if (!this.connected) return null;
    return this.bridge.reportRun(data);
  }

  async fetchVerifiedSkills() {
    if (!this.connected) return [];
    return this.bridge.fetchVerifiedSkills();
  }

  async markSkillVerified(skill) {
    if (!this.connected) return;
    await this.bridge.markSkillVerified(skill);
  }

  dispose() {
    this.bridge.dispose();
  }
}

module.exports = { TeacherClient };
