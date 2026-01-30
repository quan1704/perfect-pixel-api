const express = require('express');
const cors = require('cors');
const multer = require('multer');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware - CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json());

// Handle preflight requests
app.options('*', cors());

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, WebP allowed.'));
    }
  }
});

// Store for temporary results
const resultsStore = new Map();

// Cleanup old results every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of resultsStore.entries()) {
    if (now - value.timestamp > 30 * 60 * 1000) {
      resultsStore.delete(key);
    }
  }
}, 30 * 60 * 1000);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main comparison endpoint
app.post('/api/compare', upload.single('design'), async (req, res) => {
  let browser = null;

  try {
    const { url, username, password, width, height } = req.body;
    const designBuffer = req.file?.buffer;

    // Validation
    if (!designBuffer) {
      return res.status(400).json({ error: 'Design image is required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const viewportWidth = Math.min(parseInt(width) || 1920, 3840);
    const viewportHeight = Math.min(parseInt(height) || 1080, 15000); // Max 15000px to prevent memory issues

    console.log(`[Compare] Starting comparison for ${url} at ${viewportWidth}x${viewportHeight}`);

    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--single-process'
      ],
      timeout: 60000
    });

    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: viewportWidth, height: viewportHeight });

    // Handle HTTP Basic Auth
    if (username && password) {
      await page.authenticate({ username, password });
    }

    // Navigate to URL with retry
    console.log(`[Compare] Navigating to ${url}...`);
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 90000 // 90 seconds
      });
    } catch (navError) {
      // If networkidle2 fails, try with 'load' event
      console.log('[Compare] networkidle2 timeout, retrying with load event...');
      await page.goto(url, {
        waitUntil: 'load',
        timeout: 90000
      });
      // Wait extra time for content
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Wait a bit for any animations/lazy loading
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Determine if full page screenshot is needed (height > 2000px)
    const isFullPage = viewportHeight > 2000;
    console.log(`[Compare] Taking ${isFullPage ? 'full page' : 'viewport'} screenshot...`);

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: isFullPage
    });

    await browser.close();
    browser = null;

    console.log('[Compare] Screenshot captured, processing images...');

    // Get actual dimensions from the screenshot
    const screenshotMeta = await sharp(screenshotBuffer).metadata();
    const actualWidth = screenshotMeta.width;
    const actualHeight = screenshotMeta.height;

    // For full page, use actual screenshot dimensions
    const compareWidth = isFullPage ? actualWidth : viewportWidth;
    const compareHeight = isFullPage ? actualHeight : viewportHeight;

    console.log(`[Compare] Comparing at ${compareWidth}x${compareHeight}`);

    // Process design image - convert to PNG and resize to match
    const designProcessed = await sharp(designBuffer)
      .resize(compareWidth, compareHeight, { fit: 'cover', position: 'top', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();

    // Process screenshot
    const screenshotProcessed = await sharp(screenshotBuffer)
      .resize(compareWidth, compareHeight, { fit: 'cover', position: 'top', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();

    // Parse PNGs for pixelmatch
    const designPng = PNG.sync.read(designProcessed);
    const screenshotPng = PNG.sync.read(screenshotProcessed);

    // Create diff image
    const diffPng = new PNG({ width: compareWidth, height: compareHeight });

    const mismatchedPixels = pixelmatch(
      designPng.data,
      screenshotPng.data,
      diffPng.data,
      compareWidth,
      compareHeight,
      { threshold: 0.1, includeAA: false }
    );

    const totalPixels = compareWidth * compareHeight;
    const matchPercentage = ((totalPixels - mismatchedPixels) / totalPixels * 100).toFixed(2);
    const diffPercentage = (mismatchedPixels / totalPixels * 100).toFixed(2);

    console.log(`[Compare] Analysis complete. Match: ${matchPercentage}%, Diff: ${diffPercentage}%`);

    // Analyze differences by region
    const regions = analyzeRegions(diffPng.data, compareWidth, compareHeight);

    // Convert images to base64
    const diffBuffer = PNG.sync.write(diffPng);

    const result = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      timestamp: Date.now(),
      designImage: `data:image/png;base64,${designProcessed.toString('base64')}`,
      screenshotImage: `data:image/png;base64,${screenshotProcessed.toString('base64')}`,
      diffImage: `data:image/png;base64,${diffBuffer.toString('base64')}`,
      stats: {
        totalPixels,
        mismatchedPixels,
        matchPercentage: parseFloat(matchPercentage),
        diffPercentage: parseFloat(diffPercentage),
        viewport: { width: compareWidth, height: compareHeight },
        isFullPage
      },
      regions
    };

    // Store result for later retrieval
    resultsStore.set(result.id, result);

    res.json(result);

  } catch (error) {
    console.error('[Compare] Error:', error);

    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('[Compare] Error closing browser:', e);
      }
    }

    // Better error messages
    let errorMessage = error.message || 'An error occurred during comparison';

    if (error.message?.includes('net::ERR_NAME_NOT_RESOLVED')) {
      errorMessage = 'Could not resolve domain. Please check the URL.';
    } else if (error.message?.includes('net::ERR_CONNECTION_REFUSED')) {
      errorMessage = 'Connection refused. The server may be down.';
    } else if (error.message?.includes('net::ERR_CONNECTION_TIMED_OUT')) {
      errorMessage = 'Connection timed out. The server is too slow to respond.';
    } else if (error.message?.includes('Navigation timeout')) {
      errorMessage = 'Page took too long to load. Try a simpler page or check your connection.';
    } else if (error.message?.includes('net::ERR_CERT')) {
      errorMessage = 'SSL certificate error. The site may have an invalid certificate.';
    } else if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
      errorMessage = 'Authentication failed. Please check username and password.';
    }

    res.status(500).json({
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get stored result
app.get('/api/result/:id', (req, res) => {
  const result = resultsStore.get(req.params.id);
  if (!result) {
    return res.status(404).json({ error: 'Result not found or expired' });
  }
  res.json(result);
});

// CSS Inspector endpoint
app.post('/api/inspect', express.json(), async (req, res) => {
  let browser = null;

  try {
    const { url, username, password, selector } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`[Inspect] Starting CSS inspection for ${url}`);

    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ],
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Handle HTTP Basic Auth
    if (username && password) {
      await page.authenticate({ username, password });
    }

    // Navigate to URL
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for page to fully render
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract CSS information from all visible elements
    const cssData = await page.evaluate((targetSelector) => {
      const results = {
        typography: [],
        colors: [],
        spacing: [],
        elements: []
      };

      // Helper to get computed styles
      const getStyles = (el) => {
        const computed = window.getComputedStyle(el);
        return {
          fontFamily: computed.fontFamily,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          lineHeight: computed.lineHeight,
          letterSpacing: computed.letterSpacing,
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          marginTop: computed.marginTop,
          marginRight: computed.marginRight,
          marginBottom: computed.marginBottom,
          marginLeft: computed.marginLeft,
          paddingTop: computed.paddingTop,
          paddingRight: computed.paddingRight,
          paddingBottom: computed.paddingBottom,
          paddingLeft: computed.paddingLeft,
          width: computed.width,
          height: computed.height,
          display: computed.display,
          position: computed.position,
          borderRadius: computed.borderRadius
        };
      };

      // Get element selector path
      const getSelector = (el) => {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim().split(/\s+/).filter(c => c).slice(0, 2);
          if (classes.length) return `${el.tagName.toLowerCase()}.${classes.join('.')}`;
        }
        return el.tagName.toLowerCase();
      };

      // Get bounding rect
      const getPosition = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      };

      // Determine which elements to analyze
      let elements;
      if (targetSelector) {
        elements = document.querySelectorAll(targetSelector);
      } else {
        // Get important visible elements
        elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, button, span, div, section, header, footer, nav, img, input, label, li, td, th');
      }

      const fontMap = new Map();
      const colorMap = new Map();
      const spacingSet = new Set();

      elements.forEach((el, index) => {
        // Skip hidden elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (index > 200) return; // Limit to prevent overload

        const styles = getStyles(el);
        const selector = getSelector(el);
        const position = getPosition(el);
        const text = el.innerText?.substring(0, 50) || '';

        // Collect typography
        const fontKey = `${styles.fontFamily}|${styles.fontSize}|${styles.fontWeight}`;
        if (!fontMap.has(fontKey)) {
          fontMap.set(fontKey, {
            fontFamily: styles.fontFamily,
            fontSize: styles.fontSize,
            fontWeight: styles.fontWeight,
            lineHeight: styles.lineHeight,
            count: 0,
            examples: []
          });
        }
        const fontEntry = fontMap.get(fontKey);
        fontEntry.count++;
        if (fontEntry.examples.length < 3) {
          fontEntry.examples.push({ selector, text: text.substring(0, 30) });
        }

        // Collect colors
        const colorKey = styles.color;
        if (!colorMap.has(colorKey) && colorKey !== 'rgba(0, 0, 0, 0)') {
          colorMap.set(colorKey, { color: colorKey, count: 0, examples: [] });
        }
        if (colorMap.has(colorKey)) {
          const colorEntry = colorMap.get(colorKey);
          colorEntry.count++;
          if (colorEntry.examples.length < 3) {
            colorEntry.examples.push(selector);
          }
        }

        // Collect unique spacing values
        ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom'].forEach(prop => {
          const val = parseInt(styles[prop]);
          if (val > 0) spacingSet.add(val);
        });

        // Add to elements list (limit to important ones)
        if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BUTTON', 'A', 'IMG'].includes(el.tagName) ||
            (el.className && typeof el.className === 'string' && el.className.includes('title'))) {
          results.elements.push({
            tag: el.tagName.toLowerCase(),
            selector,
            text: text.substring(0, 50),
            position,
            styles: {
              fontFamily: styles.fontFamily?.split(',')[0]?.replace(/['"]/g, '').trim(),
              fontSize: styles.fontSize,
              fontWeight: styles.fontWeight,
              lineHeight: styles.lineHeight,
              color: styles.color,
              backgroundColor: styles.backgroundColor,
              margin: `${styles.marginTop} ${styles.marginRight} ${styles.marginBottom} ${styles.marginLeft}`,
              padding: `${styles.paddingTop} ${styles.paddingRight} ${styles.paddingBottom} ${styles.paddingLeft}`
            }
          });
        }
      });

      // Convert maps to arrays
      results.typography = Array.from(fontMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      results.colors = Array.from(colorMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      results.spacing = Array.from(spacingSet).sort((a, b) => a - b);

      return results;
    }, selector);

    await browser.close();
    browser = null;

    console.log(`[Inspect] Found ${cssData.typography.length} font styles, ${cssData.colors.length} colors, ${cssData.elements.length} elements`);

    res.json({
      url,
      timestamp: Date.now(),
      ...cssData
    });

  } catch (error) {
    console.error('[Inspect] Error:', error);

    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('[Inspect] Error closing browser:', e);
      }
    }

    res.status(500).json({
      error: error.message || 'An error occurred during inspection'
    });
  }
});

