"use strict";

const { SupabaseBridge } = require("./supabase-bridge.cjs");
const { createDemoPlan } = require("./demo-teacher.cjs");
const { ElectronChatTeacher } = require("./electron-chat-teacher.cjs");
const { validateSkill } = require("./skill-schema.cjs");

class TeacherClient {
  constructor({ config, store, sendStatus }) {
    this.config = config;
    this.store = store;
    this.sendStatus = sendStatus;
    this.bridge = new SupabaseBridge({ config, store, sendStatus });
    this.electronTeacher = new ElectronChatTeacher({ config, sendStatus });
    this.connected = false;
  }

  async initialize(onRemoteJob) {
    if (this.bridge.isConfigured()) {
      this.connected = await this.bridge.initialize(onRemoteJob);

      if (this.connected) {
        this.sendStatus("Supabase паметта на DAVID е свързана", "ready");
      }
    }

    if (this.config.teacherMode === "electron-chat") {
      this.sendStatus(
        "DAVID Teacher използва готовия ChatGPT разговор в Electron",
        "ready"
      );
      return;
    }

    if (!this.connected) {
      this.sendStatus(
        "DAVID работи без свързан Teacher. Настрой DAVID_TEACHER_MODE=electron-chat.",
        "warning"
      );
    }
  }

  isConnected() {
    return this.config.teacherMode === "electron-chat" || this.connected;
  }

  async createOptionalTrainingRequest(command, context, requestId) {
    if (requestId || !this.connected) return requestId;

    try {
      return await this.bridge.createTrainingRequest(command, context);
    } catch (error) {
      this.sendStatus(
        `Не записах training request в Supabase: ${error.message}`,
        "warning"
      );
      return null;
    }
  }

  async requestSkill({
    command,
    context,
    previousSkill = null,
    lastRun = null,
    requestId = null
  }) {
    const id = await this.createOptionalTrainingRequest(
      command,
      context,
      requestId
    );

    if (this.config.teacherMode === "electron-chat") {
      try {
        const skill = await this.electronTeacher.requestSkill({
          command,
          context,
          previousSkill,
          lastRun
        });

        validateSkill(skill);

        return {
          requestId: id,
          jobId: null,
          skill
        };
      } catch (error) {
        if (!this.config.allowDemoFallback) {
          throw error;
        }

        this.sendStatus(
          `Electron Teacher се провали; използвам demo fallback: ${error.message}`,
          "warning"
        );
      }
    }

    if (!this.connected) {
      const plan = await createDemoPlan(command, previousSkill);
      validateSkill(plan.skill);
      return plan;
    }

    this.sendStatus("Supabase GPT Teacher създава нов skill...", "training");

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
