import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Resend } from 'resend';
import mammoth from 'mammoth';
import { fetchNews } from './services/serpapi';
import { generateNewsletter, generateNewsletterFromFile } from './services/vertexai';
import { generateNewsImages, generateNewsImage } from './services/imagegeneration';

dotenv.config();

const PERSISTENT_FILE_PATH = path.join(__dirname, '..', 'latest_newsletter.json');

const saveNewsletterState = async (inputs: any, result: any) => {
  try {
    const data = JSON.stringify({ inputs, result }, null, 2);
    await fs.promises.writeFile(PERSISTENT_FILE_PATH, data, 'utf8');
    console.log(`[API] Saved latest newsletter state to ${PERSISTENT_FILE_PATH}`);
  } catch (error) {
    console.error("[API Error] Failed to save newsletter state:", error);
  }
};

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for all origins in development
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Basic health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date() });
});
// Main generate newsletter API endpoint
app.post('/api/generate-newsletter', async (req: Request, res: Response) => {
  const {
    sector,
    category,
    custom_category,
    customCategory,
    client_name,
    clientName,
    clientLogo,
    news_count,
    newsCount
  } = req.body;

  // Casing-agnostic parameter handling
  const finalSector = sector || '';
  const finalCategory = category || '';
  const finalCustomCategory = customCategory || custom_category || '';
  const finalClientName = clientName || client_name || '';
  const finalNewsCount = parseInt(newsCount || news_count || '5', 10);

  if (!finalSector) {
    return res.status(400).json({ error: "Sector is a required field." });
  }

  try {
    console.log(`[API] Received generation request for Client: "${finalClientName}", Sector: "${finalSector}", Category: "${finalCategory}"`);

    // Step 1: Fetch Google news via SerpAPI
    const rawNews = await fetchNews({
      sector: finalSector,
      category: finalCategory,
      customCategory: finalCustomCategory,
      clientName: finalClientName,
      newsCount: finalNewsCount
    });

    if (!rawNews || rawNews.length === 0) {
      return res.status(200).json({
        editorial_summary: `No live breaking news was found for the sector "${finalSector}" under category "${finalCustomCategory || finalCategory}". Try adjusting the sector name or category fields in your configuration.`,
        news_items: []
      });
    }

    // Enforce the user-specified count — only pass exactly that many articles
    const limitedNews = rawNews.slice(0, finalNewsCount);

    // Step 2: Orchestrate Vertex AI to generate editorial analysis & headlines
    const newsletterContent = await generateNewsletter({
      sector: finalSector,
      category: finalCategory,
      customCategory: finalCustomCategory,
      clientName: finalClientName,
      newsCount: finalNewsCount,
      newsData: limitedNews
    });

    // Step 3: Generate images in parallel/sequentially for each news item
    console.log(`[API] Generating ${newsletterContent.news_items.length} news images...`);
    const images = await generateNewsImages(
      newsletterContent.news_items.map(item => ({
        heading: item.heading,
        description: item.description
      }))
    );

    // Step 4: Generate a hero image for the editorial summary
    console.log(`[API] Generating hero image for editorial summary...`);
    const editorialImage = await generateNewsImage(
      `${finalSector} Industry Overview`, 
      newsletterContent.editorial_summary.substring(0, 500)
    );

    // Attach generated images to news items
    const enrichedItems = newsletterContent.news_items.map((item, i) => ({
      ...item,
      image_url: images[i] || null
    }));

    const resultPayload = {
      ...newsletterContent,
      editorial_image_url: editorialImage,
      news_items: enrichedItems
    };

    // Save the generated state to disk
    await saveNewsletterState({
      sector: finalSector,
      category: finalCategory,
      customCategory: finalCustomCategory,
      clientName: finalClientName,
      clientLogo: clientLogo || null,
      newsCount: finalNewsCount
    }, resultPayload);

    res.json(resultPayload);
  } catch (error: any) {
    console.error("[API Error] Failed to generate newsletter:", error);
    res.status(500).json({
      error: error.message || "An error occurred during newsletter generation. Please verify your API keys and credentials setup."
    });
  }
});

