"use strict";

const canvas = document.querySelector("#trail");
const context = canvas.getContext("2d", {
  alpha: true,
  desynchronized: true
});

const statusElement = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const commandPanel = document.querySelector("#commandPanel");
const commandForm = document.querySelector("#commandForm");
const commandInput = document.querySelector("#commandInput");
const modeText = document.querySelector("#modeText");

const pointer = {
  x: window.innerWidth * 0.5,
  y: window.innerHeight * 0.5
};

const previousPointer = {
  x: pointer.x,
  y: pointer.y
};

// По-къса и бърза следа: главата е 1:1 върху курсора.
const parameters = {
  pointsNumber: 22,
  headWidth: 11.5,
  minimumWidth: 0.7,
  followStart: 0.74,
  followFalloff: 0.012
};

const trail = Array.from(
  { length: parameters.pointsNumber },
  () => ({
    x: pointer.x,
    y: pointer.y
  })
);

let pointerActive = true;
let receivedFirstPointer = false;
const defaultCommandPlaceholder =
  "Кажи какво да направя...";

let activeInputMode = null;
let statusTimer = null;
let animationFrame = null;
let lastFrameTime = performance.now();

function resetTrail(x = pointer.x, y = pointer.y) {
  for (const point of trail) {
    point.x = x;
    point.y = y;
  }
}

function setupCanvas() {
  const ratio = Math.max(
    1,
    Math.min(window.devicePixelRatio || 1, 2)
  );

  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (!receivedFirstPointer) {
    pointer.x = width * 0.5;
    pointer.y = height * 0.5;
    resetTrail();
  }
}

function updateTrail(frameTime) {
  animationFrame = window.requestAnimationFrame(updateTrail);

  if (!pointerActive) {
    context.clearRect(
      0,
      0,
      window.innerWidth,
      window.innerHeight
    );
    return;
  }

  const elapsed = Math.min(
    2,
    Math.max(0.5, (frameTime - lastFrameTime) / 16.667)
  );

  lastFrameTime = frameTime;

  context.clearRect(
    0,
    0,
    window.innerWidth,
    window.innerHeight
  );

  // Главата никога не използва smoothing.
  trail[0].x = pointer.x;
  trail[0].y = pointer.y;

  for (let index = 1; index < trail.length; index += 1) {
    const point = trail[index];
    const previous = trail[index - 1];

    const follow = Math.max(
      0.43,
      parameters.followStart -
      index * parameters.followFalloff
    );

    const frameFollow = 1 - Math.pow(1 - follow, elapsed);

    point.x += (previous.x - point.x) * frameFollow;
    point.y += (previous.y - point.y) * frameFollow;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(12, 12, 16, 0.94)";
  context.shadowColor = "rgba(255, 255, 255, 0.30)";
  context.shadowBlur = 1.8;

  context.beginPath();
  context.moveTo(trail[0].x, trail[0].y);

  for (let index = 1; index < trail.length - 1; index += 1) {
    const centerX =
      0.5 * (trail[index].x + trail[index + 1].x);

    const centerY =
      0.5 * (trail[index].y + trail[index + 1].y);

    context.quadraticCurveTo(
      trail[index].x,
      trail[index].y,
      centerX,
      centerY
    );

    const progress = index / (trail.length - 1);

    context.lineWidth =
      parameters.minimumWidth +
      parameters.headWidth * (1 - progress);

    context.stroke();
  }

  context.lineTo(
    trail[trail.length - 1].x,
    trail[trail.length - 1].y
  );

  context.lineWidth = parameters.minimumWidth;
  context.stroke();
  context.restore();

  previousPointer.x = pointer.x;
  previousPointer.y = pointer.y;
}

function showStatus(message, kind = "info") {
  statusText.textContent = message;
  statusElement.dataset.kind = kind;
  statusElement.classList.remove("status--hidden");

  clearTimeout(statusTimer);

  const persistent = [
    "working",
    "training",
    "error"
  ].includes(kind);

  statusTimer = setTimeout(
    () => statusElement.classList.add("status--hidden"),
    persistent ? 8500 : 3500
  );
}

window.david.onPointer((position) => {
  const x = Number(position.x);
  const y = Number(position.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  pointer.x = x;
  pointer.y = y;

  if (!receivedFirstPointer) {
    receivedFirstPointer = true;
    resetTrail(x, y);
  }
});

window.david.onPointerActive(({ active }) => {
  pointerActive = Boolean(active);
  canvas.dataset.active = String(pointerActive);

  if (pointerActive) {
    resetTrail(pointer.x, pointer.y);
  }
});

window.david.onDisplay(() => {
  setupCanvas();
});

window.david.onStatus(({ message, kind }) => {
  showStatus(message, kind);
});

window.david.onRequestInput(({
  mode,
  prompt,
  placeholder
}) => {
  activeInputMode = mode || null;

  commandInput.value = "";
  commandInput.placeholder =
    placeholder || defaultCommandPlaceholder;

  showStatus(
    prompt || "Какво да изпратя?",
    "working"
  );

  commandPanel.classList.remove(
    "command-panel--hidden"
  );

  setTimeout(() => {
    commandInput.focus();
  }, 40);
});
window.david.onCommandPanel(({ open }) => {
  commandPanel.classList.toggle(
    "command-panel--hidden",
    !open
  );

  if (open) {
    setTimeout(() => commandInput.focus(), 40);
  } else {
    activeInputMode = null;
    commandInput.placeholder =
      defaultCommandPlaceholder;
    commandInput.blur();
  }
});

commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const command = commandInput.value.trim();
  if (!command) return;

  commandInput.value = "";

  showStatus(
    activeInputMode === "chatgpt_message"
      ? "Изпращам към GPT..."
      : "DAVID обработва командата...",
    "working"
  );

  const result =
    await window.david.submitCommand(command);

  if (result.awaitingInput) {
    activeInputMode =
      result.inputMode || "chatgpt_message";

    return;
  }

  activeInputMode = null;
  commandInput.placeholder =
    defaultCommandPlaceholder;

  if (!result.ok) {
    showStatus(
      result.message ||
      "Командата не беше изпълнена.",
      "error"
    );
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.david.hideCommandPanel();
  }
});

window.addEventListener("resize", setupCanvas);

window.addEventListener("beforeunload", () => {
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame);
  }
});

window.david.getInfo().then((info) => {
  const mode =
    info.mode === "supabase-teacher"
      ? "Supabase + GPT Teacher"
      : "Local demo teacher";

  modeText.textContent =
    `${mode} · Overlay ${info.overlayVersion || "v1"} · ` +
    `Native actions: ${info.nativeActionsEnabled ? "ON" : "OFF"}`;
});

setupCanvas();
animationFrame = window.requestAnimationFrame(updateTrail);


