import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

async function testImageGen() {
  const project = process.env.GCP_PROJECT_ID || 'tenxds-agents-idp';
  const location = process.env.GCP_LOCATION || 'us-central1';

  console.log(`Testing Gemini Image Gen for project: "${project}", location: "${location}"`);

  const ai = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts: [{ text: "A cute dog" }] }],
      config: {
        responseModalities: ['IMAGE'],
      } as any,
    });
    console.log("Success!", response.candidates?.[0]?.content?.parts?.[0]?.inlineData ? "Has image data" : "No image data");
  } catch (err: any) {
    console.error("Failed with gemini-2.5-flash-image:", err.message);
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: "A cute dog" }] }],
      config: {
        responseModalities: ['IMAGE'],
      } as any,
    });
    console.log("Success with gemini-2.5-flash!", response.candidates?.[0]?.content?.parts?.[0]?.inlineData ? "Has image data" : "No image data");
  } catch (err: any) {
    console.error("Failed with gemini-2.5-flash:", err.message);
  }
}

testImageGen();
