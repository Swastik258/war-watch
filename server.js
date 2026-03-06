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
const { Parser } = require('json2csv');
const fs = require('fs').promises;
const moment = require('moment-timezone');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const newsapi = new NewsAPI(process.env.NEWS_API_KEY);

// Data stores
let latestNews = [];
let latestVideos = [];
let liveAircraft = [];
let liveVessels = [];
let earthquakes = [];
let weatherAlerts = [];
let militaryBases = [];
let economicData = {};
let cyberThreats = [];
let conflictZones = [];
let casualties = {};
let alerts = [];
let tickerItems = [];
let incidentHistory = [];
let historicalData = [];
let regionStats = {};

// RSS Feeds
const rssFeeds = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News', reliability: 0.95 },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera', reliability: 0.9 },
  { url: 'https://rss.cnn.com/rss/edition_world.rss', name: 'CNN', reliability: 0.9 },
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters', reliability: 0.98 },
  { url: 'https://www.theguardian.com/world/rss', name: 'The Guardian', reliability: 0.93 },
  { url: 'https://www.understandingwar.org/rss.xml', name: 'ISW', reliability: 0.96 },
  { url: 'https://www.crisisgroup.org/rss/latest', name: 'Crisis Group', reliability: 0.97 },
  { url: 'https://www.defense.gov/News/RSS/', name: 'US DoD', reliability: 0.98 },
  { url: 'https://www.army.mil/rss/', name: 'US Army', reliability: 0.97 }
];

// Region coordinates
const regionCoordinates = {
  'Eastern Europe': { lat: 48.3794, lng: 31.1656, top: '32%', left: '55%' },
  'Middle East': { lat: 33.5138, lng: 36.2765, top: '48%', left: '63%' },
  'North Africa': { lat: 31.7917, lng: -7.0926, top: '58%', left: '52%' },
  'South Asia': { lat: 33.9391, lng: 67.7099, top: '42%', left: '74%' },
  'Sahel Region': { lat: 15.0, lng: 1.0, top: '62%', left: '42%' }
};

// ==================== DATA COLLECTION FUNCTIONS ====================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. RSS Feeds
async function fetchRSSFeeds() {
  let articles = [];
  const parser = new xml2js.Parser({ explicitArray: false, trim: true });
  
  const feedPromises = rssFeeds.map(async (feed) => {
    try {
      const response = await axios.get(feed.url, { timeout: 10000 });
      const result = await parser.parseStringPromise(response.data);
      const items = result.rss?.channel?.item || [];
      const feedItems = Array.isArray(items) ? items : [items];
      
      return feedItems.slice(0, 10).map(item => ({
        title: item.title || '',
        description: item.description || '',
        url: item.link || '',
        source: feed.name,
        publishedAt: item.pubDate || new Date().toISOString(),
        category: categorizeNews(item.title + ' ' + (item.description || '')),
        reliability: feed.reliability,
        region: extractRegion(item.title + ' ' + (item.description || ''))
      }));
    } catch (error) {
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

// 2. NewsAPI
async function fetchNewsAPI() {
  try {
    const queries = ['war OR conflict', 'ceasefire OR peace', 'airstrike', 'humanitarian crisis'];
    let allArticles = [];
    
    for (const query of queries) {
      const response = await newsapi.v2.everything({
        q: query,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 20,
      });
      allArticles = [...allArticles, ...response.articles];
      await delay(500);
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
      region: extractRegion(article.title + ' ' + article.description)
    }));
  } catch (error) {
    return [];
  }
}

// 3. Guardian API
async function fetchGuardianAPI() {
  try {
    const response = await axios.get('https://content.guardianapis.com/search', {
      params: {
        q: 'war|conflict|military',
        'api-key': process.env.GUARDIAN_API_KEY,
        'show-fields': 'thumbnail,headline',
        'page-size': 30,
        orderBy: 'newest'
      }
    });
    
    return response.data.response.results.map(article => ({
      title: article.fields?.headline || article.webTitle,
      description: article.fields?.trailText || '',
      url: article.webUrl,
      image: article.fields?.thumbnail || null,
      source: 'The Guardian',
      publishedAt: article.webPublicationDate,
      category: categorizeNews(article.webTitle),
      reliability: 0.93,
      region: extractRegion(article.webTitle)
    }));
  } catch (error) {
    return [];
  }
}

// 4. ACLED Conflict Data
async function fetchACLED() {
  try {
    const response = await axios.get('https://api.acleddata.com/acled/read', {
      params: {
        key: process.env.ACLED_KEY,
        email: process.env.ACLED_EMAIL,
        limit: 100,
        fields: 'event_date,country,region,event_type,actor1,notes,fatalities,latitude,longitude'
      }
    });
    
    return response.data.data.map(event => ({
      title: `${event.event_type} in ${event.country}`,
      description: event.notes || '',
      region: event.region,
      country: event.country,
      fatalities: parseInt(event.fatalities) || 0,
      eventType: event.event_type,
      date: event.event_date,
      lat: parseFloat(event.latitude),
      lng: parseFloat(event.longitude),
      category: mapACLEDCategory(event.event_type)
    }));
  } catch (error) {
    return [];
  }
}

// 5. YouTube Videos
async function fetchYouTubeVideos() {
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: 'conflict footage OR war zone OR military operation',
        type: 'video',
        maxResults: 20,
        order: 'date',
        key: process.env.YOUTUBE_API_KEY,
        videoEmbeddable: true
      }
    });
    
    return response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails.medium.url,
      publishedAt: item.snippet.publishedAt,
      channel: item.snippet.channelTitle
    }));
  } catch (error) {
    return [];
  }
}

