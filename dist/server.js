"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const resend_1 = require("resend");
const mammoth_1 = __importDefault(require("mammoth"));
const pdf = require('pdf-parse');
const serpapi_1 = require("./services/serpapi");
const vertexai_1 = require("./services/vertexai");
const imagegeneration_1 = require("./services/imagegeneration");
dotenv_1.default.config();
const PERSISTENT_FILE_PATH = path_1.default.join(__dirname, '..', 'latest_newsletter.json');
const saveNewsletterState = async (inputs, result, briefingId) => {
    try {
        const dataObj = {
            inputs,
            result,
            briefingId: briefingId || inputs.briefingId || (result && result.briefingId) || null,
            savedAt: new Date().toISOString()
        };
        const data = JSON.stringify(dataObj, null, 2);
        await fs_1.default.promises.writeFile(PERSISTENT_FILE_PATH, data, 'utf8');
        console.log(`[API] Saved latest newsletter state to ${PERSISTENT_FILE_PATH}`);
        const id = briefingId || inputs.briefingId || (result && result.briefingId);
        if (id) {
            const archiveDir = path_1.default.join(__dirname, '..', 'archive');
            if (!fs_1.default.existsSync(archiveDir)) {
                await fs_1.default.promises.mkdir(archiveDir, { recursive: true });
            }
            const archivePath = path_1.default.join(archiveDir, `archive_${id}.json`);
            await fs_1.default.promises.writeFile(archivePath, data, 'utf8');
            console.log(`[API] Archived newsletter state to ${archivePath}`);
        }
    }
    catch (error) {
        console.error("[API Error] Failed to save newsletter state:", error);
    }
};
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
// Enable CORS for all origins in development
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
// Basic health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date() });
});
// Main generate newsletter API endpoint
app.post('/api/generate-newsletter', async (req, res) => {
    const { sector, category, custom_category, customCategory, client_name, clientName, clientLogo, news_count, newsCount } = req.body;
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
        const rawNews = await (0, serpapi_1.fetchNews)({
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
        const newsletterContent = await (0, vertexai_1.generateNewsletter)({
            sector: finalSector,
            category: finalCategory,
            customCategory: finalCustomCategory,
            clientName: finalClientName,
            newsCount: finalNewsCount,
            newsData: limitedNews
        });
        // Step 3: Generate images in parallel/sequentially for each news item
        console.log(`[API] Generating ${newsletterContent.news_items.length} news images...`);
        const images = await (0, imagegeneration_1.generateNewsImages)(newsletterContent.news_items.map(item => ({
            heading: item.heading,
            description: item.description
        })));
        // Step 4: Generate a hero image for the editorial summary
        console.log(`[API] Generating hero image for editorial summary...`);
        const editorialImage = await (0, imagegeneration_1.generateNewsImage)(`${finalSector} Industry Overview`, newsletterContent.editorial_summary.substring(0, 500));
        // Attach generated images to news items
        const enrichedItems = newsletterContent.news_items.map((item, i) => ({
            ...item,
            image_url: images[i] || null
        }));
        const briefingId = Date.now().toString();
        const resultPayload = {
            ...newsletterContent,
            editorial_image_url: editorialImage,
            news_items: enrichedItems,
            briefingId
        };
        // Save the generated state to disk
        await saveNewsletterState({
            sector: finalSector,
            category: finalCategory,
            customCategory: finalCustomCategory,
            clientName: finalClientName,
            clientLogo: clientLogo || null,
            newsCount: finalNewsCount,
            briefingId
        }, resultPayload, briefingId);
        res.json(resultPayload);
    }
    catch (error) {
        console.error("[API Error] Failed to generate newsletter:", error);
        res.status(500).json({
            error: error.message || "An error occurred during newsletter generation. Please verify your API keys and credentials setup."
        });
    }
});
// Generate newsletter based on uploaded Word or PDF documents
app.post('/api/generate-from-file', async (req, res) => {
    const { fileBuffer, // base64 string (legacy fallback)
    files, // array of { name: string, data: string, type: 'docx' | 'pdf' }
    clientName, clientLogo, newsCount } = req.body;
    const finalClientName = clientName || '';
    const finalNewsCount = parseInt(newsCount || '5', 10);
    let filesToProcess = files || [];
    if (filesToProcess.length === 0 && fileBuffer) {
        filesToProcess = [{
                name: 'document.docx',
                data: fileBuffer,
                type: 'docx'
            }];
    }
    if (filesToProcess.length === 0) {
        return res.status(400).json({ error: "No file content was provided." });
    }
    try {
        console.log(`[API] Received generation-from-file request for Client: "${finalClientName}" with ${filesToProcess.length} file(s)`);
        let combinedText = '';
        for (const file of filesToProcess) {
            console.log(`[API] Extracting text from file: "${file.name}" (type: ${file.type})`);
            const buffer = Buffer.from(file.data, 'base64');
            let extractedText = '';
            if (file.type === 'docx') {
                const mammothResult = await mammoth_1.default.extractRawText({ buffer });
                extractedText = mammothResult.value;
            }
            else if (file.type === 'pdf') {
                const pdfResult = await pdf(buffer);
                extractedText = pdfResult.text;
            }
            else {
                console.warn(`[API] Unsupported file type: ${file.type} for file ${file.name}`);
                continue;
            }
            if (extractedText && extractedText.trim().length > 0) {
                combinedText += `\n\n--- Document: ${file.name} ---\n${extractedText}`;
            }
        }
        if (!combinedText || combinedText.trim().length === 0) {
            return res.status(400).json({ error: "Could not extract any text from the provided document(s). Make sure they are valid, non-empty Word or PDF files." });
        }
        console.log(`[API] Extracted combined text length: ${combinedText.length} characters.`);
        // Orchestrate Vertex AI to generate newsletter based on document text
        console.log(`[API] Generating newsletter content from file text...`);
        const newsletterContent = await (0, vertexai_1.generateNewsletterFromFile)({
            documentText: combinedText,
            clientName: finalClientName,
            newsCount: finalNewsCount
        });
        // Generate images in parallel/sequentially for each news item
        console.log(`[API] Generating ${newsletterContent.news_items.length} news images...`);
        const images = await (0, imagegeneration_1.generateNewsImages)(newsletterContent.news_items.map(item => ({
            heading: item.heading,
            description: item.description
        })));
        // Generate a hero image for the editorial summary (only if it exists)
        let editorialImage = null;
        if (newsletterContent.editorial_summary) {
            console.log(`[API] Generating hero image for editorial summary...`);
            editorialImage = await (0, imagegeneration_1.generateNewsImage)(newsletterContent.editorial_title || `Overview: ${finalClientName || 'Industry Trends'}`, newsletterContent.editorial_summary.substring(0, 500));
        }
        // Generate an image for the wish section if it exists
        let wishImage = null;
        if (newsletterContent.wish && newsletterContent.wish.wish_title) {
            console.log(`[API] Generating image for wish section: "${newsletterContent.wish.wish_title}"...`);
            wishImage = await (0, imagegeneration_1.generateNewsImage)(newsletterContent.wish.wish_title, newsletterContent.wish.wish_content.substring(0, 500));
            // Wait for a short delay to respect Vertex AI quotas
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        // Attach generated images to news items
        const enrichedItems = newsletterContent.news_items.map((item, i) => ({
            ...item,
            image_url: images[i] || null
        }));
        const briefingId = Date.now().toString();
        const resultPayload = {
            ...newsletterContent,
            editorial_image_url: editorialImage,
            wish: newsletterContent.wish ? {
                ...newsletterContent.wish,
                image_url: wishImage
            } : null,
            news_items: enrichedItems,
            briefingId
        };
        // Save the generated state to disk
        await saveNewsletterState({
            sector: '10xDS CURVE',
            category: '10xDS CURVE',
            customCategory: '',
            clientName: finalClientName,
            clientLogo: clientLogo || null,
            newsCount: finalNewsCount,
            briefingId
        }, resultPayload, briefingId);
        res.json(resultPayload);
    }
    catch (error) {
        console.error("[API Error] Failed to generate newsletter from file:", error);
        res.status(500).json({
            error: error.message || "An error occurred during newsletter generation from the uploaded file. Please verify credentials."
        });
    }
});
// Regenerate single image using Gemini
app.post('/api/regenerate-image', async (req, res) => {
    const { heading, description } = req.body;
    if (!heading) {
        return res.status(400).json({ error: "Heading is required to generate an image." });
    }
    try {
        console.log(`[API] Regenerating image for heading: "${heading}"...`);
        const imageUrl = await (0, imagegeneration_1.generateNewsImage)(heading, description || '');
        if (!imageUrl) {
            return res.status(500).json({ error: "Failed to generate image." });
        }
        res.json({ image_url: imageUrl });
    }
    catch (error) {
        console.error("[API Error] Failed to regenerate image:", error);
        res.status(500).json({ error: error.message || "An error occurred while generating the image." });
    }
});
// Get latest persistent newsletter
app.get('/api/latest-newsletter', async (req, res) => {
    try {
        if (fs_1.default.existsSync(PERSISTENT_FILE_PATH)) {
            const dataStr = await fs_1.default.promises.readFile(PERSISTENT_FILE_PATH, 'utf8');
            const data = JSON.parse(dataStr);
            return res.json(data);
        }
        return res.json({ inputs: null, result: null });
    }
    catch (error) {
        console.error("[API Error] Failed to read latest newsletter:", error);
        return res.status(500).json({ error: "Failed to load persistent newsletter state." });
    }
});
// Save current edited newsletter draft
app.post('/api/save-newsletter', async (req, res) => {
    const { inputs, result } = req.body;
    if (!inputs || !result) {
        return res.status(400).json({ error: "Inputs and result are required fields." });
    }
    try {
        const briefingId = inputs.briefingId || (result && result.briefingId) || Date.now().toString();
        inputs.briefingId = briefingId;
        if (result) {
            result.briefingId = briefingId;
        }
        await saveNewsletterState(inputs, result, briefingId);
        return res.json({ success: true, briefingId });
    }
    catch (error) {
        console.error("[API Error] Failed to save newsletter edits:", error);
        return res.status(500).json({ error: "Failed to persist newsletter state." });
    }
});
// Get list of all archived newsletters
app.get('/api/archive', async (req, res) => {
    try {
        const archiveDir = path_1.default.join(__dirname, '..', 'archive');
        if (!fs_1.default.existsSync(archiveDir)) {
            return res.json([]);
        }
        const files = await fs_1.default.promises.readdir(archiveDir);
        const archiveList = [];
        for (const file of files) {
            if (file.startsWith('archive_') && file.endsWith('.json')) {
                try {
                    const filePath = path_1.default.join(archiveDir, file);
                    const contentStr = await fs_1.default.promises.readFile(filePath, 'utf8');
                    const data = JSON.parse(contentStr);
                    archiveList.push({
                        id: data.briefingId || data.inputs?.briefingId || file.replace('archive_', '').replace('.json', ''),
                        sector: data.inputs?.sector || '10xDS CURVE',
                        category: data.inputs?.category || '10xDS CURVE',
                        clientName: data.inputs?.clientName || 'General Audience',
                        briefingDate: data.inputs?.briefingDate || '',
                        savedAt: data.savedAt || new Date().toISOString()
                    });
                }
                catch (err) {
                    console.error(`[API Error] Failed to parse archive file: ${file}`, err);
                }
            }
        }
        // Sort by savedAt descending (newest first)
        archiveList.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
        return res.json(archiveList);
    }
    catch (error) {
        console.error("[API Error] Failed to read archive list:", error);
        return res.status(500).json({ error: "Failed to load archive history." });
    }
});
// Load a single archived newsletter state
app.get('/api/archive/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const filePath = path_1.default.join(__dirname, '..', 'archive', `archive_${id}.json`);
        if (fs_1.default.existsSync(filePath)) {
            const dataStr = await fs_1.default.promises.readFile(filePath, 'utf8');
            const data = JSON.parse(dataStr);
            return res.json(data);
        }
        return res.status(404).json({ error: "Archived briefing not found." });
    }
    catch (error) {
        console.error("[API Error] Failed to read archived briefing:", error);
        return res.status(500).json({ error: "Failed to load archived briefing state." });
    }
});
// Delete a single archived newsletter state
app.delete('/api/archive/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const filePath = path_1.default.join(__dirname, '..', 'archive', `archive_${id}.json`);
        if (fs_1.default.existsSync(filePath)) {
            await fs_1.default.promises.unlink(filePath);
            console.log(`[API] Deleted archived briefing file: ${filePath}`);
            return res.json({ success: true });
        }
        return res.status(404).json({ error: "Archived briefing not found." });
    }
    catch (error) {
        console.error("[API Error] Failed to delete archived briefing:", error);
        return res.status(500).json({ error: "Failed to delete archived briefing state." });
    }
});
// Send newsletter via Gmail (or fallback to local HTML file for demo mode)
app.post('/api/send-email', async (req, res) => {
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
            const sentDir = path_1.default.join(__dirname, '..', 'sent_emails');
            if (!fs_1.default.existsSync(sentDir)) {
                await fs_1.default.promises.mkdir(sentDir, { recursive: true });
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
            await fs_1.default.promises.writeFile(path_1.default.join(sentDir, filename), fullEmailHtml, 'utf8');
            console.log(`[API] [MOCK EMAIL] Saved to sent_emails/${filename}`);
            return res.json({
                success: true,
                mock: true,
                message: `Mock delivery successful! Preview saved: sent_emails/${filename}`,
                filename
            });
        }
        catch (err) {
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
        const resend = new resend_1.Resend(resendApiKey);
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
    }
    catch (err) {
        console.error('[API Error] Resend email failed:', err);
        return res.status(500).json({
            error: err.message || 'Failed to send email via Resend. Check your API Key.'
        });
    }
});
// Clear / Delete latest persistent newsletter
app.delete('/api/clear-newsletter', async (req, res) => {
    try {
        if (fs_1.default.existsSync(PERSISTENT_FILE_PATH)) {
            await fs_1.default.promises.unlink(PERSISTENT_FILE_PATH);
            console.log(`[API] Deleted persistent newsletter file: ${PERSISTENT_FILE_PATH}`);
        }
        return res.json({ success: true });
    }
    catch (error) {
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
