"use strict";

const {
  SoulRelay,
  buildSoulPrompt,
  normalizeClaimedMessage,
  validateSoulChatUrl
} = require("./soul-relay-runtime-v3.cjs");
const {
  extractTeacherGoal,
  runTeacherWorkerGoal
} = require("./david-teacher-client.cjs");

const LIVE_RELAY_VERSION = "david-soul-relay-v4-multi-session";
const HEARTBEAT_MS = 5000;

const LIVE_STAGES = Object.freeze({
  RECEIVED: "received",
  OPENING_CHAT: "opening_chat",
  SENDING_TO_GPT: "sending_to_gpt",
  GPT_THINKING: "gpt_thinking",
  READING_ANSWER: "reading_answer",
  RETURNING_TO_SOUL: "returning_to_soul",
  COMPLETED: "completed",
  FAILED: "failed"
});

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function progressKind(stage) {
  if (stage === LIVE_STAGES.FAILED) return "error";
  if (stage === LIVE_STAGES.COMPLETED) return "ready";
  return "working";
}

function progressLabel(stage, elapsedSeconds = 0) {
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);

  switch (stage) {
    case LIVE_STAGES.RECEIVED:
      return "DAVID Electron получи съобщението от Soul.";
    case LIVE_STAGES.OPENING_CHAT:
      return "DAVID Electron отваря постоянната GPT сесия.";
    case LIVE_STAGES.SENDING_TO_GPT:
      return "DAVID изпраща въпроса към GPT контролера.";
    case LIVE_STAGES.GPT_THINKING:
      return `GPT контролира DAVID и подготвя отговор · ${elapsed} сек.`;
    case LIVE_STAGES.READING_ANSWER:
      return "DAVID прочита завършения GPT отговор.";
    case LIVE_STAGES.RETURNING_TO_SOUL:
      return "DAVID връща отговора в същия Soul чат.";
    case LIVE_STAGES.COMPLETED:
      return "Отговорът е върнат в Soul. Чат ходът е завършен.";
    case LIVE_STAGES.FAILED:
      return "DAVID Electron не успя да завърши чат хода.";
    default:
      return "DAVID Electron обработва съобщението.";
  }
}


