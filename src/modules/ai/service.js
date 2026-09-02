const httpStatus = require("http-status");
const ApiError   = require("../../utils/ApiError");
const config     = require("../../config/config");

// ─── Tool declarations — kept authoritative on the backend, not the client ────
// Each one maps to a real action the frontend widget can execute using the
// logged-in user's own session (navigation, or an existing authenticated API
// call) — the backend never performs the action itself, it only decides,
// via Gemini, *which* action fits what the user asked for.
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "navigate",
        description: "Go to a page in the app.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: {
              type: "STRING",
              description: "One of: /dashboard, /processes, /templates, /builder, /users, /users/add, /settings, /activity-logs, /reports, /iris-reporting, /invoicing, /contracts, /company",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "filter_obligations",
        description: "Open the IRIS Reporting Obligations tab filtered to a specific status, optionally combined with a text search.",
        parameters: {
          type: "OBJECT",
          properties: {
            status: {
              type: "STRING",
              description: "One of: all, planned, in_progress, completed, blocked, overdue",
            },
            search: { type: "STRING", description: "Optional text to search obligation title/owner/legislation reference by." },
          },
          required: ["status"],
        },
      },
      {
        name: "generate_report",
        description: "Open the Report Pack tab with all obligations matching a filter pre-selected and the report preview already open.",
        parameters: {
          type: "OBJECT",
          properties: {
            filter: {
              type: "STRING",
              description: "One of: all, planned, in_progress, completed, blocked, overdue",
            },
          },
          required: ["filter"],
        },
      },
      {
        name: "add_team_member",
        description: "Invite a new team member. Only call this once you have their name and email — ask the user for anything missing before calling it. If they don't specify a role, default to 'editor'.",
        parameters: {
          type: "OBJECT",
          properties: {
            name:  { type: "STRING" },
            email: { type: "STRING" },
            role:  { type: "STRING", description: "One of: admin, editor, viewer" },
          },
          required: ["name", "email"],
        },
      },
      {
        name: "get_status_summary",
        description: "Fetch live counts (total/completed/in-progress/blocked/overdue obligations and the compliance score) to answer a status question. Use this instead of guessing numbers.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

const SYSTEM_INSTRUCTION = `You are the in-app assistant for Iris Monde Workspace, a company workflow and compliance-obligation tracking platform.

You can help with: navigating the app, filtering the Obligations list, generating a report from a set of obligations, inviting a new team member, and answering questions about current obligation/compliance status using live data.

Rules:
- You do not give legal, financial, or compliance advice — only summarize, draft, and automate actions the user explicitly asks for.
- Before calling add_team_member, make sure you have a name and email — ask a short follow-up question if either is missing. Do not invent an email address.
- Before calling get_status_summary, don't guess numbers — always call the tool and use its real result in your answer.
- Keep replies short and direct. This is a work tool, not a chat companion.`;

const chatWithAssistant = async ({ contents }) => {
  if (!config.ai.geminiApiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "AI assistant is not configured (GEMINI_API_KEY missing)");
  }
  if (!Array.isArray(contents) || !contents.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, "contents is required");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.geminiModel}:generateContent?key=${config.ai.geminiApiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        tools: TOOLS,
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      }),
    });
  } catch (err) {
    // Node's fetch collapses network-level failures (DNS, proxy, TLS,
    // timeout) into a generic "fetch failed" — the real reason lives on
    // err.cause. Surface that instead of the useless top-level message.
    const detail = err.cause?.message || err.cause?.code || err.message;
    console.error("[AI] Network error calling Gemini:", err);
    throw new ApiError(httpStatus.BAD_GATEWAY, `Could not reach the AI service: ${detail}`);
  }

  const data = await response.json();

  if (!response.ok) {
    console.error("[AI] Gemini API error:", JSON.stringify(data));
    throw new ApiError(httpStatus.BAD_GATEWAY, data?.error?.message || "AI request failed");
  }

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const text = parts.filter((p) => p.text).map((p) => p.text).join("\n").trim();
  const functionCall = parts.find((p) => p.functionCall)?.functionCall || null;

  return { text, functionCall };
};

module.exports = { chatWithAssistant };