// Analyze regions of difference
function analyzeRegions(diffData, width, height) {
  const gridSize = 4; // Divide into 4x4 grid
  const cellWidth = Math.floor(width / gridSize);
  const cellHeight = Math.floor(height / gridSize);
  const regions = [];

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let diffCount = 0;
      const startX = gx * cellWidth;
      const startY = gy * cellHeight;
      const endX = Math.min(startX + cellWidth, width);
      const endY = Math.min(startY + cellHeight, height);
      const cellPixels = (endX - startX) * (endY - startY);

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * width + x) * 4;
          // Check if pixel is red (difference marker in pixelmatch)
          if (diffData[idx] > 200 && diffData[idx + 1] < 100 && diffData[idx + 2] < 100) {
            diffCount++;
          }
        }
      }

      const diffPercent = (diffCount / cellPixels * 100).toFixed(1);

      regions.push({
        position: getRegionName(gx, gy),
        x: startX,
        y: startY,
        width: endX - startX,
        height: endY - startY,
        diffPixels: diffCount,
        diffPercent: parseFloat(diffPercent),
        severity: getSeverity(diffPercent)
      });
    }
  }

  return regions.sort((a, b) => b.diffPercent - a.diffPercent);
}

function getRegionName(gx, gy) {
  const vertical = ['Top', 'Upper-middle', 'Lower-middle', 'Bottom'][gy];
  const horizontal = ['Left', 'Center-left', 'Center-right', 'Right'][gx];
  return `${vertical} ${horizontal}`;
}

function getSeverity(diffPercent) {
  if (diffPercent < 1) return 'none';
  if (diffPercent < 5) return 'low';
  if (diffPercent < 15) return 'medium';
  return 'high';
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('[Error]', error);
  res.status(500).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`[Server] Perfect Pixel Check API running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
});
