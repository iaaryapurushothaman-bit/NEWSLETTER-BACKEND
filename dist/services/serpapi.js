"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchNews = fetchNews;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
async function fetchNews(params) {
    const { sector, category, customCategory, clientName, serpApiKey } = params;
    // Build the search query
    let query = sector;
    if (customCategory && customCategory.trim() !== '') {
        query += ` ${customCategory.trim()}`;
    }
    else if (category && category !== 'Custom...' && category.trim() !== '') {
        query += ` ${category.trim()}`;
    }
    query += " news";
    // Use the provided API key or fallback to env
    const apiKey = serpApiKey || process.env.SERPAPI_API_KEY || '';
    if (!apiKey) {
        throw new Error("SerpAPI key is missing. Please configure it in .env or provide it in the request.");
    }
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.append("engine", "google");
    url.searchParams.append("q", query);
    url.searchParams.append("api_key", apiKey);
    url.searchParams.append("tbm", "nws"); // Google News search
    url.searchParams.append("num", (params.newsCount || 5).toString()); // Fetch specified number of recent stories
    console.log(`[SerpAPI] Querying Google News with: "${query}"`);
    try {
        const response = await fetch(url.toString());
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`SerpAPI error status: ${response.status} - ${errorText}`);
        }
        const data = await response.json();
        const newsResults = data.news_results || [];
        const formattedArticles = newsResults.map((item) => ({
            title: item.title || '',
            link: item.link || '',
            snippet: item.snippet || '',
            source: item.source || 'News Source',
            date: item.date || ''
        }));
        console.log(`[SerpAPI] Successfully fetched ${formattedArticles.length} articles.`);
        return formattedArticles;
    }
    catch (error) {
        console.error("[SerpAPI] Failed to fetch news:", error);
        throw error;
    }
}
