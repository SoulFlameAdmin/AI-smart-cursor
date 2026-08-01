import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const allowedActions = new Set([
  "open_url",
  "open_app",
  "wait",
  "browser_open",
  "browser_wait_selector",
  "browser_click_selector",
  "browser_click_text",
  "browser_type_selector",
  "browser_press_key",
  "verify_url_contains",
  "system_click",
  "system_type",
  "notify"
]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function extractOutputText(response: any): string {
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  if (typeof response?.output_text === "string") return response.output_text;
  throw new Error("OpenAI не върна output_text.");
}

function validateAndSanitizeSkill(skill: any) {
  if (!skill || typeof skill !== "object") {
    throw new Error("Моделът върна невалиден skill.");
  }

  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(skill.skill_key || "")) {
    throw new Error("Невалиден skill_key.");
  }

  if (!["low", "medium", "high"].includes(skill.risk_level)) {
    throw new Error("Невалидно risk_level.");
  }

  if (
    !skill.matcher ||
    skill.matcher.type !== "regex" ||
    typeof skill.matcher.pattern !== "string" ||
    skill.matcher.pattern.length > 500
  ) {
    throw new Error("Невалиден matcher.");
  }

  new RegExp(skill.matcher.pattern, skill.matcher.flags || "iu");

  if (!Array.isArray(skill.steps) || skill.steps.length < 1 || skill.steps.length > 30) {
    throw new Error("Невалиден брой стъпки.");
  }

  for (const step of skill.steps) {
    if (!allowedActions.has(step.action)) {
      throw new Error(`Неразрешено действие: ${step.action}`);
    }

    for (const key of ["url"]) {
      const value = step[key];
      if (
        typeof value === "string" &&
        !value.startsWith("https://") &&
        !value.startsWith("http://")
      ) {
        throw new Error(`Неразрешен URL в ${key}.`);
      }
    }
  }

  return {
    skill_key: skill.skill_key,
    title: String(skill.title || skill.skill_key).slice(0, 160),
    description: String(skill.description || "").slice(0, 1000),
    risk_level: skill.risk_level,
    matcher: {
      type: "regex",
      pattern: skill.matcher.pattern,
      flags: skill.matcher.flags || "iu",
      variables: Array.isArray(skill.matcher.variables)
        ? skill.matcher.variables.slice(0, 12)
        : []
    },
    steps: skill.steps.map((step: any) => ({
      action: step.action,
      url: step.url ?? null,
      app: step.app ?? null,
      selector: step.selector ?? null,
      text: step.text ?? null,
      title: step.title ?? null,
      milliseconds: step.milliseconds ?? null,
      timeout_ms: step.timeout_ms ?? null,
      value: step.value ?? null,
      key: step.key ?? null,
      x: step.x ?? null,
      y: step.y ?? null,
      allow_fail: Boolean(step.allow_fail)
    }))
  };
}

const skillSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    skill_key: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high"]
    },
    matcher: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["regex"] },
        pattern: { type: "string" },
        flags: { type: "string" },
        variables: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["type", "pattern", "flags", "variables"]
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: [...allowedActions]
          },
          url: { type: ["string", "null"] },
          app: { type: ["string", "null"] },
          selector: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          milliseconds: { type: ["integer", "null"] },
          timeout_ms: { type: ["integer", "null"] },
          value: { type: ["string", "null"] },
          key: { type: ["string", "null"] },
          x: { type: ["integer", "null"] },
          y: { type: ["integer", "null"] },
          allow_fail: { type: "boolean" }
        },
        required: [
          "action",
          "url",
          "app",
          "selector",
          "text",
          "title",
          "milliseconds",
          "timeout_ms",
          "value",
          "key",
          "x",
          "y",
          "allow_fail"
        ]
      }
    }
  },
  required: [
    "skill_key",
    "title",
    "description",
    "risk_level",
    "matcher",
    "steps"
  ]
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Missing Authorization" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceRole =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SECRET_KEY");
    const openAiKey = Deno.env.get("OPENAI_API_KEY");
    const model = Deno.env.get("OPENAI_MODEL") || "gpt-5-mini";

    if (!anonKey || !serviceRole || !openAiKey) {
      throw new Error(
        "Липсват SUPABASE_ANON_KEY/PUBLISHABLE_KEY, SERVICE_ROLE/SECRET_KEY или OPENAI_API_KEY."
      );
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: { Authorization: authorization }
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const {
      data: { user },
      error: userError
    } = await userClient.auth.getUser();

    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const body = await request.json();
    const requestId = String(body.request_id || "");

    const requestRow = await admin
      .from("training_requests")
      .select("*")
      .eq("id", requestId)
      .eq("owner_id", user.id)
      .single();

    if (requestRow.error) throw requestRow.error;

    await admin
      .from("training_requests")
      .update({ status: "planning", updated_at: new Date().toISOString() })
      .eq("id", requestId);

    const systemPrompt = `
Ти си DAVID Teacher. Превръщаш команда на потребител в малък, повторно използваем и безопасен desktop/browser skill.

Разрешени действия:
- open_url: отвори външен http/https адрес.
- open_app: стартирай приложение само по безопасно име, без shell аргументи.
- wait: изчакай milliseconds.
- browser_open: отвори адрес в защитен DAVID Browser.
- browser_wait_selector: изчакай CSS selector.
- browser_click_selector: кликни CSS selector.
- browser_click_text: кликни бутон по точен видим текст.
- browser_type_selector: напиши текст в CSS selector.
- browser_press_key: натисни клавиш.
- verify_url_contains: провери дали URL съдържа value.
- system_click/system_type: само когато браузърните действия не стигат; маркирай risk_level medium/high.
- notify: покажи известие.

Строги правила:
1. Никога не създавай shell, PowerShell, JavaScript, eval, download-and-run или файлово изтриване.
2. Никога не автоматизирай плащане, парола, 2FA, банкова операция, публикуване или изпращане без отделно потвърждение.
3. Предпочитай browser selectors пред screen coordinates.
4. Matcher-ът трябва да е общ regex, за да работи със следващи сходни команди.
5. Capturing групите в regex се записват по ред в matcher.variables.
6. За URL-encoded променлива използвай {{url:variable}}. За обикновен текст използвай {{variable}}.
7. Опционалните popup стъпки имат allow_fail=true.
8. Skill-ът трябва да има проверка на успеха, когато това е възможно.
9. Не добавяй markdown. Върни само JSON по схемата.
`.trim();

    const input = {
      command: requestRow.data.command_text,
      runtime_context: requestRow.data.context,
      previous_skill: body.previous_skill || null,
      last_run: body.last_run || null
    };

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions: systemPrompt,
        input: JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name: "david_skill",
            strict: true,
            schema: skillSchema
          }
        }
      })
    });

    const openAiData = await openAiResponse.json();

    if (!openAiResponse.ok) {
      throw new Error(
        openAiData?.error?.message || `OpenAI HTTP ${openAiResponse.status}`
      );
    }

    const rawSkill = JSON.parse(extractOutputText(openAiData));
    const skill = validateAndSanitizeSkill(rawSkill);

    const skillRow = await admin
      .from("skills")
      .upsert(
        {
          owner_id: user.id,
          skill_key: skill.skill_key,
          title: skill.title,
          description: skill.description,
          updated_at: new Date().toISOString()
        },
        { onConflict: "owner_id,skill_key" }
      )
      .select("id")
      .single();

    if (skillRow.error) throw skillRow.error;

    const previousVersion = await admin
      .from("skill_versions")
      .select("version")
      .eq("skill_id", skillRow.data.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (previousVersion.error) throw previousVersion.error;

    const version = Number(previousVersion.data?.version || 0) + 1;
    const definition = { ...skill, version, status: "candidate" };

    const versionRow = await admin
      .from("skill_versions")
      .insert({
        owner_id: user.id,
        skill_id: skillRow.data.id,
        version,
        status: "candidate",
        risk_level: skill.risk_level,
        definition,
        teacher_model: model
      })
      .select("id")
      .single();

    if (versionRow.error) throw versionRow.error;

    const jobRow = await admin
      .from("training_jobs")
      .insert({
        owner_id: user.id,
        device_id: requestRow.data.device_id,
        request_id: requestId,
        skill_version_id: versionRow.data.id,
        command_text: requestRow.data.command_text,
        status: "running",
        started_at: new Date().toISOString()
      })
      .select("id")
      .single();

    if (jobRow.error) throw jobRow.error;

    await admin
      .from("training_requests")
      .update({ status: "planned", updated_at: new Date().toISOString() })
      .eq("id", requestId);

    return json({
      request_id: requestId,
      job_id: jobRow.data.id,
      skill_version_id: versionRow.data.id,
      version,
      status: "candidate",
      skill: definition
    });
  } catch (error) {
    console.error(error);
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
});
