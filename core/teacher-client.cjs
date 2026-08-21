"use strict";

const { SupabaseBridge } = require("./supabase-bridge.cjs");
const { createDemoPlan } = require("./demo-teacher.cjs");
const { validateSkill } = require("./skill-schema.cjs");

const MAX_APPROVED_TEACHER_LESSONS = 20;
const MAX_APPROVED_TEACHER_LESSON_CHARS = 8000;

function buildTeacherContext(context, approvedLessons) {
 const safeLessons = [];
 let lessonChars = 0;

 for (const lesson of approvedLessons || []) {
 if (!lesson || lesson.status !== 'approved') continue;
 const triggerText = String(lesson.trigger_text || '');
 const lessonText = String(lesson.lesson_text || '');
 if (!lessonText.trim()) continue;
 const size = triggerText.length + lessonText.length;
 if (safeLessons.length >= MAX_APPROVED_TEACHER_LESSONS || lessonChars + size > MAX_APPROVED_TEACHER_LESSON_CHARS) break;
 safeLessons.push({ trigger_text: triggerText, lesson_text: lessonText });
 lessonChars += size;
 }

 if (safeLessons.length === 0) return context;

 return {
 ...(context && typeof context === 'object' && !Array.isArray(context)
 ? context
 : { base_context: context || null }),
 approved_twin_teacher_lessons: safeLessons
 };
}

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
        "DAVID СЂР°Р±РѕС‚Рё РІ local demo СЂРµР¶РёРј В· legacy Supabase Teacher РЅРµ Рµ РЅР°СЃС‚СЂРѕРµРЅ",
        "warning"
      );
      return;
    }

    try {
      this.connected = await this.bridge.initialize(onRemoteJob);
      this.sendStatus("DAVID legacy Teacher Рµ СЃРІСЉСЂР·Р°РЅ СЃСЉСЃ Supabase", "ready");
    } catch (error) {
      this.connected = false;
      this.sendStatus(
        `Legacy Supabase Teacher Рµ РЅРµРґРѕСЃС‚СЉРїРµРЅ; DAVID РїСЂРѕРґСЉР»Р¶Р°РІР° Р»РѕРєР°Р»РЅРѕ: ${error.message}`,
        "warning"
      );
    }
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

 const approvedLessons = await this.bridge.fetchApprovedTeacherLessons();
 const teacherContext = buildTeacherContext(context, approvedLessons);

 let id = requestId;

 if (!id) {
 id = await this.bridge.createTrainingRequest(command, teacherContext);
 }

    this.sendStatus("GPT Teacher СЃСЉР·РґР°РІР° РЅРѕРІ skill...", "training");

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

module.exports = { TeacherClient, buildTeacherContext };
