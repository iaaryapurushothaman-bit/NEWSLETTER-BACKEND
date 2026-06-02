"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNewsletter = generateNewsletter;
const vertexai_1 = require("@google-cloud/vertexai");
const fs_1 = __importDefault(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
let vertexAIInstance = null;
// Initialize Vertex AI
function getVertexAI() {
    if (vertexAIInstance)
        return vertexAIInstance;
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const configuredProjectId = process.env.GCP_PROJECT_ID || 'tenxds-agents-idp';
    const location = process.env.GCP_LOCATION || 'us-central1';
    let resolvedProjectId = configuredProjectId;
    if (credentialsPath) {
        const cleanPath = credentialsPath.replace(/^["']|["']$/g, ''); // strip outer quotes
        if (fs_1.default.existsSync(cleanPath)) {
            try {
                const creds = JSON.parse(fs_1.default.readFileSync(cleanPath, 'utf8'));
                if (creds.project_id) {
                    resolvedProjectId = creds.project_id;
                    console.log(`[Vertex AI] Found project ID in credentials file: "${resolvedProjectId}"`);
                }
                // Force the environment variable to contain the clean path for the GCP SDK
                process.env.GOOGLE_APPLICATION_CREDENTIALS = cleanPath;
            }
            catch (err) {
                console.error("[Vertex AI] Failed to read project ID from credentials file, falling back to env:", err);
            }
        }
        else {
            console.warn(`[Vertex AI] Credentials file not found at: ${cleanPath}. Running in default authentication mode.`);
        }
    }
    console.log(`[Vertex AI] Initializing client for project: "${resolvedProjectId}", location: "${location}"`);
    // Initialize the Vertex AI client
    vertexAIInstance = new vertexai_1.VertexAI({
        project: resolvedProjectId,
        location: location,
    });
    return vertexAIInstance;
}
async function generateNewsletter(params) {
    const { sector, category, customCategory, clientName, newsData, newsCount } = params;
    const targetCount = newsCount || newsData.length;
    if (!newsData || newsData.length === 0) {
        return {
            editorial_summary: `Currently, no breaking news is reported in the ${sector} sector. We will keep monitoring for updates.`,
            news_items: []
        };
    }
    const categoryLabel = customCategory && customCategory.trim() !== '' ? customCategory.trim() : category;
    const clientText = clientName && clientName.trim() !== '' ? `specifically customized for ${clientName.trim()}` : '';
    // Get the initialized Vertex AI instance
    const vertexAI = getVertexAI();
    // Load the model
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    console.log(`[Vertex AI] Using model: "${modelName}"`);
    const generativeModel = vertexAI.preview.getGenerativeModel({
        model: modelName,
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
        }
    });
    const prompt = `
You are a highly skilled and professional chief editorial newsletter writer.
Write a premium, professional business intelligence newsletter based on the following input variables and raw news articles:

---
INPUT VARIABLES:
- Sector/Industry: "${sector}"
- Category of newsletter: "${categoryLabel}"
- Target Client: "${clientName || 'General Audience'}" ${clientText}
---

RAW NEWS ARTICLES:
${JSON.stringify(newsData, null, 2)}

---
INSTRUCTIONS:
1. Write a professional, highly engaging and insightful "editorial_summary" (1-2 paragraphs).
   - This should act as the opening column of the newsletter, analyzing recent trends in the "${sector}" sector.
   - Ground the analysis on the raw news articles provided.
   - Write in a highly sophisticated corporate tone, highlighting strategic implications.
   - If a client name ("${clientName}") is specified, tailor the insights to help them understand how these developments impact their strategic interest.

2. Create a list of "news_items" with EXACTLY ${targetCount} item(s). Do not produce more or fewer. For each article:
   - "heading": Write a punchy, highly readable business headline summarizing the article's core news.
   - "description": Write a concise, 2-line AI summary based on the raw snippet, explaining the strategic significance of the story.
   - "source_link": Provide the EXACT matching source URL from the raw articles. Do not invent or change links.

Respond ONLY with a valid JSON object matching this structure:
{
  "editorial_summary": "Sophisticated analysis...",
  "news_items": [
    {
      "heading": "Business-styled Headline",
      "description": "2-line professional summary of the story's implications...",
      "source_link": "https://..."
    }
  ]
}
`;
    try {
        const result = await generativeModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            throw new Error("Empty response returned from Gemini Vertex AI model.");
        }
        const parsedContent = JSON.parse(responseText.trim());
        console.log("[Vertex AI] Successfully generated newsletter content.");
        return parsedContent;
    }
    catch (error) {
        console.error("[Vertex AI] Failed to generate newsletter:", error);
        // Fallback: if gemini-2.5-flash is not available, we can retry with gemini-1.5-flash
        if (error.message && (error.message.includes('not found') || error.message.includes('permission') || error.message.includes('404'))) {
            const fallbackModelName = 'gemini-1.5-flash';
            console.log(`[Vertex AI] Attempting fallback to: "${fallbackModelName}"`);
            try {
                const fallbackModel = vertexAI.preview.getGenerativeModel({
                    model: fallbackModelName,
                    generationConfig: {
                        responseMimeType: 'application/json',
                        temperature: 0.4,
                    }
                });
                const result = await fallbackModel.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                });
                const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (responseText) {
                    const parsedContent = JSON.parse(responseText.trim());
                    console.log("[Vertex AI] Successfully generated newsletter content using fallback model.");
                    return parsedContent;
                }
            }
            catch (fallbackError) {
                console.error("[Vertex AI] Fallback model also failed:", fallbackError);
            }
        }
        throw error;
    }
}
