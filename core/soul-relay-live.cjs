"use strict";

const {
  SoulRelay,
  buildSoulPrompt,
  normalizeClaimedMessage
} = require("./soul-relay.cjs");

const LIVE_RELAY_VERSION = "david-soul-relay-v3";
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
    const startedAt = Date.now();

    try {
      const claimed = await this.bridge.request("claim_soul_message", {
        user_id: this.config.userId || null,
        worker: LIVE_RELAY_VERSION
      });

      job = normalizeClaimedMessage(claimed);
      if (!job) {
        this.currentStage = "waiting";
        return;
      }

      if (this.config.userId && job.userId && job.userId !== this.config.userId) {
        throw new Error("Получено е съобщение от различен SOUL потребител.");
      }

      this.currentMessageId = job.id;

      await this.report(job, LIVE_STAGES.RECEIVED, progressLabel(LIVE_STAGES.RECEIVED), {
        prompt_chars: job.text.length
      });

      const prompt = buildSoulPrompt(job, this.config.maxMessageChars);

      await this.report(job, LIVE_STAGES.OPENING_CHAT, progressLabel(LIVE_STAGES.OPENING_CHAT), {
        chat_host: "chatgpt.com"
      });

      await this.report(job, LIVE_STAGES.SENDING_TO_GPT, progressLabel(LIVE_STAGES.SENDING_TO_GPT), {
        prompt_chars: prompt.length
      });

      this.startHeartbeat(job, startedAt);

      const answer = await this.browser.sendAndWait({
        url: this.config.chatUrl,
        prompt,
        timeoutMs: this.config.responseTimeoutMs
      });

      this.stopHeartbeat();

      await this.report(job, LIVE_STAGES.READING_ANSWER, progressLabel(LIVE_STAGES.READING_ANSWER), {
        answer_chars: answer.length
      });

      await this.report(job, LIVE_STAGES.RETURNING_TO_SOUL, progressLabel(LIVE_STAGES.RETURNING_TO_SOUL), {
        answer_chars: answer.length
      });

      await this.bridge.request("complete_soul_message", {
        message_id: job.id,
        user_id: job.userId || this.config.userId || null,
        conversation_id: job.conversationId || null,
        worker: LIVE_RELAY_VERSION,
        answer
      });

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

      await this.bridge.logEvent("soul_message_completed", {
        message_id: job.id,
        conversation_id: job.conversationId || null,
        answer_chars: answer.length,
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
        relay_version: LIVE_RELAY_VERSION
      });

      this.sendStatus(progressLabel(LIVE_STAGES.COMPLETED), "ready");
    } catch (error) {
      this.stopHeartbeat();
      this.currentStage = LIVE_STAGES.FAILED;
      const errorText = String(error.message || error).slice(0, 1000);
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