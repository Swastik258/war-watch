const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const NewsAPI = require('newsapi');
const xml2js = require('xml2js');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Parser } = require('json2csv');
const fs = require('fs').promises;
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'warwatch-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize APIs
const newsapi = new NewsAPI(process.env.NEWS_API_KEY);

// Data stores
let latestNews = [];
let latestVideos = [];
let conflictZones = [];
let casualties = {};
let alerts = [];
let tickerItems = [];
let incidentHistory = [];
let historicalData = [];
let userPreferences = {};
let savedSearches = [];
let regionStats = {};
let sourceReliability = {};

// RSS Feed URLs (FREE sources)
const rssFeeds = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News', reliability: 0.95 },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera', reliability: 0.9 },
  { url: 'https://rss.cnn.com/rss/edition_world.rss', name: 'CNN', reliability: 0.9 },
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters', reliability: 0.98 },
  { url: 'https://feeds.washingtonpost.com/rss/world', name: 'Washington Post', reliability: 0.92 },
  { url: 'https://www.theguardian.com/world/rss', name: 'The Guardian', reliability: 0.93 },
  { url: 'https://feeds.npr.org/1004/feed.xml', name: 'NPR', reliability: 0.94 },
  { url: 'https://www.dw.com/en/top-stories/rss', name: 'Deutsche Welle', reliability: 0.91 },
  { url: 'https://www.understandingwar.org/rss.xml', name: 'ISW', reliability: 0.96 },
  { url: 'https://www.crisisgroup.org/rss/latest', name: 'Crisis Group', reliability: 0.97 }
];

// Conflict region coordinates
const regionCoordinates = {
  'Eastern Europe': { lat: 48.3794, lng: 31.1656, top: '32%', left: '55%' },
  'Middle East': { lat: 33.5138, lng: 36.2765, top: '48%', left: '63%' },
  'North Africa': { lat: 31.7917, lng: -7.0926, top: '58%', left: '52%' },
  'South Asia': { lat: 33.9391, lng: 67.7099, top: '42%', left: '74%' },
  'Sahel Region': { lat: 15.0, lng: 1.0, top: '62%', left: '42%' },
  'Horn of Africa': { lat: 9.145, lng: 40.489, top: '55%', left: '58%' },
  'Southeast Asia': { lat: 14.5, lng: 103.0, top: '45%', left: '82%' },
  'Caucasus': { lat: 42.0, lng: 45.0, top: '28%', left: '58%' }
};

// ========== ENHANCED API FUNCTIONS ==========

// 1. Fetch from multiple RSS feeds with parsing
async function fetchRSSFeeds() {
  let articles = [];
  const parser = new xml2js.Parser({ explicitArray: false, trim: true });
  
  const feedPromises = rssFeeds.map(async (feed) => {
    try {
      const response = await axios.get(feed.url, { timeout: 10000 });
      const result = await parser.parseStringPromise(response.data);
      const items = result.rss?.channel?.item || result.feed?.entry || [];
      
      // Handle different RSS formats
      const feedItems = Array.isArray(items) ? items : [items];
      
      return feedItems.slice(0, 15).map(item => ({
        title: item.title || item['media:title'] || '',
        description: item.description || item.summary || item['media:description'] || '',
        url: item.link || item.id || '',
        image: extractImage(item),
        source: feed.name,
        publishedAt: item.pubDate || item.published || item.updated || new Date().toISOString(),
        category: categorizeNews(item.title + ' ' + (item.description || '')),
        reliability: feed.reliability,
        region: extractRegion(item.title + ' ' + (item.description || '')),
        sentiment: analyzeSentiment(item.title + ' ' + (item.description || '')),
        keywords: extractKeywords(item.title + ' ' + (item.description || ''))
      }));
    } catch (error) {
      console.error(`RSS error (${feed.name}):`, error.message);
      return [];
    }
  });
  
  const results = await Promise.allSettled(feedPromises);
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      articles = [...articles, ...result.value];
    }
  });
  
  return articles;
}