// 6. Live Aircraft Tracking (OpenSky)
async function fetchLiveAircraft() {
  try {
    const response = await axios.get('https://opensky-network.org/api/states/all', {
      auth: {
        username: process.env.OPENSKY_USERNAME,
        password: process.env.OPENSKY_PASSWORD
      },
      timeout: 10000
    });
    
    if (response.data && response.data.states) {
      return response.data.states.slice(0, 100).map(state => ({
        icao24: state[0],
        callsign: state[1]?.trim() || 'Unknown',
        originCountry: state[2],
        longitude: state[5],
        latitude: state[6],
        altitude: state[7],
        velocity: state[9],
        heading: state[10],
        isMilitary: isMilitaryAircraft(state[1]),
        timestamp: Date.now()
      }));
    }
    return [];
  } catch (error) {
    return [];
  }
}

// 7. Live Vessel Tracking (Simulated - replace with actual AIS API)
async function fetchLiveVessels() {
  try {
    const response = await axios.get('https://www.marinetraffic.com/en/ais/api/search', {
      params: { ships: 'all', limit: 50 },
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return response.data || [];
  } catch (error) {
    // Return simulated data if API fails
    return generateSimulatedVessels();
  }
}

// 8. Earthquakes (USGS)
async function fetchEarthquakes() {
  try {
    const response = await axios.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
    return response.data.features.map(quake => ({
      id: quake.id,
      magnitude: quake.properties.mag,
      place: quake.properties.place,
      time: quake.properties.time,
      lat: quake.geometry.coordinates[1],
      lng: quake.geometry.coordinates[0],
      depth: quake.geometry.coordinates[2],
      url: quake.properties.url
    }));
  } catch (error) {
    return [];
  }
}

// 9. Weather Alerts
async function fetchWeatherAlerts() {
  try {
    const response = await axios.get('https://api.weather.gov/alerts/active');
    return response.data.features.map(alert => ({
      id: alert.id,
      headline: alert.properties.headline,
      description: alert.properties.description,
      severity: alert.properties.severity,
      urgency: alert.properties.urgency,
      areas: alert.properties.areaDesc,
      lat: alert.geometry?.coordinates[0]?.[1] || null,
      lng: alert.geometry?.coordinates[0]?.[0] || null
    }));
  } catch (error) {
    return [];
  }
}

// 10. Military Bases
async function fetchMilitaryBases() {
  return [
    { name: 'Ramstein Air Base', country: 'Germany', lat: 49.4369, lng: 7.6003, type: 'Air Force', branch: 'USAF' },
    { name: 'Camp Lemonnier', country: 'Djibouti', lat: 11.5427, lng: 43.1595, type: 'Naval Base', branch: 'USN' },
    { name: 'RAF Akrotiri', country: 'Cyprus', lat: 34.5889, lng: 32.9878, type: 'Air Base', branch: 'RAF' },
    { name: 'Diego Garcia', country: 'British Indian Ocean Territory', lat: -7.3133, lng: 72.4111, type: 'Naval Base', branch: 'US/UK' },
    { name: 'Naval Station Rota', country: 'Spain', lat: 36.6237, lng: -6.3312, type: 'Naval Base', branch: 'USN' },
    { name: 'Camp Humphreys', country: 'South Korea', lat: 36.9631, lng: 127.0222, type: 'Army Base', branch: 'US Army' },
    { name: 'Kadena Air Base', country: 'Japan', lat: 26.3578, lng: 127.7636, type: 'Air Base', branch: 'USAF' },
    { name: 'Al Udeid Air Base', country: 'Qatar', lat: 25.1178, lng: 51.3150, type: 'Air Base', branch: 'USAF' },
    { name: 'Camp Bondsteel', country: 'Kosovo', lat: 42.3667, lng: 21.0667, type: 'Army Base', branch: 'US Army' },
    { name: 'Naval Support Activity Bahrain', country: 'Bahrain', lat: 26.2167, lng: 50.5833, type: 'Naval Base', branch: 'USN' }
  ];
}

// 11. Economic Data
async function fetchEconomicData() {
  try {
    const [gold, oil, sp500] = await Promise.all([
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F'),
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/CL=F'),
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/^GSPC')
    ]);
    
    return {
      gold: gold.data.chart.result[0].meta.regularMarketPrice || 2350.50,
      oil: oil.data.chart.result[0].meta.regularMarketPrice || 82.75,
      sp500: sp500.data.chart.result[0].meta.regularMarketPrice || 5120.30,
      vix: 18.75,
      lastUpdate: new Date().toISOString()
    };
  } catch (error) {
    return {
      gold: 2350.50,
      oil: 82.75,
      sp500: 5120.30,
      vix: 18.75,
      lastUpdate: new Date().toISOString()
    };
  }
}

// 12. Cyber Threats (Simulated)
async function fetchCyberThreats() {
  return [
    { title: 'APT29 (Cozy Bear) activity detected in Eastern Europe', published: new Date().toISOString(), severity: 'high' },
    { title: 'New Lazarus Group campaign targeting defense contractors', published: new Date(Date.now() - 3600000).toISOString(), severity: 'critical' },
    { title: 'Ransomware attack on European energy grid - contained', published: new Date(Date.now() - 7200000).toISOString(), severity: 'medium' },
    { title: 'Chinese APT41 targeting Southeast Asian governments', published: new Date(Date.now() - 10800000).toISOString(), severity: 'high' },
    { title: 'Iranian cyber espionage group targeting Middle East', published: new Date(Date.now() - 14400000).toISOString(), severity: 'medium' }
  ];
}

// Helper Functions
function isMilitaryAircraft(callsign) {
  if (!callsign) return false;
  const patterns = ['RCH', 'REACH', 'GAF', 'RRR', 'BAF', 'NAF', 'USAF', 'ARMY', 'NAVY'];
  return patterns.some(p => callsign.includes(p));
}

function generateSimulatedVessels() {
  return [
    { mmsi: '123456789', name: 'USS Ronald Reagan', shipType: 'Aircraft Carrier', country: 'USA', lat: 35.5, lng: 140.0, speed: 15, isNaval: true },
    { mmsi: '987654321', name: 'HMS Queen Elizabeth', shipType: 'Aircraft Carrier', country: 'UK', lat: 50.0, lng: -5.0, speed: 12, isNaval: true },
    { mmsi: '456789123', name: 'FS Charles de Gaulle', shipType: 'Aircraft Carrier', country: 'France', lat: 43.0, lng: 6.0, speed: 10, isNaval: true },
    { mmsi: '789123456', name: 'INS Vikramaditya', shipType: 'Aircraft Carrier', country: 'India', lat: 15.0, lng: 73.0, speed: 8, isNaval: true }
  ];
}

function extractRegion(text) {
  text = text.toLowerCase();
  if (text.includes('ukraine') || text.includes('russia')) return 'Eastern Europe';
  if (text.includes('israel') || text.includes('gaza') || text.includes('syria')) return 'Middle East';
  if (text.includes('libya') || text.includes('egypt')) return 'North Africa';
  if (text.includes('afghanistan') || text.includes('pakistan')) return 'South Asia';
  if (text.includes('mali') || text.includes('niger')) return 'Sahel Region';
  return 'Other';
}

function categorizeNews(text) {
  text = text.toLowerCase();
  if (text.includes('airstrike') || text.includes('drone') || text.includes('missile')) return 'airstrike';
  if (text.includes('diplomat') || text.includes('peace') || text.includes('talks')) return 'diplomatic';
  if (text.includes('aid') || text.includes('refugee') || text.includes('humanitarian')) return 'aid';
  if (text.includes('critical') || text.includes('emergency')) return 'critical';
  if (text.includes('military') || text.includes('troops')) return 'military';
  return 'general';
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

function calculateTrend(data) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const recent = data.filter(e => now - new Date(e.date).getTime() < day).length;
  const previous = data.filter(e => {
    const diff = now - new Date(e.date).getTime();
    return diff > day && diff < 2 * day;
  }).length;
  if (previous === 0) return 0;
  return ((recent - previous) / previous) * 100;
}

// Generate alerts
function generateAlerts(news, acledEvents, earthquakes, weather, cyber) {
  const alerts = [];
  
  news.filter(n => n.category === 'critical').slice(0, 5).forEach((item, i) => {
    alerts.push({
      id: `alert-${Date.now()}-${i}`,
      msg: item.title.substring(0, 80) + '...',
      tag: item.category.toUpperCase(),
      time: moment(item.publishedAt).fromNow(),
      type: 'critical',
      source: item.source
    });
  });
  
  acledEvents.filter(e => e.fatalities > 20).slice(0, 3).forEach((event, i) => {
    alerts.push({
      id: `acled-${Date.now()}-${i}`,
      msg: `${event.fatalities} killed in ${event.eventType} in ${event.country}`,
      tag: 'FATALITY',
      time: moment(event.date).fromNow(),
      type: 'critical',
      source: 'ACLED'
    });
  });
  
  earthquakes.filter(e => e.magnitude > 5.5).slice(0, 2).forEach((quake, i) => {
    alerts.push({
      id: `quake-${Date.now()}-${i}`,
      msg: `M${quake.magnitude} earthquake - ${quake.place}`,
      tag: 'EARTHQUAKE',
      time: moment(quake.time).fromNow(),
      type: 'warning',
      source: 'USGS'
    });
  });
  
  cyber.slice(0, 2).forEach((threat, i) => {
    alerts.push({
      id: `cyber-${Date.now()}-${i}`,
      msg: threat.title,
      tag: 'CYBER',
      time: moment(threat.published).fromNow(),
      type: threat.severity === 'critical' ? 'critical' : 'warning',
      source: 'CyberIntel'
    });
  });
  
  return alerts.slice(0, 15);
}

// Generate ticker items
function generateTickerItems(news, alerts) {
  const items = [
    ...news.slice(0, 8).map(n => n.title),
    ...alerts.slice(0, 4).map(a => a.msg)
  ];
  return [...new Set(items)];
}

// Update conflict zones
function updateConflictZones(acledData) {
  const zones = Object.keys(regionCoordinates).map(name => ({
    name,
    intensity: 'low',
    events: 0,
    fatalities: 0,
    lastUpdate: new Date().toISOString()
  }));
  
  acledData.forEach(event => {
    const zone = zones.find(z => z.name === event.region);
    if (zone) {
      zone.events++;
      zone.fatalities += event.fatalities || 0;
      const score = zone.events * 0.5 + zone.fatalities * 0.1;
      if (score > 30) zone.intensity = 'high';
      else if (score > 15) zone.intensity = 'medium';
    }
  });
  
  return zones;
}

// Update casualties
function updateCasualties(acledData) {
  let military = 0;
  let civilian = 0;
  
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
    military: { total: military },
    civilian: civilian || 1250,
    displaced: Math.floor(Math.random() * 50000) + 50000,
    lastUpdate: new Date().toISOString()
  };
}

// ==================== MAIN DATA FETCH ====================

async function fetchAllData() {
  console.log('Fetching all data...', new Date().toISOString());
  
  try {
    const [
      rssData,
      newsAPIData,
      guardianData,
      acledData,
      youtubeData,
      aircraftData,
      vesselData,
      earthquakeData,
      weatherData,
      baseData,
      economic,
      cyber
    ] = await Promise.allSettled([
      fetchRSSFeeds(),
      fetchNewsAPI(),
      fetchGuardianAPI(),
      fetchACLED(),
      fetchYouTubeVideos(),
      fetchLiveAircraft(),
      fetchLiveVessels(),
      fetchEarthquakes(),
      fetchWeatherAlerts(),
      fetchMilitaryBases(),
      fetchEconomicData(),
      fetchCyberThreats()
    ]);
    
    const allNews = [
      ...(rssData.value || []),
      ...(newsAPIData.value || []),
      ...(guardianData.value || [])
    ];
    
    latestNews = Array.from(new Map(allNews.map(item => [item.title, item])).values())
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 100);
    
    latestVideos = (youtubeData.value || []).slice(0, 8);
    liveAircraft = (aircraftData.value || []).slice(0, 50);
    liveVessels = (vesselData.value || []).slice(0, 20);
    earthquakes = (earthquakeData.value || []).slice(0, 10);
    weatherAlerts = (weatherData.value || []).slice(0, 5);
    militaryBases = baseData.value || [];
    economicData = economic.value || {};
    cyberThreats = (cyber.value || []).slice(0, 8);
    
    const acledEvents = acledData.value || [];
    conflictZones = updateConflictZones(acledEvents);
    casualties = updateCasualties(acledEvents);
    alerts = generateAlerts(latestNews, acledEvents, earthquakes, weatherAlerts, cyberThreats);
    tickerItems = generateTickerItems(latestNews, alerts);
    
    incidentHistory = Array.from({ length: 24 }, (_, i) => Math.floor(Math.random() * 30) + 5);
    
    io.emit('data-update', {
      news: latestNews,
      videos: latestVideos,
      aircraft: liveAircraft,
      vessels: liveVessels,
      earthquakes: earthquakes,
      weather: weatherAlerts,
      militaryBases: militaryBases,
      economic: economicData,
      cyber: cyberThreats,
      zones: conflictZones,
      casualties: casualties,
      alerts: alerts,
      ticker: tickerItems,
      history: incidentHistory
    });
    
    console.log(`✅ Updated: ${latestNews.length} news, ${liveAircraft.length} aircraft, ${alerts.length} alerts`);
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ==================== API ENDPOINTS ====================

app.get('/api/news', (req, res) => res.json(latestNews));
app.get('/api/aircraft', (req, res) => res.json(liveAircraft));
app.get('/api/vessels', (req, res) => res.json(liveVessels));
app.get('/api/economic', (req, res) => res.json(economicData));
app.get('/api/alerts', (req, res) => res.json(alerts));

app.get('/api/export/csv/:type', async (req, res) => {
  try {
    const { type } = req.params;
    let data = [];
    let fields = [];
    
    switch(type) {
      case 'news':
        data = latestNews.slice(0, 50);
        fields = ['title', 'source', 'publishedAt', 'category', 'region'];
        break;
      case 'alerts':
        data = alerts;
        fields = ['msg', 'tag', 'time', 'source'];
        break;
      default:
        return res.status(400).json({ error: 'Invalid type' });
    }
    
    const parser = new Parser({ fields });
    const csv = parser.parse(data);
    
    res.header('Content-Type', 'text/csv');
    res.attachment(`warwatch_${type}_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ==================== WEB SOCKET ====================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.emit('data-update', {
    news: latestNews,
    videos: latestVideos,
    aircraft: liveAircraft,
    vessels: liveVessels,
    earthquakes: earthquakes,
    weather: weatherAlerts,
    militaryBases: militaryBases,
    economic: economicData,
    cyber: cyberThreats,
    zones: conflictZones,
    casualties: casualties,
    alerts: alerts,
    ticker: tickerItems,
    history: incidentHistory
  });
  
  socket.on('filter-news', (category) => {
    if (category === 'all') {
      socket.emit('filtered-news', latestNews);
    } else {
      const filtered = latestNews.filter(item => item.category === category);
      socket.emit('filtered-news', filtered);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ==================== SCHEDULER ====================

cron.schedule('*/10 * * * *', fetchAllData);
fetchAllData();

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 WARWATCH server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}\n`);
});