// DAVID_SOUL_MEMORY_RETRIEVAL_V17_4
async function syncSoulMemoryV174(config = {}) {
  const baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const token = String(config.deviceToken || "").trim();

  if (!baseUrl || token.length < 32) {
    return {
      ok: false,
      status: "DAVID_MEMORY_UNAVAILABLE",
      reason: "not_configured",
      count: 0,
      items: []
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(
      `${baseUrl}/functions/v1/david-memory-bridge`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-david-device-token": token
        },
        body: JSON.stringify({
          op: "sync_context",
          payload: {
            limit: 50,
            include_sensitive: false
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok !== true) {
      throw new Error(
        data?.error ||
        data?.reason ||
        `DAVID memory bridge HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSoulMemoryPreambleV174(memoryPayload) {
  if (
    !memoryPayload ||
    memoryPayload.ok !== true ||
    !Array.isArray(memoryPayload.items) ||
    memoryPayload.items.length === 0
  ) {
    return "";
  }

  const verified = [];
  let chars = 0;

  for (const item of memoryPayload.items) {
    const entry = {
      record_id: Number(item?.record_id) || null,
      type: String(item?.type || "fact"),
      title: item?.title == null ? null : String(item.title),
      content: String(item?.content || ""),
      checksum: String(item?.checksum || "")
    };

    const size = JSON.stringify(entry).length;

    if (verified.length >= 20 || chars + size > 12000) {
      break;
    }

    verified.push(entry);
    chars += size;
  }

  if (verified.length === 0) {
    return "";
  }

  return [
    "DAVID_PERSISTENT_MEMORY_V17_4",
    "The following records were loaded live from DAVID persistent Supabase memory.",
    "They are verified, active, user-confirmed, read-only memory context.",
    "Use them when relevant. Do not claim a memory exists unless it is present below.",
    JSON.stringify({
      status: String(memoryPayload.status || "DAVID_MEMORY_READY"),
      active_count: Number(memoryPayload.count || verified.length),
      context_checksum: String(memoryPayload.context_checksum || ""),
      items: verified
    }, null, 2)
  ].join("\n");
}


class LiveSoulRelay extends SoulRelay {
  constructor(options) {
    super(options);
    this.autoStart = parseBoolean(process.env.DAVID_SOUL_AUTO_START, true);
    this.currentStage = "idle";
    this.heartbeatTimer = null;
    this.heartbeatBusy = false;
  }

  getStatus() {
    return {
      ...super.getStatus(),
      auto_start: this.autoStart,
      stage: this.currentStage,
      relay_version: LIVE_RELAY_VERSION,
      heartbeat_ms: HEARTBEAT_MS
    };
  }

  async start() {
    const fixedRouteMode = String(process.env.DAVID_FIXED_ROUTE_MODE || "1") !== "0";
    if (fixedRouteMode) {
      this.sendStatus(
        "DAVID uses one fixed GPT conversation for this isolated Edge port.",
        "ready"
      );
    } else {
      try {
        const routeData = await this.bridge.request("list_chat_routes", {
          worker: LIVE_RELAY_VERSION
        });
        const routes = Array.isArray(routeData?.routes) ? routeData.routes : [];
        if (routes.length > 0 && typeof this.browser?.preloadRoutes === "function") {
          const preload = this.browser.preloadRoutes(routes);
          this.sendStatus(
            `DAVID loaded ${routes.length} GPT routes.`,
            "ready"
          );
          Promise.resolve(preload).catch((error) => {
            this.sendStatus(`DAVID background preload: ${error.message}`, "warning");
          });
        }
      } catch (error) {
        this.sendStatus(
          `DAVID could not preload GPT routes; the primary route stays active: ${error.message}`,
          "warning"
        );
      }
    }

    await super.start();
    this.sendStatus(
      "DAVID Electron е постоянно свързан със Soul · чакам въпроси",
      "ready"
    );
    return this.getStatus();
  }

  stop() {
    this.stopHeartbeat();
    this.currentStage = "stopped";
    return super.stop();
  }

  async report(job, stage, message = progressLabel(stage), details = {}) {
    this.currentStage = stage;
    const kind = progressKind(stage);
    this.sendStatus(message, kind);
    await this.browser.showReport(stage, message, details, kind).catch(() => {});

    if (!job?.id) return { ok: true, local_only: true };

    try {
      return await this.bridge.request("progress_soul_message", {
        message_id: job.id,
        user_id: job.userId || this.config.userId || null,
        conversation_id: job.conversationId || null,
        worker: LIVE_RELAY_VERSION,
        stage,
        message,
        details: {
          conversation_id: job.conversationId || null,
          ...details
        }
      });
    } catch (error) {
      this.sendStatus(`Soul отчетът не се обнови: ${error.message}`, "warning");
      return { ok: false, error: error.message };
    }
  }

  startHeartbeat(job, startedAt) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this.heartbeatBusy || !this.active || !this.busy) return;
      this.heartbeatBusy = true;
      try {
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        await this.report(
          job,
          LIVE_STAGES.GPT_THINKING,
          progressLabel(LIVE_STAGES.GPT_THINKING, elapsedSeconds),
          { elapsed_seconds: elapsedSeconds }
        );
      } finally {
        this.heartbeatBusy = false;
      }
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatBusy = false;
  }

  async pollOnce() {
    if (!this.active || this.busy) return;
    this.busy = true;
    let job = null;
    let completionCommitted = false;
    const startedAt = Date.now();

    try {
      const claimed = await this.bridge.request("claim_soul_message", {
        user_id: null,
        all_routed_users: true,
        worker: LIVE_RELAY_VERSION
      });

      job = normalizeClaimedMessage(claimed);
      if (!job) {
        this.currentStage = "waiting";
        return;
      }

      const targetChatUrl = validateSoulChatUrl(
        job.chatUrl || this.config.chatUrl
      );


      this.currentMessageId = job.id;

      await this.report(job, LIVE_STAGES.RECEIVED, progressLabel(LIVE_STAGES.RECEIVED), {
        prompt_chars: job.text.length
      });

      const teacherGoal = extractTeacherGoal(job.text);

      // DAVID_SOUL_MEMORY_RETRIEVAL_V17_4
      let soulMemoryV174 = null;

      try {
        soulMemoryV174 = await syncSoulMemoryV174(this.config);

        if (soulMemoryV174?.ok === true) {
          this.sendStatus(
            `DAVID MEMORY LIVE | active=${Number(soulMemoryV174.count || 0)}`,
            "ready",
            {
              stage: "persistent_memory_loaded",
              active_count: Number(soulMemoryV174.count || 0),
              context_checksum: String(
                soulMemoryV174.context_checksum || ""
              )
            }
          );
        }
      } catch (memoryError) {
        soulMemoryV174 = {
          ok: false,
          status: "DAVID_MEMORY_UNAVAILABLE",
          error: String(memoryError?.message || memoryError),
          count: 0,
          items: []
        };

        this.sendStatus(
          `DAVID MEMORY LIVE unavailable: ${soulMemoryV174.error}`,
          "warning",
          { stage: "persistent_memory_unavailable" }
        );
      }

      const soulBasePromptV174 =
        buildSoulPrompt(job, this.config.maxMessageChars);

      const soulMemoryPreambleV174 =
        buildSoulMemoryPreambleV174(soulMemoryV174);

      const prompt = soulMemoryPreambleV174
        ? `${soulMemoryPreambleV174}\n\nUSER_REQUEST:\n${soulBasePromptV174}`
        : soulBasePromptV174;

      await this.report(job, LIVE_STAGES.OPENING_CHAT, progressLabel(LIVE_STAGES.OPENING_CHAT), {
        chat_host: "chatgpt.com"
      });

      await this.report(job, LIVE_STAGES.SENDING_TO_GPT, progressLabel(LIVE_STAGES.SENDING_TO_GPT), {
        prompt_chars: prompt.length
      });

      this.startHeartbeat(job, startedAt);

      let answer;
      if (teacherGoal) {
        await this.report(
          job,
          LIVE_STAGES.GPT_THINKING,
          "DAVID Thinker и PowerShell Worker изпълняват учебната задача.",
          { teacher_worker: true, thinker_port: 9444 }
        );
        // DAVID_SOUL_WORKER_PROGRESS_BRIDGE_V14
        // The worker owns its heartbeat while the long Teacher job is active.
        this.stopHeartbeat();
        let workerProgressChain = Promise.resolve();
        const teacherResult = await runTeacherWorkerGoal({
          goal: teacherGoal,
          projectRoot: this.browser?.rootDir || process.cwd(),
          sendStatus: this.sendStatus,
          onProgress: (event) => {
            const stage = String(event?.stage || "working");
            const message = String(event?.message || "DAVID СЂР°Р±РѕС‚Рё.").slice(0, 900);
            const details = {
              teacher_worker: true,
              worker_stage: stage,
              round: Number(event?.meta?.round || 0) || null,
              action_id: String(event?.meta?.action_id || "").slice(0, 120) || null,
              elapsed_seconds: Number(event?.meta?.elapsed_seconds || 0) || null,
              exit_code: Number.isInteger(event?.meta?.exit_code)
                ? event.meta.exit_code
                : null
            };
            workerProgressChain = workerProgressChain
              .then(() => this.report(
                job,
                LIVE_STAGES.GPT_THINKING,
                message,
                details
              ))
              .catch(() => {});
            return workerProgressChain;
          }
        });
        await workerProgressChain;
        answer = [
          teacherResult.ok ? "DAVID WORKER: ГОТОВО" : "DAVID WORKER: СПРЯНО",
          `Статус: ${teacherResult.status || "unknown"}`,
          teacherResult.round ? `Рунд: ${teacherResult.round}` : "",
          String(teacherResult.summary || "Няма финално обобщение.")
        ].filter(Boolean).join("\n");
      } else {
        answer = await this.browser.sendAndWait({
          url: targetChatUrl,
          prompt,
          timeoutMs: Math.max(Number(this.config.responseTimeoutMs) || 0, 86400000) // DAVID_FULL_TURN_TIMEOUT_V2
        });
      }

      this.stopHeartbeat();

      await this.report(job, LIVE_STAGES.READING_ANSWER, progressLabel(LIVE_STAGES.READING_ANSWER), {
        answer_chars: answer.length
      });

      await this.report(job, LIVE_STAGES.RETURNING_TO_SOUL, progressLabel(LIVE_STAGES.RETURNING_TO_SOUL), {
        answer_chars: answer.length
      });

      // DAVID_FULL_TURN_CHUNKED_RETURN_V2
      // The local answer is authoritative only after GPT has really ended.
      // Large answers are uploaded in ordered chunks and the server verifies
      // total character count + SHA256 before marking the Soul turn completed.
      const FULL_TURN_DIRECT_CHARS = 60000;
      const FULL_TURN_CHUNK_CHARS = 60000;
      const answerSha256 = require("crypto")
        .createHash("sha256")
        .update(answer, "utf8")
        .digest("hex");

      if (answer.length <= FULL_TURN_DIRECT_CHARS) {
        await this.bridge.request("complete_soul_message", {
          message_id: job.id,
          user_id: job.userId || this.config.userId || null,
          conversation_id: job.conversationId || null,
          worker: LIVE_RELAY_VERSION,
          answer
        });
      } else {
        await this.bridge.request("begin_soul_answer_chunks", {
          message_id: job.id,
          user_id: job.userId || this.config.userId || null,
          worker: LIVE_RELAY_VERSION
        });

        const totalChunks = Math.ceil(answer.length / FULL_TURN_CHUNK_CHARS);

        for (let seq = 0; seq < totalChunks; seq += 1) {
          const start = seq * FULL_TURN_CHUNK_CHARS;
          const chunk = answer.slice(start, start + FULL_TURN_CHUNK_CHARS);

          await this.bridge.request("append_soul_answer_chunk", {
            message_id: job.id,
            user_id: job.userId || this.config.userId || null,
            worker: LIVE_RELAY_VERSION,
            seq,
            chunk
          });
        }

        await this.bridge.request("complete_soul_message_chunked", {
          message_id: job.id,
          user_id: job.userId || this.config.userId || null,
          conversation_id: job.conversationId || null,
          worker: LIVE_RELAY_VERSION,
          total_chunks: totalChunks,
          total_chars: answer.length,
          sha256: answerSha256
        });
      }
      completionCommitted = true;

      this.currentStage = LIVE_STAGES.COMPLETED;
      await this.browser.showReport(
        LIVE_STAGES.COMPLETED,
        progressLabel(LIVE_STAGES.COMPLETED),
        {
          answer_chars: answer.length,
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000)
        },
        "ready"
      ).catch(() => {});

      try {
        await this.bridge.logEvent("soul_message_completed", {
          message_id: job.id,
          conversation_id: job.conversationId || null,
          answer_chars: answer.length,
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
          relay_version: LIVE_RELAY_VERSION
        });
      } catch (telemetryError) {
        const telemetryText = String(
          telemetryError?.message || telemetryError || "telemetry failed"
        ).slice(0, 300);
        this.sendStatus(
          `SOUL отговорът е завършен. Допълнителният telemetry log не се записа: ${telemetryText}`,
          "warning"
        );
      }

      this.sendStatus(progressLabel(LIVE_STAGES.COMPLETED), "ready");
    } catch (error) {
      this.stopHeartbeat();
      const errorText = String(error.message || error).slice(0, 1000);

      if (completionCommitted) {
        this.currentStage = LIVE_STAGES.COMPLETED;
        this.sendStatus(
          `SOUL отговорът вече е завършен. Вторична операция не успя: ${errorText}`,
          "warning"
        );
        return;
      }

      this.currentStage = LIVE_STAGES.FAILED;
      await this.browser.showReport(LIVE_STAGES.FAILED, errorText, {}, "error").catch(() => {});

      if (job?.id) {
        try {
          await this.bridge.request("fail_soul_message", {
            message_id: job.id,
            user_id: job.userId || this.config.userId || null,
            worker: LIVE_RELAY_VERSION,
            error: errorText
          });
        } catch {}
      }

      throw error;
    } finally {
      this.stopHeartbeat();
      this.currentMessageId = null;
      this.busy = false;
    }
  }
}

module.exports = {
  HEARTBEAT_MS,
  LIVE_RELAY_VERSION,
  LIVE_STAGES,
  LiveSoulRelay,
  progressLabel
};