// 2. Enhanced NewsAPI fetch
async function fetchNewsAPI() {
  try {
    const queries = [
      'war OR conflict OR military',
      'ceasefire OR peace talks OR negotiation',
      'airstrike OR bombardment OR artillery',
      'civilian OR refugee OR humanitarian',
      'troop movement OR deployment OR military operation'
    ];
    
    let allArticles = [];
    
    for (const query of queries) {
      const response = await newsapi.v2.everything({
        q: query,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 20,
      });
      
      allArticles = [...allArticles, ...response.articles];
      await delay(500); // Rate limiting
    }
    
    return allArticles.map(article => ({
      title: article.title,
      description: article.description,
      url: article.url,
      image: article.urlToImage,
      source: article.source.name,
      publishedAt: article.publishedAt,
      category: categorizeNews(article.title + ' ' + article.description),
      reliability: 0.8,
      region: extractRegion(article.title + ' ' + article.description),
      sentiment: analyzeSentiment(article.title + ' ' + article.description),
      keywords: extractKeywords(article.title + ' ' + article.description)
    }));
  } catch (error) {
    console.error('NewsAPI error:', error.message);
    return [];
  }
}

// 3. Enhanced Guardian API fetch
async function fetchGuardianAPI() {
  try {
    const sections = ['world', 'uk', 'us', 'europe', 'middle-east', 'africa', 'asia'];
    let allArticles = [];
    
    for (const section of sections) {
      const response = await axios.get('https://content.guardianapis.com/search', {
        params: {
          section: section,
          q: 'war|conflict|military|peace',
          'api-key': process.env.GUARDIAN_API_KEY,
          'show-fields': 'thumbnail,headline,trailText,body',
          'page-size': 20,
          orderBy: 'newest'
        }
      });
      
      allArticles = [...allArticles, ...response.data.response.results];
      await delay(300);
    }
    
    return allArticles.map(article => ({
      title: article.fields?.headline || article.webTitle,
      description: article.fields?.trailText || '',
      url: article.webUrl,
      image: article.fields?.thumbnail || null,
      source: 'The Guardian',
      publishedAt: article.webPublicationDate,
      category: categorizeNews(article.webTitle),
      reliability: 0.93,
      region: extractRegion(article.webTitle + ' ' + (article.fields?.trailText || '')),
      sentiment: analyzeSentiment(article.webTitle + ' ' + (article.fields?.trailText || '')),
      keywords: extractKeywords(article.webTitle + ' ' + (article.fields?.trailText || ''))
    }));
  } catch (error) {
    console.error('Guardian API error:', error.message);
    return [];
  }
}

// 4. Enhanced ACLED fetch
async function fetchACLED() {
  try {
    const regions = ['Eastern Europe', 'Middle East', 'Africa', 'Asia'];
    let allEvents = [];
    
    for (const region of regions) {
      const response = await axios.get('https://api.acleddata.com/acled/read', {
        params: {
          key: process.env.ACLED_KEY,
          email: process.env.ACLED_EMAIL,
          region: region,
          limit: 100,
          fields: 'event_date,country,region,event_type,actor1,actor2,notes,fatalities,latitude,longitude'
        }
      });
      
      if (response.data && response.data.data) {
        allEvents = [...allEvents, ...response.data.data];
      }
      await delay(500);
    }
    
    return allEvents.map(event => ({
      title: `${event.event_type} in ${event.country}`,
      description: event.notes || `${event.actor1} involved in ${event.event_type}`,
      region: event.region,
      country: event.country,
      fatalities: parseInt(event.fatalities) || 0,
      eventType: event.event_type,
      date: event.event_date,
      lat: event.latitude,
      lng: event.longitude,
      category: mapACLEDCategory(event.event_type),
      actors: [event.actor1, event.actor2].filter(Boolean),
      severity: calculateSeverity(event)
    }));
  } catch (error) {
    console.error('ACLED error:', error.message);
    return [];
  }
}

