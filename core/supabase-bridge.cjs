"use strict";

const os = require("os");
const { createClient } = require("@supabase/supabase-js");

class SupabaseBridge {
  constructor({ config, store, sendStatus }) {
    this.config = config;
    this.store = store;
    this.sendStatus = sendStatus;
    this.client = null;
    this.user = null;
    this.channel = null;
    this.deviceId = store.getDeviceId();
  }

  isConfigured() {
    return Boolean(
      this.config.supabaseUrl && this.config.supabasePublishableKey
    );
  }

  async initialize(onRemoteJob) {
    if (!this.isConfigured()) return false;

    const storage = {
      getItem: (key) => this.store.authGet(key),
      setItem: (key, value) => this.store.authSet(key, value),
      removeItem: (key) => this.store.authRemove(key)
    };

    this.client = createClient(
      this.config.supabaseUrl,
      this.config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storage
        }
      }
    );

    const { data: sessionData } = await this.client.auth.getSession();
    let session = sessionData.session;

    if (!session) {
      if (this.config.email && this.config.password) {
        const response = await this.client.auth.signInWithPassword({
          email: this.config.email,
          password: this.config.password
        });
        if (response.error) throw response.error;
        session = response.data.session;
      } else {
        const response = await this.client.auth.signInAnonymously();
        if (response.error) {
          throw new Error(
            `Supabase РІС…РѕРґСЉС‚ СЃРµ РїСЂРѕРІР°Р»Рё. Р’РєР»СЋС‡Рё Anonymous Sign-ins РёР»Рё РґРѕР±Р°РІРё DAVID_USER_EMAIL/PASSWORD. ${response.error.message}`
          );
        }
        session = response.data.session;
      }
    }

    this.user = session.user;

    const device = {
      id: this.deviceId,
      owner_id: this.user.id,
      name: os.hostname(),
      platform: process.platform,
      app_version: "0.1.0",
      last_seen_at: new Date().toISOString()
    };

    const upsert = await this.client.from("devices").upsert(device);
    if (upsert.error) throw upsert.error;

    this.channel = this.client
      .channel(`david-jobs-${this.deviceId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "training_jobs",
          filter: `device_id=eq.${this.deviceId}`
        },
        async (payload) => {
          const job = payload.new;
          if (job.status !== "pending") return;

          try {
            const response = await this.client
              .from("skill_versions")
              .select("id, definition, version, status")
              .eq("id", job.skill_version_id)
              .single();

            if (response.error) throw response.error;

            const skill = {
              ...response.data.definition,
              version: response.data.version,
              status: response.data.status,
              db_version_id: response.data.id
            };

            await onRemoteJob({ job, skill });
          } catch (error) {
            this.sendStatus(`Realtime job РіСЂРµС€РєР°: ${error.message}`, "error");
          }
        }
      )
      .subscribe();

    return true;
  }

  async invokeTeacher(body) {
    const response = await this.client.functions.invoke(
      this.config.teacherFunction,
      { body }
    );

    if (response.error) throw response.error;
    return response.data;
  }

  async createTrainingRequest(command, context) {
    const payload = {
      owner_id: this.user.id,
      device_id: this.deviceId,
      command_text: command,
      context,
      status: "queued"
    };

    const response = await this.client
      .from("training_requests")
      .insert(payload)
      .select("id")
      .single();

    if (response.error) throw response.error;
    return response.data.id;
  }

  async reportRun({ requestId, skill, result, command, jobId = null }) {
    const response = await this.client
      .from("training_runs")
      .insert({
        owner_id: this.user.id,
        device_id: this.deviceId,
        request_id: requestId || null,
        job_id: jobId,
        skill_version_id: skill.db_version_id || null,
        command_text: command,
        status: result.ok ? "success" : "failed",
        result,
        started_at: result.started_at,
        finished_at: result.finished_at
      })
      .select("id")
      .single();

    if (response.error) throw response.error;

    if (jobId) {
      const updateJob = await this.client
        .from("training_jobs")
        .update({
          status: result.ok ? "success" : "failed",
          finished_at: new Date().toISOString(),
          result
        })
        .eq("id", jobId);

      if (updateJob.error) throw updateJob.error;
    }

    if (requestId) {
      const updateRequest = await this.client
        .from("training_requests")
        .update({
          status: result.ok ? "success" : "failed",
          updated_at: new Date().toISOString()
        })
        .eq("id", requestId);

      if (updateRequest.error) throw updateRequest.error;
    }

    return response.data.id;
  }

  async fetchApprovedTeacherLessons() {
 if (!this.client || !this.user) return [];

 const response = await this.client
 .from('sf_twin_teacher_lessons')
 .select('id, trigger_text, lesson_text, status, created_at')
 .eq('status', 'approved')
 .order('created_at', { ascending: true });

 if (response.error) throw response.error;
 return response.data || [];
 }

 async fetchVerifiedSkills() {
    if (!this.client || !this.user) return [];

    const response = await this.client
      .from("skill_versions")
      .select("id, definition, version, status")
      .eq("owner_id", this.user.id)
      .in("status", ["approved", "local_verified"])
      .order("created_at", { ascending: false });

    if (response.error) throw response.error;

    const byKey = new Map();

    for (const row of response.data || []) {
      const skill = {
        ...row.definition,
        version: row.version,
        status: row.status,
        db_version_id: row.id
      };

      if (!byKey.has(skill.skill_key)) {
        byKey.set(skill.skill_key, skill);
      }
    }

    return [...byKey.values()];
  }

  async markSkillVerified(skill) {
    if (!skill.db_version_id) return;

    const response = await this.client
      .from("skill_versions")
      .update({ status: "local_verified" })
      .eq("id", skill.db_version_id);

    if (response.error) throw response.error;
  }

  dispose() {
    if (this.client && this.channel) {
      this.client.removeChannel(this.channel);
    }
  }
}

module.exports = { SupabaseBridge };

