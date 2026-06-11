import { VertexAI } from '@google-cloud/vertexai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { RawNewsArticle } from './serpapi';

dotenv.config();

export interface CuratedHeadline {
  heading: string;
  description: string;
  source_link: string;
  image_url?: string | null;
}

export interface WishSection {
  wish_title: string;
  wish_content: string;
  image_url?: string | null;
}

export interface GeneratedNewsletter {
  editorial_title?: string;
  editorial_summary: string;
  wish?: WishSection | null;
  news_items: CuratedHeadline[];
}

let vertexAIInstance: VertexAI | null = null;

// Initialize Vertex AI
function getVertexAI(): VertexAI {
  if (vertexAIInstance) return vertexAIInstance;

  const configuredProjectId = process.env.GCP_PROJECT_ID || 'tenxds-agents-idp';
  const location = process.env.GCP_LOCATION || 'us-central1';
  let resolvedProjectId = configuredProjectId;

  // ── Option A: Credentials provided as a raw JSON string (Render / cloud env) ──
  const credentialsJson = process.env.GOOGLE_CREDENTIALS_JSON;
  if (credentialsJson) {
    try {
      const creds = JSON.parse(credentialsJson);
      if (creds.project_id) {
        resolvedProjectId = creds.project_id;
        console.log(`[Vertex AI] Using project ID from GOOGLE_CREDENTIALS_JSON: "${resolvedProjectId}"`);
      }
      // Write to a temp file so the GCP SDK can pick it up via GOOGLE_APPLICATION_CREDENTIALS
      const tmpPath = path.join(os.tmpdir(), 'gcp-credentials.json');
      fs.writeFileSync(tmpPath, credentialsJson, 'utf8');
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
      console.log(`[Vertex AI] Wrote credentials to temp file: ${tmpPath}`);
    } catch (err) {
      console.error('[Vertex AI] Failed to parse GOOGLE_CREDENTIALS_JSON:', err);
    }
  } else {
    // ── Option B: Credentials provided as a file path (local dev) ──
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialsPath) {
      const cleanPath = credentialsPath.replace(/^["']|["']$/g, '');
      if (fs.existsSync(cleanPath)) {
        try {
          const creds = JSON.parse(fs.readFileSync(cleanPath, 'utf8'));
          if (creds.project_id) {
            resolvedProjectId = creds.project_id;
            console.log(`[Vertex AI] Found project ID in credentials file: "${resolvedProjectId}"`);
          }
          process.env.GOOGLE_APPLICATION_CREDENTIALS = cleanPath;
        } catch (err) {
          console.error('[Vertex AI] Failed to read project ID from credentials file:', err);
        }
      } else {
        console.warn(`[Vertex AI] Credentials file not found at: ${cleanPath}. Running in default auth mode.`);
      }
    }
  }

  console.log(`[Vertex AI] Initializing client for project: "${resolvedProjectId}", location: "${location}"`);

  vertexAIInstance = new VertexAI({
    project: resolvedProjectId,
    location: location,
  });

  return vertexAIInstance;
}

export async function generateNewsletter(params: {
  sector: string;
  category: string;
  customCategory?: string;
  clientName?: string;
  newsCount?: number;
  newsData: RawNewsArticle[];
}): Promise<GeneratedNewsletter> {
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

    const parsedContent = JSON.parse(responseText.trim()) as GeneratedNewsletter;
    console.log("[Vertex AI] Successfully generated newsletter content.");
    return parsedContent;
  } catch (error: any) {
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
          const parsedContent = JSON.parse(responseText.trim()) as GeneratedNewsletter;
          console.log("[Vertex AI] Successfully generated newsletter content using fallback model.");
          return parsedContent;
        }
      } catch (fallbackError) {
        console.error("[Vertex AI] Fallback model also failed:", fallbackError);
      }
    }
    throw error;
  }
}

export async function generateNewsletterFromFile(params: {
  documentText: string;
  clientName?: string;
  newsCount?: number;
}): Promise<GeneratedNewsletter> {
  const { documentText, clientName, newsCount } = params;
  const targetCount = newsCount || 5;

  const clientText = clientName && clientName.trim() !== '' ? `specifically customized for ${clientName.trim()}` : '';

  // Get the initialized Vertex AI instance
  const vertexAI = getVertexAI();

  // Load the model
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log(`[Vertex AI] Using model: "${modelName}" for file generation (strict mode)`);
  
  const generativeModel = vertexAI.preview.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1, // very low to ensure exact extraction and copying
    }
  });

  const prompt = `
You are a strict text extraction and formatting engine.
Your task is to parse the raw text content of an uploaded document and extract its sections EXACTLY as written.
Do NOT rewrite, paraphrase, summarize, correct grammar, translate, or generate any new content. You must copy the text word-for-word.

Here is the raw text of the document:
---
${documentText}
---

INSTRUCTIONS:
1. Identify the first major section/topic (e.g. related to 'Simplifying Workforce Operations' or general business topics). Extract its exact text:
   - "editorial_title": The exact heading of this section (e.g. 'Simplifying Workforce Operations with a Unified Digital Platform').
   - "editorial_summary": The exact paragraphs under this section, copied word-for-word.
   
2. Identify the wish/greeting section (e.g. 'Eid Mubarak' or other festival/celebration wishes). Extract its exact text:
   - "wish": An object containing:
     - "wish_title": The exact heading of this section (e.g. 'Eid Mubarak from 10xDS!').
     - "wish_content": The exact paragraphs under this section, copied word-for-word.
   - If no wish/holiday greeting section is present, set "wish" to null.

3. Identify the subsequent sections which describe company solutions, products, or other bulletins (e.g. '10xMenu.AI' or other company solutions). For each of these sections:
   - "heading": The exact heading of the solution/product (e.g. '10xMenu.AI: Turn Your Menu into a Revenue Engine').
   - "description": The exact paragraphs under that heading, copied word-for-word.
   - "source_link": Provide an empty string ("").

Respond ONLY with a valid JSON object matching this structure:
{
  "editorial_title": "...",
  "editorial_summary": "...",
  "wish": {
    "wish_title": "...",
    "wish_content": "..."
  },
  "news_items": [
    {
      "heading": "...",
      "description": "...",
      "source_link": ""
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

    const parsedContent = JSON.parse(responseText.trim()) as GeneratedNewsletter;
    console.log("[Vertex AI] Successfully extracted newsletter content from document.");
    return parsedContent;
  } catch (error: any) {
    console.error("[Vertex AI] Failed to extract newsletter from file:", error);

    // Fallback: if gemini-2.5-flash is not available, retry with gemini-1.5-flash
    if (error.message && (error.message.includes('not found') || error.message.includes('permission') || error.message.includes('404'))) {
      const fallbackModelName = 'gemini-1.5-flash';
      console.log(`[Vertex AI] Attempting fallback to: "${fallbackModelName}"`);
      try {
        const fallbackModel = vertexAI.preview.getGenerativeModel({
          model: fallbackModelName,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          }
        });
        const result = await fallbackModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        const responseText = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          const parsedContent = JSON.parse(responseText.trim()) as GeneratedNewsletter;
          console.log("[Vertex AI] Successfully extracted newsletter content from document using fallback model.");
          return parsedContent;
        }
      } catch (fallbackError) {
        console.error("[Vertex AI] Fallback model also failed:", fallbackError);
      }
    }
    throw error;
  }
}

