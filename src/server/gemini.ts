import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Server-only Google Gemini client.
 *
 * Per Section 9.1 of the problem statement, Google AI is an allowed external
 * provider. We never expose this module to the client bundle — it is imported
 * only from server actions and route handlers.
 */

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let cached: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (cached) return cached;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Set it in .env or your deployment environment."
    );
  }
  cached = new GoogleGenerativeAI(apiKey);
  return cached;
}

export function getGenerativeModel() {
  return getClient().getGenerativeModel({
    model: MODEL,
    generationConfig: {
      // We require strict JSON output so the parser layer is deterministic.
      responseMimeType: "application/json",
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 1024,
    },
  });
}

export const GEMINI_MODEL_NAME = MODEL;