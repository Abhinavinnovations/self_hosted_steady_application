import { createGateway } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * Voice/assistant model. Self-hosted default: your own Gemini API key from Google AI Studio
 * (GEMINI_API_KEY). If AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY are set instead, the original
 * AI-gateway path is used unchanged.
 */
const gemini = process.env.GEMINI_API_KEY?.trim()
  ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY.trim() })
  : null;
const gateway = createGateway({
  baseURL: process.env.AI_GATEWAY_BASE_URL,
  apiKey: process.env.AI_GATEWAY_API_KEY,
});

export function assistantModel() {
  if (gemini) return gemini(process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview");
  return gateway("google/gemini-3-flash");
}