// Generate newsletter based on uploaded Word document content
app.post('/api/generate-from-file', async (req: Request, res: Response) => {
  const {
    fileBuffer, // base64 string
    clientName,
    clientLogo,
    newsCount
  } = req.body;

  const finalClientName = clientName || '';
  const finalNewsCount = parseInt(newsCount || '5', 10);

  if (!fileBuffer) {
    return res.status(400).json({ error: "No file content was provided." });
  }

  try {
    console.log(`[API] Received generation-from-file request for Client: "${finalClientName}"`);

    // Decode base64 buffer
    const buffer = Buffer.from(fileBuffer, 'base64');

    // Parse DOCX to text using mammoth
    console.log(`[API] Parsing DOCX buffer...`);
    const mammothResult = await mammoth.extractRawText({ buffer });
    const documentText = mammothResult.value;
    
    if (!documentText || documentText.trim().length === 0) {
      return res.status(400).json({ error: "Could not extract any text from the provided document. Make sure it is a valid, non-empty Word document." });
    }

    console.log(`[API] Extracted text length: ${documentText.length} characters.`);

    // Orchestrate Vertex AI to generate newsletter based on document text
    console.log(`[API] Generating newsletter content from file text...`);
    const newsletterContent = await generateNewsletterFromFile({
      documentText,
      clientName: finalClientName,
      newsCount: finalNewsCount
    });

    // Generate images in parallel/sequentially for each news item
    console.log(`[API] Generating ${newsletterContent.news_items.length} news images...`);
    const images = await generateNewsImages(
      newsletterContent.news_items.map(item => ({
        heading: item.heading,
        description: item.description
      }))
    );

    // Generate a hero image for the editorial summary
    console.log(`[API] Generating hero image for editorial summary...`);
    const editorialImage = await generateNewsImage(
      newsletterContent.editorial_title || `Overview: ${finalClientName || 'Industry Trends'}`,
      newsletterContent.editorial_summary.substring(0, 500)
    );

    // Generate an image for the wish section if it exists
    let wishImage = null;
    if (newsletterContent.wish && newsletterContent.wish.wish_title) {
      console.log(`[API] Generating image for wish section: "${newsletterContent.wish.wish_title}"...`);
      wishImage = await generateNewsImage(
        newsletterContent.wish.wish_title,
        newsletterContent.wish.wish_content.substring(0, 500)
      );
      // Wait for a short delay to respect Vertex AI quotas
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Attach generated images to news items
    const enrichedItems = newsletterContent.news_items.map((item, i) => ({
      ...item,
      image_url: images[i] || null
    }));

    const resultPayload = {
      ...newsletterContent,
      editorial_image_url: editorialImage,
      wish: newsletterContent.wish ? {
        ...newsletterContent.wish,
        image_url: wishImage
      } : null,
      news_items: enrichedItems
    };

    // Save the generated state to disk
    await saveNewsletterState({
      sector: '10xDS CURVE',
      category: '10xDS CURVE',
      customCategory: '',
      clientName: finalClientName,
      clientLogo: clientLogo || null,
      newsCount: finalNewsCount
    }, resultPayload);

    res.json(resultPayload);
  } catch (error: any) {
    console.error("[API Error] Failed to generate newsletter from file:", error);
    res.status(500).json({
      error: error.message || "An error occurred during newsletter generation from the uploaded file. Please verify credentials."
    });
  }
});

// Regenerate single image using Gemini
app.post('/api/regenerate-image', async (req: Request, res: Response) => {
  const { heading, description } = req.body;
  if (!heading) {
    return res.status(400).json({ error: "Heading is required to generate an image." });
  }
  try {
    console.log(`[API] Regenerating image for heading: "${heading}"...`);
    const imageUrl = await generateNewsImage(heading, description || '');
    if (!imageUrl) {
      return res.status(500).json({ error: "Failed to generate image." });
    }
    res.json({ image_url: imageUrl });
  } catch (error: any) {
    console.error("[API Error] Failed to regenerate image:", error);
    res.status(500).json({ error: error.message || "An error occurred while generating the image." });
  }
});

// Get latest persistent newsletter
app.get('/api/latest-newsletter', async (req: Request, res: Response) => {
  try {
    if (fs.existsSync(PERSISTENT_FILE_PATH)) {
      const dataStr = await fs.promises.readFile(PERSISTENT_FILE_PATH, 'utf8');
      const data = JSON.parse(dataStr);
      return res.json(data);
    }
    return res.json({ inputs: null, result: null });
  } catch (error) {
    console.error("[API Error] Failed to read latest newsletter:", error);
    return res.status(500).json({ error: "Failed to load persistent newsletter state." });
  }
});

// Save current edited newsletter draft
app.post('/api/save-newsletter', async (req: Request, res: Response) => {
  const { inputs, result } = req.body;
  if (!inputs || !result) {
    return res.status(400).json({ error: "Inputs and result are required fields." });
  }
  try {
    await saveNewsletterState(inputs, result);
    return res.json({ success: true });
  } catch (error) {
    console.error("[API Error] Failed to save newsletter edits:", error);
    return res.status(500).json({ error: "Failed to persist newsletter state." });
  }
});

// Send newsletter via Gmail (or fallback to local HTML file for demo mode)
app.post('/api/send-email', async (req: Request, res: Response) => {
  const { recipientEmail, subject, htmlContent } = req.body;

  if (!recipientEmail || !htmlContent) {
    return res.status(400).json({ error: 'recipientEmail and htmlContent are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientEmail)) {
    return res.status(400).json({ error: 'Invalid email address format.' });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const isMockMode = !smtpUser || !smtpPass;

  // === MOCK MODE: Save HTML locally (great for demo/presentation) ===
  if (isMockMode) {
    try {
      const sentDir = path.join(__dirname, '..', 'sent_emails');
      if (!fs.existsSync(sentDir)) {
        await fs.promises.mkdir(sentDir, { recursive: true });
      }
      const safeEmail = recipientEmail.replace(/[@.]/g, '_');
      const timestamp = Date.now();
      const filename = `email_${safeEmail}_${timestamp}.html`;
      const fullEmailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>10xNewsPulse.AI - Newsletter Briefing</title>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; background: #f1f5f9; padding: 32px; }
    .meta { max-width: 600px; margin: 0 auto 16px auto; background: #1e293b; color: #94a3b8; font-size: 12px; padding: 12px 20px; border-radius: 8px; }
    .meta b { color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="meta">
    <b>10xNewsPulse.AI Mock Email</b><br>
    <b>To:</b> ${recipientEmail}<br>
    <b>Subject:</b> ${subject || 'Your Curated Industry Briefing'}<br>
    <b>Sent at:</b> ${new Date().toLocaleString()}
  </div>
  ${htmlContent}
</body>
</html>`;
      await fs.promises.writeFile(path.join(sentDir, filename), fullEmailHtml, 'utf8');
      console.log(`[API] [MOCK EMAIL] Saved to sent_emails/${filename}`);
      return res.json({
        success: true,
        mock: true,
        message: `Mock delivery successful! Preview saved: sent_emails/${filename}`,
        filename
      });
    } catch (err: any) {
      console.error('[API Error] Mock email save failed:', err);
      return res.status(500).json({ error: 'Failed to save mock email file.' });
    }
  }

  // === LIVE MODE: Send via Resend HTTP API ===
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY environment variable is not set. Please add it to your Render Environment.");
    }

    const resend = new Resend(resendApiKey);

    // Note: If you don't have a verified custom domain on Resend, 
    // the 'from' address MUST be onboarding@resend.dev
    const { data, error } = await resend.emails.send({
      from: '10xNewsPulse.AI <onboarding@resend.dev>',
      to: recipientEmail,
      subject: subject || 'Your Curated Industry Briefing — 10xNewsPulse.AI',
      text: "Please find your curated industry briefing attached as an HTML file. You can download and open it in any web browser to view the fully styled newsletter.",
      attachments: [
        {
          filename: '10xNewsPulse_Briefing.html',
          content: Buffer.from(htmlContent)
        }
      ]
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log(`[API] Email sent successfully to: ${recipientEmail} via Resend`);
    return res.json({ success: true, mock: false, message: `Email dispatched to ${recipientEmail}` });
  } catch (err: any) {
    console.error('[API Error] Resend email failed:', err);
    return res.status(500).json({
      error: err.message || 'Failed to send email via Resend. Check your API Key.'
    });
  }
});

// Clear / Delete latest persistent newsletter
app.delete('/api/clear-newsletter', async (req: Request, res: Response) => {
  try {
    if (fs.existsSync(PERSISTENT_FILE_PATH)) {
      await fs.promises.unlink(PERSISTENT_FILE_PATH);
      console.log(`[API] Deleted persistent newsletter file: ${PERSISTENT_FILE_PATH}`);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("[API Error] Failed to delete persistent newsletter:", error);
    return res.status(500).json({ error: "Failed to clear persistent newsletter state." });
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Newsletter AI Backend listening on port ${PORT}`);
  console.log(`Health endpoint: http://localhost:${PORT}/health`);
  console.log(`API endpoint:    http://localhost:${PORT}/api/generate-newsletter`);
  console.log(`========================================`);
});