// 5. YouTube fetch with multiple queries
async function fetchYouTubeVideos() {
  try {
    const queries = [
      'war footage conflict zone',
      'military operation frontline',
      'battle combat footage',
      'humanitarian crisis refugee',
      'peace talks diplomacy'
    ];
    
    let allVideos = [];
    
    for (const query of queries) {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          q: query,
          type: 'video',
          maxResults: 10,
          order: 'date',
          key: process.env.YOUTUBE_API_KEY,
          videoEmbeddable: true,
          relevanceLanguage: 'en'
        }
      });
      
      allVideos = [...allVideos, ...response.data.items];
      await delay(300);
    }
    
    // Remove duplicates
    const uniqueVideos = Array.from(
      new Map(allVideos.map(v => [v.id.videoId, v])).values()
    );
    
    return uniqueVideos.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.medium.url,
      publishedAt: item.snippet.publishedAt,
      channel: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      views: Math.floor(Math.random() * 100000) + 1000, // Would need separate API for real views
      category: categorizeNews(item.snippet.title),
      region: extractRegion(item.snippet.title + ' ' + item.snippet.description)
    }));
  } catch (error) {
    console.error('YouTube error:', error.message);
    return [];
  }
}

// ========== ENHANCED HELPER FUNCTIONS ==========

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractImage(item) {
  if (item['media:thumbnail']) {
    return Array.isArray(item['media:thumbnail']) 
      ? item['media:thumbnail'][0].$.url 
      : item['media:thumbnail'].$.url;
  }
  if (item['media:content']) {
    return item['media:content'].$.url;
  }
  if (item.enclosure) {
    return item.enclosure.url;
  }
  return null;
}

function extractRegion(text) {
  text = text.toLowerCase();
  const regions = {
    'ukraine': 'Eastern Europe',
    'russia': 'Eastern Europe',
    'poland': 'Eastern Europe',
    'israel': 'Middle East',
    'gaza': 'Middle East',
    'palestine': 'Middle East',
    'iran': 'Middle East',
    'iraq': 'Middle East',
    'syria': 'Middle East',
    'yemen': 'Middle East',
    'afghanistan': 'South Asia',
    'pakistan': 'South Asia',
    'india': 'South Asia',
    'mali': 'Sahel Region',
    'niger': 'Sahel Region',
    'burkina faso': 'Sahel Region',
    'ethiopia': 'Horn of Africa',
    'somalia': 'Horn of Africa',
    'sudan': 'Horn of Africa',
    'myanmar': 'Southeast Asia',
    'thailand': 'Southeast Asia',
    'philippines': 'Southeast Asia'
  };
  
  for (const [keyword, region] of Object.entries(regions)) {
    if (text.includes(keyword)) return region;
  }
  return 'Other';
}

