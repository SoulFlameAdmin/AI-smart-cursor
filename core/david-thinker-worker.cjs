"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  EdgeSoulBrowserAgent,
  sameConversation
} = require("./edge-cdp-soul-browser.cjs");
const { TeacherLoop } = require("./teacher-loop.cjs");

const THINKER_URL = process.env.DAVID_TEACHER_CHAT_URL ||
  "https://chatgpt.com/c/6a81285a-3e38-83ed-965a-b221453fb742";
const THINKER_PORT = Number(process.env.DAVID_TEACHER_EDGE_PORT || 9444);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizePrompt(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Teacher request path escapes DAVID runtime.");
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

function decodeForPowerShell(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function confirmAction({ title, detail }) {
  const title64 = decodeForPowerShell(title || "DAVID PowerShell confirmation");
  const detail64 = decodeForPowerShell(detail || "DAVID requests permission.");
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    `$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${title64}'))`,
    `$detail=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${detail64}'))`,
    "$result=[System.Windows.MessageBox]::Show($detail,$title,'YesNo','Warning')",
    "if($result -eq 'Yes'){exit 0}else{exit 2}"
  ].join(";");
  const executable = process.env.DAVID_POWERSHELL_EXE || "powershell.exe";
  const result = spawnSync(executable, [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(script)
  ], {
    windowsHide: false,
    stdio: "ignore",
    timeout: 10 * 60 * 1000
  });
  return result.status === 0;
}

class AttachedThinkerBrowser extends EdgeSoulBrowserAgent {
  async ensureEdge() {
    if (!(await this.debuggerReady())) {
      throw new Error(
        `Thinker Edge port ${this.port} is offline. Keep START-DAVID-ALL running.`
      );
    }
    return true;
  }

  startEdge() {
    throw new Error("Teacher worker cannot create another Edge process.");
  }

  async findOrCreateTarget() {
    // DAVID_THINKER_LOGIN_HOLD_V3
    //
    // During Google/OpenAI/Microsoft authentication the fixed Thinker tab
    // temporarily stops being the exact conversation URL.
    // Reuse the SAME tab. Never create or replace it during login.

    const targets = await this.debuggerJson("/json/list");
    const pages = targets.filter((item) => item?.type === "page");

    let target = pages.find((item) =>
      sameConversation(item.url, this.chatUrl)
    );

    // Keep the exact target that the worker was already attached to.
    if (!target && this.targetId) {
      target = pages.find((item) => item.id === this.targetId) || null;
    }

    // OAuth / ChatGPT login hold.
    if (!target) {
      target = pages.find((item) => {
        const url = String(item?.url || "");

        return (
          /^https:\/\/chatgpt\.com\//i.test(url) ||
          /^https:\/\/auth\.openai\.com\//i.test(url) ||
          /^https:\/\/accounts\.google\./i.test(url) ||
          /^https:\/\/login\.microsoftonline\.com\//i.test(url)
        );
      }) || null;
    }

    if (!target?.webSocketDebuggerUrl) {
      throw new Error(
        `DAVID Thinker LOGIN_HOLD: port ${this.port} has no usable Thinker/authentication tab. Finish login in the existing DAVID Edge profile.`
      );
    }

    if (target.id) {
      this.targetId = target.id;
    }

    return target;
  }

  async typePrompt(text) {
    // DAVID_WORKER_ATOMIC_INPUT_V2
    //
    // Structured Teacher JSON must not be typed in many keyboard chunks: the
    // ChatGPT editor can drop characters between CDP events. Clear the visible
    // composer, insert the entire payload through one native CDP insertText,
    // and verify the complete normalized value before Send is permitted.
    const expected = String(text ?? "");
    if (!expected.trim()) {
      throw new Error("DAVID Worker refused an empty Thinker prompt.");
    }

    const prepared = await this.evaluate(`(() => {
      const visible = (element) => {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 100 && rect.height > 10;
      };
      const selectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const prompt = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find(visible) || null;
      if (!prompt) return { ok: false, reason: 'prompt_not_found' };
      prompt.scrollIntoView({ block: 'center', inline: 'nearest' });
      prompt.focus();
      if (prompt.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(prompt);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
      } else {
        const prototype = prompt instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(prompt, '');
        else prompt.value = '';
        prompt.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'deleteContentBackward',
          data: null
        }));
      }
      return { ok: true };
    })()`);

    if (!prepared?.ok) {
      throw new Error(
        `DAVID Worker could not prepare the Thinker composer ` +
        `(reason=${String(prepared?.reason || "unknown")}).`
      );
    }

    const connection = this.connection || await this.connect();
    await connection.send("Page.bringToFront").catch(() => {});
    // DAVID_THINKER_INSERT_RECOVERY_V18_2
    // A long prompt can reach the ChatGPT composer even when Edge does not
    // acknowledge Input.insertText before the watchdog expires. Recover only
    // that exact timeout. Drop the stale CDP socket and let the existing
    // exact composer verification decide whether sending is safe.
    let davidThinkerInsertTimedOutV182 = false;
    try {
      const davidThinkerInsertTimeoutMsV182 = Math.max(
        15000,
        Math.min(45000, 8000 + Math.ceil(expected.length / 2048) * 1000)
      );
      await connection.send(
        "Input.insertText",
        { text: expected },
        davidThinkerInsertTimeoutMsV182
      );
    } catch (error) {
      const davidThinkerInsertErrorV182 = String(error?.message || error || "");
      if (!/Input\.insertText timed out/i.test(davidThinkerInsertErrorV182)) throw error;
      davidThinkerInsertTimedOutV182 = true;
      try { connection.close?.(); } catch {}
      if (this.connection === connection) this.connection = null;
      this.targetId = null;
    }
    await sleep(450);

    const verify = async () => this.evaluate(`(() => {
      const normalize = (value) => String(value || '')
        .replace(/\\u200b/g, '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\r\\n/g, '\\n')
        .replace(/\\s+/g, ' ')
        .trim();
      const expected = ${JSON.stringify(expected)};
      const selectors = [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea'
      ];
      const prompt = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        .find((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 100 && rect.height > 10;
        }) || null;
      if (!prompt) return { ok: false, reason: 'prompt_not_found', chars: 0 };
      const current = prompt.isContentEditable
        ? String(prompt.innerText || prompt.textContent || '')
        : String(prompt.value || '');
      return {
        ok: normalize(current) === normalize(expected),
        reason: normalize(current) === normalize(expected) ? 'exact' : 'text_mismatch',
        chars: current.length,
        expectedChars: expected.length
      };
    })()`);

    let proof = await verify();
    if (!proof?.ok) {
      // One deterministic editor fallback. It replaces the entire value; it
      // never appends and therefore cannot duplicate a partially typed prompt.
      await this.evaluate(`(() => {
        const text = ${JSON.stringify(expected)};
        const selectors = [
          '#prompt-textarea',
          '[data-testid="prompt-textarea"]',
          '[contenteditable="true"][role="textbox"]',
          'textarea'
        ];
        const prompt = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .find((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' &&
              Number(style.opacity || 1) !== 0 && rect.width > 100 && rect.height > 10;
          }) || null;
        if (!prompt) return false;
        prompt.focus();
        if (prompt.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(prompt);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false, null);
          const inserted = document.execCommand('insertText', false, text);
          if (!inserted) prompt.textContent = text;
        } else {
          const prototype = prompt instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(prompt, text);
          else prompt.value = text;
        }
        prompt.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
        prompt.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(550);
      proof = await verify();
    }

    if (!proof?.ok) {
      throw new Error(
        `DAVID Worker atomic input verification failed ` +
        `(expected=${expected.length}, actual=${Number(proof?.chars || 0)}, ` +
        `reason=${String(proof?.reason || "unknown")}).`
      );
    }

    this.__davidExpectedPromptText = expected;
    await this.showReport?.(
      "worker_prompt_verified",
      "DAVID Worker verified the complete Thinker prompt before Send.",
      {
        input_method: "atomic_cdp_insert_text",
        prompt_chars: expected.length
      },
      "working"
    ).catch(() => {});
    return expected.length;
  }

  async sendPrompt(before = {}) {
    // DAVID_WORKER_TRUSTED_SEND_V1
    //
    // The base sender uses Enter. ChatGPT can interpret that Enter as a new
    // line for structured/multiline Teacher JSON. Resolve the real enabled
    // Send button, press its exact center through trusted CDP mouse input once,
    // then require proof that ChatGPT consumed the composer and started/added
    // the new user turn. No Enter fallback and no duplicate click.
    const expected = String(this.__davidExpectedPromptText || "");
    const expectedNormalized = normalizePrompt(expected);
    if (!expectedNormalized) {
      throw new Error("DAVID Worker Send has no verified prompt text.");
    }

    let buttonState = null;
    const readyDeadline = Date.now() + 15000;
    while (Date.now() < readyDeadline) {
      buttonState = await this.evaluate(`(() => {
        const normalize = (value) => String(value || '')
          .replace(/\\u200b/g, '')
          .replace(/\\u00a0/g, ' ')
          .replace(/\\r\\n/g, '\\n')
          .replace(/\\s+/g, ' ')
          .trim();
        const visible = (element) => {
          if (!element || !element.isConnected) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) !== 0 && rect.width > 4 && rect.height > 4;
        };
        const expected = ${JSON.stringify(expected)};
        const promptSelectors = [
          '#prompt-textarea',
          '[data-testid="prompt-textarea"]',
          '[contenteditable="true"][role="textbox"]',
          'textarea'
        ];
        const prompt = promptSelectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .find(visible) || null;
        if (!prompt) return { ok: false, reason: 'prompt_not_found' };
        const current = prompt.isContentEditable
          ? String(prompt.innerText || prompt.textContent || '')
          : String(prompt.value || '');
        if (normalize(current) !== normalize(expected)) {
          return {
            ok: false,
            reason: 'composer_text_mismatch',
            composerChars: current.length,
            expectedChars: expected.length
          };
        }
        const sendSelectors = [
          'button[data-testid="send-button"]',
          'button[data-testid*="send" i]',
          'button[aria-label*="Send" i]',
          'button[aria-label*="Submit" i]',
          'button[aria-label*="Изпращ" i]',
          'form button[type="submit"]'
        ];
        const button = sendSelectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .find((element) => visible(element) && !element.disabled &&
            element.getAttribute('aria-disabled') !== 'true') || null;
        if (!button) {
          return {
            ok: false,
            reason: 'send_button_not_ready',
            composerChars: current.length
          };
        }
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        prompt.focus();
        const rect = button.getBoundingClientRect();
        return {
          ok: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          composerChars: current.length
        };
      })()`);

      if (buttonState?.ok) break;
      if (buttonState?.reason === "composer_text_mismatch") {
        throw new Error(
          `DAVID Worker refused Send because composer text changed ` +
          `(expected=${expected.length}, actual=${Number(buttonState.composerChars || 0)}).`
        );
      }
      await sleep(150);
    }

    if (!buttonState?.ok) {
      throw new Error(
        `DAVID Worker could not find an enabled Send button ` +
        `(reason=${String(buttonState?.reason || "unknown")}).`
      );
    }

    const connection = this.connection || await this.connect();
    await connection.send("Page.bringToFront").catch(() => {});
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Number(buttonState.x),
      y: Number(buttonState.y),
      button: "none",
      buttons: 0
    });
    await connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Number(buttonState.x),
      y: Number(buttonState.y),
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Number(buttonState.x),
      y: Number(buttonState.y),
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    await this.showReport?.(
      "worker_send_pressed",
      "DAVID Worker pressed the verified Thinker Send button.",
      { send_method: "trusted_cdp_mouse", prompt_chars: expected.length },
      "working"
    ).catch(() => {});

    const beforeUserCount = Number(before?.userCount || 0);
    const beforeLastUser = normalizePrompt(before?.lastUser || before?.lastUserText || "");
    const beforeAssistant = normalizePrompt(before?.last || "");
    const boundedMs = (override, fallback) => {
      const numeric = Number(override);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
    };
    const primaryConfirmMs = boundedMs(
      this.__davidSendPrimaryConfirmMs,
      20000
    );
    const restoredDraftGraceMs = boundedMs(
      this.__davidSendRestoredDraftGraceMs,
      12000
    );
    const fallbackConfirmMs = boundedMs(
      this.__davidSendFallbackConfirmMs,
      20000
    );
    const confirmationPollMs = boundedMs(
      this.__davidSendConfirmationPollMs,
      150
    );
    let confirmationPhase = "primary";
    let phaseStarted = Date.now();
    let fallbackClickCount = 0;
    let lastProof = null;
    let lastSnapshot = null;

    while (true) {
      lastSnapshot = await this.getSnapshot().catch(() => null);
      lastProof = await this.evaluate(`(() => {
        const normalize = (value) => String(value || '')
          .replace(/\\u200b/g, '')
          .replace(/\\u00a0/g, ' ')
          .replace(/\\r\\n/g, '\\n')
          .replace(/\\s+/g, ' ')
          .trim();
        const expected = ${JSON.stringify(expectedNormalized)};
        const userNodes = Array.from(document.querySelectorAll(
          '[data-message-author-role="user"], ' +
          '[data-testid^="conversation-turn-"] [data-message-author-role="user"]'
        ));
        const texts = [...new Set(userNodes)].map((node) => {
          const clone = node.cloneNode(true);
          clone.querySelectorAll('button,[role="button"],svg').forEach((item) => item.remove());
          return normalize(clone.innerText || clone.textContent || '');
        });
        const prompt = document.querySelector(
          '#prompt-textarea, [data-testid="prompt-textarea"], ' +
          '[contenteditable="true"][role="textbox"], textarea'
        );
        const composerText = prompt
          ? normalize(prompt.isContentEditable
              ? (prompt.innerText || prompt.textContent || '')
              : (prompt.value || ''))
          : '';
        const stopVisible = Array.from(document.querySelectorAll(
          'button[data-testid*="stop" i], button[aria-label*="Stop" i]'
        )).some((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            rect.width > 4 && rect.height > 4;
        });
        return {
          composerEmpty: composerText.length === 0,
          composerChars: composerText.length,
          composerMatchesExpected: composerText === expected,
          exactMatches: texts.filter((text) => text === expected).length,
          stopVisible
        };
      })()`).catch(() => null);

      const observedLastUser = normalizePrompt(
        lastSnapshot?.lastUser || lastSnapshot?.lastUserText || ""
      );
      const observedAssistant = normalizePrompt(lastSnapshot?.last || "");
      const userTurnChanged =
        Number(lastSnapshot?.userCount || 0) > beforeUserCount ||
        (observedLastUser && observedLastUser !== beforeLastUser);
      const activityConfirmed =
        Boolean(lastSnapshot?.generating) ||
        Boolean(lastProof?.stopVisible) ||
        (observedAssistant && observedAssistant !== beforeAssistant);
      const exactUserTurn = Number(lastProof?.exactMatches || 0) > 0;
      const composerEmpty = Boolean(lastProof?.composerEmpty);
      const composerMatchesExpected = Boolean(
        lastProof?.composerMatchesExpected
      );
      const proofAvailable = Boolean(
        lastProof && typeof lastProof.composerEmpty === "boolean"
      );

      if (
        composerEmpty &&
        (exactUserTurn || userTurnChanged || activityConfirmed)
      ) {
        this.__davidExpectedPromptText = "";
        await this.showReport?.(
          "worker_send_confirmed",
          "DAVID Worker confirmed that Thinker accepted the complete prompt.",
          {
            send_method: "trusted_cdp_mouse",
            exact_user_turn: exactUserTurn,
            activity_confirmed: activityConfirmed
          },
          "working"
        ).catch(() => {});
        return lastSnapshot;
      }

      const phaseElapsed = Date.now() - phaseStarted;

      if (
        confirmationPhase === "primary" &&
        phaseElapsed >= primaryConfirmMs
      ) {
        // DAVID_WORKER_TRANSACTIONAL_SEND_V2
        // A consumed composer alone is not proof of a submitted turn because
        // React can restore the exact draft later. Enter a bounded grace phase
        // and observe whether that exact verified draft comes back.
        confirmationPhase = "restored_draft_grace";
        phaseStarted = Date.now();
      } else if (confirmationPhase === "restored_draft_grace") {
        if (
          composerMatchesExpected &&
          !exactUserTurn &&
          !userTurnChanged &&
          !activityConfirmed
        ) {
          // The exact verified draft reappeared and no send evidence exists.
          // This is the only state that permits one fallback click. Re-resolve
          // the real enabled button and re-check user/activity proof inside the
          // same page task immediately before the programmatic click.
          const fallback = await this.evaluate(`(() => {
            const normalize = (value) => String(value || '')
              .replace(/\\u200b/g, '')
              .replace(/\\u00a0/g, ' ')
              .replace(/\\r\\n/g, '\\n')
              .replace(/\\s+/g, ' ')
              .trim();
            const expected = ${JSON.stringify(expectedNormalized)};
            const visible = (element) => {
              if (!element || !element.isConnected) return false;
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' &&
                Number(style.opacity || 1) !== 0 && rect.width > 4 && rect.height > 4;
            };
            const prompt = [
              '#prompt-textarea',
              '[data-testid="prompt-textarea"]',
              '[contenteditable="true"][role="textbox"]',
              'textarea'
            ].flatMap((selector) => Array.from(document.querySelectorAll(selector)))
              .find(visible) || null;
            if (!prompt) return { clicked: false, reason: 'prompt_not_found' };
            const current = normalize(prompt.isContentEditable
              ? (prompt.innerText || prompt.textContent || '')
              : (prompt.value || ''));
            if (current !== expected) {
              return { clicked: false, reason: 'draft_not_exact', composerChars: current.length };
            }
            const exactUserTurn = Array.from(document.querySelectorAll(
              '[data-message-author-role="user"]'
            )).some((node) => normalize(node.innerText || node.textContent || '') === expected);
            const stopVisible = Array.from(document.querySelectorAll(
              'button[data-testid*="stop" i], button[aria-label*="Stop" i]'
            )).some(visible);
            if (exactUserTurn || stopVisible) {
              return { clicked: false, reason: 'turn_or_activity_present' };
            }
            const button = [
              'button[data-testid="send-button"]',
              'button[data-testid*="send" i]',
              'button[aria-label*="Send" i]',
              'button[aria-label*="Submit" i]',
              'button[aria-label*="Изпращ" i]',
              'form button[type="submit"]'
            ].flatMap((selector) => Array.from(document.querySelectorAll(selector)))
              .find((element) => visible(element) && !element.disabled &&
                element.getAttribute('aria-disabled') !== 'true') || null;
            if (!button) return { clicked: false, reason: 'send_button_not_ready' };
            button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            button.click();
            return { clicked: true, reason: 'exact_draft_restored' };
          })()`).catch(() => null);

          if (fallback?.reason === "turn_or_activity_present") {
            await sleep(confirmationPollMs);
            continue;
          }
          if (!fallback?.clicked) {
            throw new Error(
              `DAVID Worker saw the exact restored Thinker draft but the ` +
              `single fallback Send was unavailable ` +
              `(reason=${String(fallback?.reason || "unknown")}).`
            );
          }

          fallbackClickCount = 1;
          confirmationPhase = "fallback_confirmation";
          phaseStarted = Date.now();
          await this.showReport?.(
            "worker_send_restored_draft_fallback",
            "DAVID Worker detected the exact restored draft and used one bounded DOM Send fallback.",
            {
              send_method: "restored_draft_dom_click",
              fallback_clicks: fallbackClickCount,
              prompt_chars: expected.length
            },
            "working"
          ).catch(() => {});
          await sleep(confirmationPollMs);
          continue;
        }

        if (
          proofAvailable &&
          !composerEmpty &&
          !composerMatchesExpected
        ) {
          throw new Error(
            `DAVID Worker stopped because the Thinker composer changed after ` +
            `Send (composer_chars=${Number(lastProof?.composerChars || 0)}).`
          );
        }

        if (phaseElapsed >= restoredDraftGraceMs) {
          if (!proofAvailable) {
            throw new Error(
              "DAVID Worker could not inspect the Thinker composer during Send confirmation."
            );
          }
          if (composerEmpty) {
            // The verified composer was consumed and never restored, but the
            // virtualized DOM did not expose a turn yet. Never resend. Continue
            // into waitForAnswer(), which still requires a complete GPT answer.
            this.__davidExpectedPromptText = "";
            await this.showReport?.(
              "worker_send_commit_pending",
              "DAVID Worker kept the no-resend lock and continued to wait for the Thinker answer.",
              {
                send_method: "trusted_cdp_mouse",
                composer_consumed: true,
                fallback_clicks: fallbackClickCount
              },
              "working"
            ).catch(() => {});
            return lastSnapshot;
          }
        }
      } else if (
        confirmationPhase === "fallback_confirmation" &&
        phaseElapsed >= fallbackConfirmMs
      ) {
        if (!proofAvailable) {
          throw new Error(
            "DAVID Worker could not inspect Thinker after the bounded fallback Send."
          );
        }
        if (composerEmpty) {
          this.__davidExpectedPromptText = "";
          await this.showReport?.(
            "worker_send_fallback_commit_pending",
            "DAVID Worker consumed the restored draft once and continued to wait for the Thinker answer.",
            {
              send_method: "restored_draft_dom_click",
              composer_consumed: true,
              fallback_clicks: fallbackClickCount
            },
            "working"
          ).catch(() => {});
          return lastSnapshot;
        }

        throw new Error(
          `DAVID Worker single fallback Send did not consume the exact restored ` +
          `draft (composer_chars=${Number(lastProof?.composerChars || 0)}).`
        );
      }

      await sleep(confirmationPollMs);
    }
  }
}

async function main() {
  const requestIndex = process.argv.indexOf("--request");
  if (requestIndex < 0 || !process.argv[requestIndex + 1]) {
    throw new Error("Missing --request file.");
  }

  const projectRoot = path.resolve(
    process.env.DAVID_REPOSITORY_ROOT || path.resolve(__dirname, "..")
  );
  const requestRoot = path.join(projectRoot, ".david-runtime", "teacher-requests");
  const requestFile = path.resolve(process.argv[requestIndex + 1]);
  assertInside(requestRoot, requestFile);

  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const resultFile = path.resolve(String(request.result_file || ""));
  assertInside(requestRoot, resultFile);

  const statusEvents = [];
  const sendStatus = (message, kind = "working", meta = {}) => {
    const event = {
      at: new Date().toISOString(),
      kind,
      message: String(message || ""),
      stage: String(meta?.stage || "")
    };
    statusEvents.push(event);
    statusEvents.splice(0, Math.max(0, statusEvents.length - 100));
    process.stdout.write(`[TEACHER][${kind}] ${event.message}\n`);
  };

  const browser = new AttachedThinkerBrowser({
    sendStatus,
    chatUrl: THINKER_URL,
    rootDir: projectRoot,
    port: THINKER_PORT,
    profileDir: path.join(projectRoot, ".david-instances", "david", "edge-soul-profile"),
    sessionKey: "david-thinker-worker",
    sessionLabel: "DAVID THINKER"
  });

  const loop = new TeacherLoop({
    browser,
    sendStatus,
    confirmAction,
    config: {
      teacherChatUrl: THINKER_URL,
      repositoryRoot: projectRoot,
      maxTeacherRounds: Math.max(1, Math.min(Number(request.max_rounds || 8), 12)),
      autoApproveSafePowerShell:
        String(process.env.DAVID_AUTO_APPROVE_SAFE_POWERSHELL || "false") === "true"
    }
  });

  try {
    const loopResult = await loop.run(String(request.goal || ""));
    writeJsonAtomic(resultFile, {
      ok: Boolean(loopResult?.ok),
      status: loopResult?.status || "unknown",
      summary: loopResult?.summary || "DAVID Teacher finished without a summary.",
      round: loopResult?.round || null,
      job_id: loopResult?.job_id || null,
      journal_path: loopResult?.journal_path || null,
      status_events: statusEvents
    });
  } catch (error) {
    writeJsonAtomic(resultFile, {
      ok: false,
      status: "error",
      summary: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 12000),
      status_events: statusEvents
    });
    process.exitCode = 1;
  } finally {
    browser.connection?.close?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[FATAL]", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  AttachedThinkerBrowser,
  THINKER_PORT,
  THINKER_URL,
  confirmAction,
  normalizePrompt
};
