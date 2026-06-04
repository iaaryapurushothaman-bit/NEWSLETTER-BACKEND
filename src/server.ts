import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import { fetchNews } from './services/serpapi';
import { generateNewsletter } from './services/vertexai';
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
  <title>NewsPulse.AI - Newsletter Briefing</title>
  <style>
    body { font-family: 'Inter', Arial, sans-serif; background: #f1f5f9; padding: 32px; }
    .meta { max-width: 600px; margin: 0 auto 16px auto; background: #1e293b; color: #94a3b8; font-size: 12px; padding: 12px 20px; border-radius: 8px; }
    .meta b { color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="meta">
    <b>NewsPulse.AI Mock Email</b><br>
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

  // === LIVE MODE: Send via Gmail or Outlook SMTP ===
  try {
    const isOutlook = smtpUser.toLowerCase().includes('outlook.com') || smtpUser.toLowerCase().includes('hotmail.com');

    const transporter = nodemailer.createTransport(
      isOutlook ? {
        host: 'smtp-mail.outlook.com',
        port: 587,
        secure: false, // STARTTLS
        auth: {
          user: smtpUser,
          pass: smtpPass,
        }
      } : {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        // Force Node to use IPv4 instead of IPv6 for SMTP connections
        family: 4 
      }
    );

    await transporter.sendMail({
      from: `"NewsPulse.AI" <${smtpUser}>`,
      to: recipientEmail,
      subject: subject || 'Your Curated Industry Briefing — NewsPulse.AI',
      text: "Please find your curated industry briefing attached as an HTML file. You can download and open it in any web browser to view the fully styled newsletter.",
      attachments: [
        {
          filename: 'NewsForge_Briefing.html',
          content: htmlContent,
          contentType: 'text/html'
        }
      ]
    });

    console.log(`[API] Email sent successfully to: ${recipientEmail}`);
    return res.json({ success: true, mock: false, message: `Email dispatched to ${recipientEmail}` });
  } catch (err: any) {
    console.error('[API Error] Gmail send failed:', err);
    return res.status(500).json({
      error: err.message || 'Failed to send email via Gmail. Check your SMTP credentials.'
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