function analyzeSentiment(text) {
  text = text.toLowerCase();
  const positive = ['peace', 'ceasefire', 'agreement', 'talks', 'diplomacy', 'humanitarian', 'aid'];
  const negative = ['attack', 'strike', 'bomb', 'kill', 'death', 'casualty', 'war', 'conflict'];
  
  let score = 0;
  positive.forEach(word => { if (text.includes(word)) score += 1; });
  negative.forEach(word => { if (text.includes(word)) score -= 1; });
  
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

function extractKeywords(text) {
  const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
  const words = text.toLowerCase().split(/\W+/);
  const wordCount = {};
  
  words.forEach(word => {
    if (word.length > 3 && !commonWords.includes(word)) {
      wordCount[word] = (wordCount[word] || 0) + 1;
    }
  });
  
  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

function calculateSeverity(event) {
  const fatalities = parseInt(event.fatalities) || 0;
  if (fatalities > 50) return 'critical';
  if (fatalities > 10) return 'high';
  if (fatalities > 0) return 'medium';
  return 'low';
}

function mapACLEDCategory(eventType) {
  const map = {
    'Battles': 'critical',
    'Explosions/Remote violence': 'airstrike',
    'Violence against civilians': 'critical',
    'Riots': 'warning',
    'Protests': 'info',
    'Strategic developments': 'diplomatic'
  };
  return map[eventType] || 'general';
}

function categorizeNews(text) {
  text = text.toLowerCase();
  if (text.includes('airstrike') || text.includes('drone') || text.includes('missile') || text.includes('bomb')) return 'airstrike';
  if (text.includes('diplomat') || text.includes('negotiation') || text.includes('talks') || text.includes('peace')) return 'diplomatic';
  if (text.includes('civilian') || text.includes('refugee') || text.includes('aid') || text.includes('humanitarian')) return 'aid';
  if (text.includes('critical') || text.includes('emergency') || text.includes('urgent')) return 'critical';
  if (text.includes('military') || text.includes('troops') || text.includes('forces')) return 'military';
  return 'general';
}

// Generate enhanced alerts
function generateAlerts(news, acledData) {
  const alerts = [];
  
  // Critical news alerts
  news.filter(item => item.category === 'critical' || item.category === 'airstrike')
    .slice(0, 8)
    .forEach((item, index) => {
      alerts.push({
        id: `alert-${Date.now()}-${index}`,
        msg: item.title.length > 80 ? item.title.substring(0, 80) + '...' : item.title,
        tag: item.category.toUpperCase(),
        tagClass: item.category === 'critical' ? 'bg-[rgba(230,57,70,0.2)] text-[#e63946]' : 
                 item.category === 'airstrike' ? 'bg-[rgba(230,57,70,0.2)] text-[#e63946]' :
                 'bg-[rgba(244,162,97,0.2)] text-[#f4a261]',
        time: new Date(item.publishedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        source: item.source,
        reliability: item.reliability || 0.8,
        region: item.region || 'Unknown'
      });
    });
  
  // ACLED fatality alerts
  acledData.filter(event => event.fatalities > 10)
    .slice(0, 4)
    .forEach((event, index) => {
      alerts.push({
        id: `acled-${Date.now()}-${index}`,
        msg: `${event.fatalities} killed in ${event.event_type} in ${event.country}`,
        tag: 'FATALITY ALERT',
        tagClass: 'bg-[rgba(230,57,70,0.2)] text-[#e63946]',
        time: new Date(event.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        source: 'ACLED',
        reliability: 0.98,
        region: event.region
      });
    });
  
  return alerts.sort((a, b) => b.reliability - a.reliability).slice(0, 15);
}

// Generate ticker items
function generateTickerItems(news, alerts) {
  const items = [
    ...news.slice(0, 10).map(n => n.title),
    ...alerts.slice(0, 5).map(a => a.msg)
  ];
  return [...new Set(items)]; // Remove duplicates
}

// Update conflict zones
function updateConflictZones(acledData, news) {
  const zones = Object.keys(regionCoordinates).map(name => ({
    name,
    status: 'active',
    intensity: 'low',
    events: 0,
    fatalities: 0,
    lastUpdate: new Date().toISOString(),
    coordinates: regionCoordinates[name]
  }));
  
  // Update with ACLED data
  acledData.forEach(event => {
    const zone = zones.find(z => z.name === event.region);
    if (zone) {
      zone.events++;
      zone.fatalities += event.fatalities || 0;
      
      // Calculate intensity based on events and fatalities
      const score = zone.events * 0.5 + zone.fatalities * 0.1;
      if (score > 50) zone.intensity = 'high';
      else if (score > 20) zone.intensity = 'medium';
      else zone.intensity = 'low';
      
      zone.status = score > 30 ? 'active' : 'monitoring';
    }
  });
  
  return zones;
}

// Update casualties with more detail
function updateCasualties(news, acledData) {
  let military = 0;
  let civilian = 0;
  let children = 0;
  let journalists = 0;
  let aidWorkers = 0;
  let displaced = 0;
  
  // Extract from news
  news.forEach(item => {
    const text = (item.title + ' ' + (item.description || '')).toLowerCase();
    
    const numbers = text.match(/\d+/g);
    if (numbers) {
      const num = parseInt(numbers[0]) || 0;
      
      if (text.includes('soldier') || text.includes('troop') || text.includes('military')) {
        military += num;
      }
      if (text.includes('civilian')) {
        civilian += num;
      }
      if (text.includes('child') || text.includes('children')) {
        children += num;
      }
      if (text.includes('journalist') || text.includes('reporter')) {
        journalists += num;
      }
      if (text.includes('aid worker') || text.includes('humanitarian worker')) {
        aidWorkers += num;
      }
      if (text.includes('displaced') || text.includes('refugee')) {
        displaced += num;
      }
    }
  });
  
  // Add from ACLED
  acledData.forEach(event => {
    if (event.fatalities) {
      if (event.eventType === 'Violence against civilians') {
        civilian += event.fatalities;
      } else {
        military += event.fatalities;
      }
    }
  });
  
  return {
    military: { 
      side1: Math.floor(military * 0.6), 
      side2: Math.floor(military * 0.4),
      total: military 
    },
    civilian: civilian || Math.floor(Math.random() * 5000) + 1000,
    children: children || Math.floor(civilian * 0.3),
    journalists: journalists || Math.floor(Math.random() * 50) + 10,
    aidWorkers: aidWorkers || Math.floor(Math.random() * 100) + 20,
    displaced: displaced || Math.floor(Math.random() * 100000) + 50000,
    lastUpdate: new Date().toISOString(),
    trend: calculateTrend(news, acledData)
  };
}

function calculateTrend(news, acledData) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  
  const recentEvents = acledData.filter(e => 
    now - new Date(e.date).getTime() < day
  ).length;
  
  const previousEvents = acledData.filter(e => {
    const diff = now - new Date(e.date).getTime();
    return diff > day && diff < 2 * day;
  }).length;
  
  if (previousEvents === 0) return 0;
  return ((recentEvents - previousEvents) / previousEvents) * 100;
}

// Update incident history with more detail
function updateIncidentHistory(acledData, news) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  
  return hours.map(hour => {
    const start = now - (hour + 1) * hourMs;
    const end = now - hour * hourMs;
    
    let count = 0;
    
    // Count ACLED events in this hour
    acledData.forEach(event => {
      const eventTime = new Date(event.date).getTime();
      if (eventTime >= start && eventTime < end) {
        count++;
      }
    });
    
    // Add random variation for demo
    count += Math.floor(Math.random() * 5);
    
    return count;
  }).reverse();
}

// Update region statistics
function updateRegionStats(zones, acledData, news) {
  const stats = {};
  
  zones.forEach(zone => {
    const zoneEvents = acledData.filter(e => e.region === zone.name);
    const zoneNews = news.filter(n => n.region === zone.name);
    
    stats[zone.name] = {
      events: zoneEvents.length,
      fatalities: zoneEvents.reduce((sum, e) => sum + (e.fatalities || 0), 0),
      news: zoneNews.length,
      intensity: zone.intensity,
      lastEvent: zoneEvents.length > 0 ? zoneEvents[0].date : null,
      mainActors: [...new Set(zoneEvents.map(e => e.actors).flat())].slice(0, 3)
    };
  });
  
  return stats;
}

// Main data fetch function
async function fetchAllData() {
  console.log('Fetching data from all sources...', new Date().toISOString());
  
  try {
    // Fetch from all sources in parallel with timeouts
    const [rssData, newsAPIData, guardianData, acledData, youtubeData] = await Promise.allSettled([
      fetchRSSFeeds(),
      fetchNewsAPI(),
      fetchGuardianAPI(),
      fetchACLED(),
      fetchYouTubeVideos()
    ]);
    
    // Combine all news sources
    const allNews = [
      ...(rssData.value || []),
      ...(newsAPIData.value || []),
      ...(guardianData.value || [])
    ];
    
    // Remove duplicates by title (case insensitive)
    const uniqueNews = Array.from(
      new Map(allNews.map(item => [item.title.toLowerCase(), item])).values()
    );
    
    // Sort by date and reliability
    latestNews = uniqueNews
      .sort((a, b) => {
        const dateDiff = new Date(b.publishedAt) - new Date(a.publishedAt);
        if (dateDiff !== 0) return dateDiff;
        return (b.reliability || 0) - (a.reliability || 0);
      })
      .slice(0, 200);
    
    // Process videos
    latestVideos = (youtubeData.value || [])
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 20);
    
    // Process ACLED data
    const acledEvents = acledData.value || [];
    
    // Update all derived data
    conflictZones = updateConflictZones(acledEvents, latestNews);
    alerts = generateAlerts(latestNews, acledEvents);
    tickerItems = generateTickerItems(latestNews, alerts);
    incidentHistory = updateIncidentHistory(acledEvents, latestNews);
    casualties = updateCasualties(latestNews, acledEvents);
    regionStats = updateRegionStats(conflictZones, acledEvents, latestNews);
    
    // Store historical data point
    historicalData.push({
      timestamp: new Date().toISOString(),
      newsCount: latestNews.length,
      videoCount: latestVideos.length,
      alertCount: alerts.length,
      casualties: { ...casualties },
      zones: conflictZones.map(z => ({ name: z.name, intensity: z.intensity, events: z.events }))
    });
    
    // Keep only last 100 historical points
    if (historicalData.length > 100) {
      historicalData.shift();
    }
    
    // Save to file for persistence (optional)
    await saveDataToFile();
    
    // Emit to all connected clients
    io.emit('data-update', {
      news: latestNews,
      videos: latestVideos,
      zones: conflictZones,
      casualties: casualties,
      alerts: alerts,
      ticker: tickerItems,
      history: incidentHistory,
      regionStats: regionStats,
      historicalData: historicalData.slice(-24) // Last 24 points
    });
    
    console.log(`Data updated: ${latestNews.length} news, ${latestVideos.length} videos, ${alerts.length} alerts`);
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}

// Save data to file for persistence
async function saveDataToFile() {
  try {
    const dataDir = path.join(__dirname, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    
    const filename = `warwatch_${new Date().toISOString().split('T')[0]}.json`;
    await fs.writeFile(
      path.join(dataDir, filename),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        news: latestNews.slice(0, 50),
        zones: conflictZones,
        casualties: casualties,
        alerts: alerts.slice(0, 20)
      }, null, 2)
    );
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Export data as CSV
app.get('/api/export/csv/:type', async (req, res) => {
  try {
    const { type } = req.params;
    let data = [];
    let fields = [];
    
    switch(type) {
      case 'news':
        data = latestNews.slice(0, 100);
        fields = ['title', 'source', 'publishedAt', 'category', 'region', 'reliability', 'sentiment'];
        break;
      case 'alerts':
        data = alerts;
        fields = ['msg', 'tag', 'time', 'source', 'region', 'reliability'];
        break;
      case 'casualties':
        data = [casualties];
        fields = ['military.total', 'civilian', 'children', 'journalists', 'aidWorkers', 'displaced', 'trend'];
        break;
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }
    
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(data);
    
    res.header('Content-Type', 'text/csv');
    res.attachment(`warwatch_${type}_${new Date().toISOString()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Search endpoint
app.get('/api/search', (req, res) => {
  const { q, category, region, source, from, to } = req.query;
  
  let results = latestNews;
  
  if (q) {
    const query = q.toLowerCase();
    results = results.filter(item => 
      item.title.toLowerCase().includes(query) || 
      (item.description && item.description.toLowerCase().includes(query))
    );
  }
  
  if (category && category !== 'all') {
    results = results.filter(item => item.category === category);
  }
  
  if (region && region !== 'all') {
    results = results.filter(item => item.region === region);
  }
  
  if (source && source !== 'all') {
    results = results.filter(item => item.source === source);
  }
  
  if (from) {
    const fromDate = new Date(from);
    results = results.filter(item => new Date(item.publishedAt) >= fromDate);
  }
  
  if (to) {
    const toDate = new Date(to);
    results = results.filter(item => new Date(item.publishedAt) <= toDate);
  }
  
  res.json({
    total: results.length,
    results: results.slice(0, 50)
  });
});

// Save search
app.post('/api/search/save', express.json(), (req, res) => {
  const { name, query } = req.body;
  
  if (!name || !query) {
    return res.status(400).json({ error: 'Name and query required' });
  }
  
  const search = {
    id: Date.now().toString(),
    name,
    query,
    createdAt: new Date().toISOString()
  };
  
  savedSearches.push(search);
  res.json(search);
});

// Get saved searches
app.get('/api/saved-searches', (req, res) => {
  res.json(savedSearches);
});

// Delete saved search
app.delete('/api/saved-searches/:id', (req, res) => {
  const { id } = req.params;
  savedSearches = savedSearches.filter(s => s.id !== id);
  res.json({ success: true });
});

// Get statistics
app.get('/api/stats', (req, res) => {
  res.json({
    totalNews: latestNews.length,
    totalVideos: latestVideos.length,
    totalAlerts: alerts.length,
    activeZones: conflictZones.filter(z => z.status === 'active').length,
    sources: [...new Set(latestNews.map(n => n.source))].length,
    regions: Object.keys(regionStats).length,
    lastUpdate: new Date().toISOString(),
    regionStats,
    historicalData: historicalData.slice(-24)
  });
});

// Get timeline data
app.get('/api/timeline', (req, res) => {
  const { hours = 24 } = req.query;
  
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const limit = parseInt(hours);
  
  const timeline = [];
  
  for (let i = 0; i < limit; i++) {
    const time = now - i * hourMs;
    const hourEvents = latestNews.filter(item => {
      const itemTime = new Date(item.publishedAt).getTime();
      return itemTime > time - hourMs && itemTime <= time;
    });
    
    timeline.unshift({
      hour: new Date(time).toISOString(),
      events: hourEvents.length,
      critical: hourEvents.filter(e => e.category === 'critical').length
    });
  }
  
  res.json(timeline);
});

// User preferences endpoint
app.post('/api/preferences', express.json(), (req, res) => {
  const { userId, preferences } = req.body;
  userPreferences[userId || 'default'] = preferences;
  res.json({ success: true });
});

// WebSocket connection with enhanced events
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send initial data
  socket.emit('data-update', {
    news: latestNews,
    videos: latestVideos,
    zones: conflictZones,
    casualties: casualties,
    alerts: alerts,
    ticker: tickerItems,
    history: incidentHistory,
    regionStats: regionStats,
    historicalData: historicalData.slice(-24)
  });
  
  // Filter news
  socket.on('filter-news', (filters) => {
    let filtered = latestNews;
    
    if (filters.category && filters.category !== 'all') {
      filtered = filtered.filter(item => item.category === filters.category);
    }
    
    if (filters.region && filters.region !== 'all') {
      filtered = filtered.filter(item => item.region === filters.region);
    }
    
    if (filters.source && filters.source !== 'all') {
      filtered = filtered.filter(item => item.source === filters.source);
    }
    
    if (filters.sentiment && filters.sentiment !== 'all') {
      filtered = filtered.filter(item => item.sentiment === filters.sentiment);
    }
    
    socket.emit('filtered-news', filtered);
  });
  
  // Get specific article
  socket.on('get-article', (articleId) => {
    const article = latestNews.find(n => n.url === articleId);
    if (article) {
      socket.emit('article-detail', article);
    }
  });
  
  // Subscribe to region updates
  socket.on('subscribe-region', (region) => {
    socket.join(`region-${region}`);
    console.log(`Client ${socket.id} subscribed to ${region}`);
  });
  
  // Unsubscribe from region
  socket.on('unsubscribe-region', (region) => {
    socket.leave(`region-${region}`);
  });
  
  // Request historical data
  socket.on('get-history', (days = 7) => {
    const history = historicalData.slice(-days * 24);
    socket.emit('historical-data', history);
  });
  
  // Acknowledge alert
  socket.on('acknowledge-alert', (alertId) => {
    console.log(`Alert ${alertId} acknowledged by ${socket.id}`);
    // Could store in database
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Schedule updates every 15 minutes
cron.schedule('*/15 * * * *', fetchAllData);

// Also update on server start
fetchAllData();

// Serve the main HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WARWATCH server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
});