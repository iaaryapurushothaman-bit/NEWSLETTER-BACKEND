import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let genAIInstance: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI {
  if (genAIInstance) return genAIInstance;

  const project = process.env.GCP_PROJECT_ID || 'tenxds-agents-idp';
  const location = process.env.GCP_LOCATION || 'us-central1';

  console.log(`[ImageGen] Initializing Gemini Image Gen for project: "${project}", location: "${location}"`);

  genAIInstance = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });

  return genAIInstance;
}

/**
 * Generates a single editorial-style news image for a given headline and description.
 * Returns a base64 data URL string, or null on failure.
 */
export async function generateNewsImage(
  heading: string,
  description: string
): Promise<string | null> {
  try {
    const ai = getGenAI();

    const prompt = `Create a professional, photorealistic editorial news illustration for a business intelligence newsletter.
Topic: "${heading}"
Context: ${description}
Style requirements:
- Modern editorial photography or 3D render aesthetic
- Clean, bold composition suitable for a news card
- No text, watermarks, or overlays in the image
- Professional, corporate feel
- High contrast and vibrant colors appropriate to the topic
- Aspect ratio: landscape (16:9 or 4:3)`;

    // Using the requested Gemini 2.5 image flash model
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['IMAGE'],
      } as any,
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) {
      console.warn(`[ImageGen] No image parts in response for: "${heading}"`);
      return null;
    }

    for (const part of candidate.content.parts) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || 'image/png';
        console.log(`[ImageGen] Successfully generated image for: "${heading}"`);
        return `data:${mimeType};base64,${part.inlineData.data}`;
      }
    }

    console.warn(`[ImageGen] No inline image data found for: "${heading}"`);
    return null;
  } catch (error: any) {
    console.error(`[ImageGen] Failed to generate image for "${heading}":`, error?.message || error);
    return null;
  }
}

/**
 * Generates images for all news items sequentially to prevent Rate Limit / Quota Exceeded (429) errors.
 * Items that fail get null (graceful degradation).
 */
export async function generateNewsImages(
  newsItems: Array<{ heading: string; description: string }>
): Promise<Array<string | null>> {
  console.log(`[ImageGen] Generating images sequentially for ${newsItems.length} news items...`);
  
  const results: Array<string | null> = [];
  
  for (const item of newsItems) {
    const img = await generateNewsImage(item.heading, item.description);
    results.push(img);
    // Add a short 1.5-second delay between requests to respect Vertex AI quotas
    if (newsItems.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  const successCount = results.filter(Boolean).length;
  console.log(`[ImageGen] Image generation complete: ${successCount}/${newsItems.length} succeeded.`);
  return results;
}
