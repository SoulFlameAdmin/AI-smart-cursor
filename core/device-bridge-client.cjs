"use strict";

class DeviceBridgeClient {
  constructor({ config, sendStatus }) {
    this.config = config;
    this.sendStatus = sendStatus;
    this.baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
    this.functionName = String(
      config.deviceBridgeFunction || "david-device-bridge"
    ).trim();
    this.token = String(config.deviceToken || "").trim();
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.functionName && this.token.length >= 32);
  }

  async request(op, payload = {}) {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "not_configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(
        `${this.baseUrl}/functions/v1/${encodeURIComponent(this.functionName)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-david-device-token": this.token
          },
          body: JSON.stringify({ op, payload }),
          signal: controller.signal
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.error || `DAVID device bridge HTTP ${response.status}`
        );
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async logEvent(eventType, payload = {}, severity = "info") {
    try {
      return await this.request("log_event", {
        event_type: eventType,
        severity,
        payload
      });
    } catch (error) {
      if (this.sendStatus) {
        this.sendStatus(
          `Supabase дневникът не прие събитието: ${error.message}`,
          "warning"
        );
      }

      return { ok: false, error: error.message };
    }
  }
}

module.exports = { DeviceBridgeClient };
