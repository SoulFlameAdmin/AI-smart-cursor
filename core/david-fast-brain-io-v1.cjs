"use strict";

/*
 * DAVID FAST BRAIN I/O V1
 *
 * PURPOSE
 * ------
 * SOUL -> DAVID -> existing fixed ChatGPT session -> DAVID -> SOUL
 *
 * This patch DOES NOT:
 * - change the SOUL relay text
 * - create a new GPT chat
 * - change the fixed route
 * - resend a prompt after reconnect
 * - change the Edge profile
 *
 * It only:
 * 1. writes the already-built relay quickly and verifies it canonically;
 * 2. detects the completed GPT answer quickly but strictly.
 */

const browserModule =
  require("./edge-cdp-soul-browser.cjs");

const VERSION =
  "david-fast-brain-io-v1.0.0";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


function canonical(value) {

  return String(value ?? "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/*
 * ProseMirror can represent the same visible prompt as:
 * text nodes + <p>, <div>, <br>, or visual line breaks.
 *
 * This fingerprint removes ONLY whitespace/separators.
 * Every real letter, punctuation mark and symbol must
 * still match in exactly the same order.
 */
function contentFingerprint(value) {

  return String(value ?? "")
    .normalize("NFC")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/gu, "");
}


async function readComposer(agent) {

  return agent.evaluate(String.raw`
(() => {

  const visible = (element) => {

    if (!element) {
      return false;
    }

    const style =
      getComputedStyle(element);

    const rect =
      element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 &&
      rect.width >= 80 &&
      rect.height >= 18
    );
  };

  const selectors = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"].ProseMirror',
    'form [contenteditable="true"]',
    "textarea"
  ];

  for (const selector of selectors) {

    for (
      const element of
      document.querySelectorAll(selector)
    ) {

      if (!visible(element)) {
        continue;
      }

      if (
        element.matches(
          '[disabled],[aria-disabled="true"]'
        )
      ) {
        continue;
      }

      if (
        element.tagName === "TEXTAREA" ||
        element.tagName === "INPUT"
      ) {
        return String(
          element.value || ""
        );
      }

      /*
       * textContent is intentional.
       *
       * ProseMirror innerText can insert
       * extra visual newline characters.
       * That was producing:
       *
       * expected 1026 -> actual 1047
       * expected 1027 -> actual 1048
       */

      return String(
        element.textContent ||
        element.innerText ||
        ""
      );
    }
  }

  return "";

})()
`);
}


async function finalProof(agent) {

  return agent.evaluate(String.raw`
(() => {

  const assistants =
    Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      )
    );

  const role =
    assistants.at(-1) || null;

  const turn =
    role?.closest(
      '[data-testid^="conversation-turn-"]'
    ) ||
    role?.closest("article") ||
    role ||
    null;

  if (!turn) {

    return {
      hasTurn: false,
      copy: false,
      second: false,
      stop: false,
      streaming: false
    };
  }

  const buttons =
    Array.from(
      turn.querySelectorAll(
        'button,[role="button"]'
      )
    );

  const label = (button) =>

    [
      button.getAttribute?.("aria-label"),
      button.getAttribute?.("data-testid"),
      button.getAttribute?.("title"),
      button.innerText
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  const copy =
    buttons.some((button) => {

      const value = label(button);

      return (
        /copy/.test(value) ||
        /копира/.test(value)
      );
    }) ||

    Boolean(
      turn.querySelector(
        '[data-testid*="copy" i]'
      )
    );

  /*
   * Independent second completion signal.
   *
   * ChatGPT final action bar normally
   * contains additional actions after
   * generation is finished.
   */

  const second =
    buttons.some((button) => {

      const value = label(button);

      return /good response|bad response|read aloud|share|regenerate|retry|listen|сподели|прочети|харес/.test(
        value
      );
    }) ||

    buttons.length >= 2;

  const stop =
    Boolean(
      document.querySelector(
        [
          'button[data-testid="stop-button"]',
          'button[aria-label*="Stop" i]',
          'button[aria-label*="Спри" i]'
        ].join(",")
      )
    );

  const streaming =
    Boolean(
      turn.querySelector(
        [
          '[data-is-streaming="true"]',
          ".result-streaming",
          '[class*="result-streaming"]'
        ].join(",")
      )
    ) ||

    Boolean(
      document.querySelector(
        '[data-is-streaming="true"]'
      )
    );

  return {
    hasTurn: true,
    copy,
    second,
    stop,
    streaming
  };

})()
`);
}


function installDavidFastBrainIO() {

  const Agent =
    browserModule.EdgeSoulBrowserAgent;

  if (!Agent?.prototype) {

    throw new Error(
      "EdgeSoulBrowserAgent prototype not found."
    );
  }

  const prototype =
    Agent.prototype;

  if (
    prototype.__davidFastBrainIOV1
  ) {

    return {
      version: VERSION,
      installed: true,
      already_installed: true
    };
  }


  /*
   * ==========================================================
   * FAST INPUT
   * ==========================================================
   *
   * The relay itself is NOT modified.
   *
   * We use native CDP editor input in small chunks.
   * Verification compares canonical text so visual
   * ProseMirror paragraph/newline expansion cannot create
   * false +21-character mismatches.
   */

  prototype.typePrompt =
    async function davidFastTypePrompt(text) {

      const value =
        String(text ?? "");

      if (!value.trim()) {

        throw new Error(
          "DAVID FAST BRAIN refused an empty GPT prompt."
        );
      }

      const started =
        Date.now();

      const focused =
        await this.focusPrompt();

      if (!focused) {

        throw new Error(
          "DAVID FAST BRAIN could not focus the ChatGPT composer."
        );
      }

      const connection =
        await this.connect();

      /*
       * DAVID FAST ATOMIC INPUT V2
       *
       * Normal SOUL relay (~1 KB):
       * ONE native insert.
       *
       * This prevents ProseMirror state updates between
       * consecutive 256-char chunks from dropping characters.
       */

      // DAVID_ALL_PROMPTS_CLIPBOARD_V5
      // Every prompt uses the proven clipboard Paste transport.
      if (false) {
        // DAVID_LONG_TEXT_WRITER_V3

        await connection.send(
          "Input.insertText",
          {
            text: value
          }
        );
      }
      else {

        /*
         * DAVID_LONG_TEXT_CLIPBOARD_V4
         *
         * Long prompts do NOT use Input.insertText.
         *
         * Whole prompt:
         * OS clipboard -> ONE Chromium Paste command.
         *
         * Existing full prompt verification below stays authoritative.
         * Send still happens only once after verification.
         */

        let clipboardApi = null;

        try {
          clipboardApi =
            require("electron")?.clipboard ||
            null;
        }
        catch {}

        if (!clipboardApi) {
          throw new Error(
            "DAVID LONG TEXT clipboard transport is unavailable."
          );
        }

        /*
         * Preserve the common clipboard formats before DAVID
         * temporarily places the prompt there.
         */

        const previousClipboard = {
          text: clipboardApi.readText(),
          html: clipboardApi.readHTML(),
          rtf: clipboardApi.readRTF(),
          image: clipboardApi.readImage()
        };

        try {

          clipboardApi.writeText(value);

          /*
           * One tiny CDP command.
           * The large text itself no longer travels through
           * repeated Input.insertText commands.
           */

          await connection.send(
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              commands: ["Paste"]
            },
            30000
          );

          /*
           * Give ChatGPT/ProseMirror a short commit window
           * before the existing full-text verification reads it.
           */

          await sleep(250);
        }
        finally {

          /*
           * Restore the user's previous clipboard.
           */

          try {
            const restore = {};

            if (previousClipboard.text) {
              restore.text =
                previousClipboard.text;
            }

            if (previousClipboard.html) {
              restore.html =
                previousClipboard.html;
            }

            if (previousClipboard.rtf) {
              restore.rtf =
                previousClipboard.rtf;
            }

            if (
              previousClipboard.image &&
              !previousClipboard.image.isEmpty()
            ) {
              restore.image =
                previousClipboard.image;
            }

            clipboardApi.clear();

            if (
              Object.keys(restore).length > 0
            ) {
              clipboardApi.write(restore);
            }
          }
          catch {}
        }
      }

      const expected =
        canonical(value);

      /*
       * Maximum local verification window:
       * 650 ms.
       *
       * Usually it succeeds on the first
       * or second observation.
       */

      const deadline =
        Date.now() + (value.length <= 1536 ? 650 : Math.min(10000, 1200 + Math.ceil(value.length / 1024) * 30));

      let actual = "";

      while (
        Date.now() <= deadline
      ) {

        actual =
          await readComposer(this)
            .catch(() => "");

        const exactCanonical =
          canonical(actual) ===
          expected;

        const exactContent =
          contentFingerprint(actual) ===
          contentFingerprint(value);

        /*
         * ACCEPT ONLY IF:
         *
         * 1. normal canonical text is identical, OR
         * 2. every non-whitespace character is identical
         *    in the exact same order.
         *
         * This solves ProseMirror paragraph/newline
         * representation without accepting missing,
         * changed or duplicated real content.
         */

        if (
          exactCanonical ||
          exactContent
        ) {

          this.lastFastPromptWrite = {
            verified: true,
            verification_mode:
              exactCanonical
                ? "canonical"
                : "content_fingerprint",
            raw_length:
              value.length,
            dom_length:
              actual.length,
            elapsed_ms:
              Date.now() - started
          };

          // DAVID_SEND_LOCK_EXPECTED_PROMPT_BRIDGE_V1
          // FAST BRAIN verified the exact relay.
          // Give the existing SEND LOCK the exact same prompt
          // before it is allowed to click Send.
          this.__davidExpectedPromptText = value;

          return value.length;
        }

        await sleep(40);
      }

      throw new Error(
        "DAVID FAST BRAIN input verification failed " +
        `(expected=${value.length}, actual=${actual.length}, ` +
        `canonical_expected=${expected.length}, ` +
        `canonical_actual=${canonical(actual).length}).`
      );
    };


  /*
   * ==========================================================
   * FAST FINAL ANSWER
   * ==========================================================
   *
   * We DO NOT return merely because text appeared.
   *
   * Required:
   * - new assistant turn
   * - non-empty full answer
   * - generation/Stop gone
   * - same-turn Copy action
   * - second action-bar completion signal
   * - same full text stable for 400 ms
   * - final independent confirmation
   *
   * This keeps the "wait for complete GPT answer"
   * lesson while removing the historical 3s + 3s tail.
   */

  prototype.waitForAnswer =
    async function davidFastWaitForAnswer(
      before,
      timeoutMs
    ) {

      const timeout =
        Math.max(
          30000,
          Number(timeoutMs) ||
            240000
        );

      const deadline =
        Date.now() + timeout;

      const beforeCount =
        Number(
          before?.assistantCount || 0
        );

      let stableText = "";
      let stableSince = 0;

      while (
        Date.now() < deadline
      ) {

        try {

          const snapshot =
            await this.getSnapshot();

          if (
            snapshot?.pageError
          ) {

            throw new Error(
              snapshot.pageError
            );
          }

          const text =
            String(
              snapshot?.last || ""
            ).trim();

          const newAssistant =
            Number(
              snapshot?.assistantCount || 0
            ) > beforeCount;

          const proof =
            await finalProof(this);

          const complete =
            Boolean(
              newAssistant &&
              text &&
              !snapshot?.generating &&
              proof?.hasTurn &&
              proof?.copy &&
              proof?.second &&
              !proof?.stop &&
              !proof?.streaming
            );

          if (!complete) {

            stableText = "";
            stableSince = 0;

            await sleep(80);
            continue;
          }

          if (
            text !== stableText
          ) {

            stableText =
              text;

            stableSince =
              Date.now();

            await sleep(80);
            continue;
          }

          /*
           * 400 ms stable final answer.
           *
           * Because Copy/action bar and absence
           * of streaming are already required,
           * this is not merely a text timer.
           */

          if (
            Date.now() -
              stableSince <
            400
          ) {

            await sleep(70);
            continue;
          }

          /*
           * One final independent observation.
           */

          const confirmSnapshot =
            await this.getSnapshot();

          const confirmProof =
            await finalProof(this);

          const confirmText =
            String(
              confirmSnapshot?.last || ""
            ).trim();

          const confirmed =
            Boolean(
              Number(
                confirmSnapshot?.assistantCount ||
                0
              ) > beforeCount &&

              confirmText ===
                stableText &&

              !confirmSnapshot?.generating &&

              confirmProof?.hasTurn &&
              confirmProof?.copy &&
              confirmProof?.second &&
              !confirmProof?.stop &&
              !confirmProof?.streaming
            );

          if (confirmed) {

            this.lastFastFinalProof = {
              verified: true,
              stable_ms:
                Date.now() -
                stableSince,
              answer_length:
                stableText.length
            };

            return stableText;
          }

          stableText = "";
          stableSince = 0;

          await sleep(80);
        }
        catch (error) {

          const message =
            String(
              error?.message ||
              error ||
              ""
            );

          /*
           * Recovery is target reconnect only.
           * NEVER resend the prompt here.
           */

          // DAVID_POST_SEND_CHATGPT_NETWORK_RECOVERY_V3
          if (
            /connection closed|websocket|default execution context|session closed|target closed|timed out|ChatGPT showed a network error|ChatGPT showed Something went wrong/i.test(
              message
            )
          ) {

            try {
              this.connection?.close?.();
            }
            catch {}

            this.connection =
              null;

            this.targetId =
              null;

            // DAVID_FAST_POST_SEND_CDP_RECOVERY_V2
            // The prompt has already been sent. Recover ONLY CDP.
            // Never type or send the prompt again here.
            let cdpRecovered = false;

            while (Date.now() < deadline && !cdpRecovered) {
              try {
                await sleep(250);
                await this.connect();
                cdpRecovered = true;
              }
              catch (reconnectError) {
                const reconnectMessage = String(
                  reconnectError?.message || reconnectError || ""
                );

                if (!/connection closed|websocket|default execution context|session closed|target closed|timed out/i.test(reconnectMessage)) {
                  throw reconnectError;
                }

                try {
                  this.connection?.close?.();
                }
                catch {}

                this.connection = null;
                this.targetId = null;
              }
            }

            continue;
          }

          throw error;
        }
      }

      throw new Error(
        "DAVID FAST BRAIN timed out while waiting for a proven complete GPT answer."
      );
    };


  Object.defineProperty(
    prototype,
    "__davidFastBrainIOV1",
    {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false
    }
  );

  return {
    version: VERSION,
    installed: true,

    relay_text_unchanged: true,

    atomic_input_up_to_8192_chars: false,
    atomic_input_up_to_1536_chars: false,
    all_prompt_transport: "clipboard_paste",
    large_prompt_chunk_size: 0,
    long_text_transport: "clipboard_paste",
    long_text_writer_v3: false,
    long_text_clipboard_v4: true,
    canonical_prompt_verification: true,
    prompt_verify_budget_ms: 650,

    final_copy_signal_required: true,
    final_second_signal_required: true,
    stop_must_be_absent: true,
    streaming_must_be_absent: true,

    final_stable_ms: 400,

    prompt_resend: false
  };
}


module.exports = {
  VERSION,
  installDavidFastBrainIO
};
