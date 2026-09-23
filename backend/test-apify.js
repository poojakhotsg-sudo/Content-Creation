require('dotenv').config();
const axios = require('axios');

async function testApify() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    console.log('No APIFY_API_TOKEN found');
    return;
  }
  console.log('Token starts with:', token.substring(0, 5));
  
  try {
    const response = await axios.post(
      `https://api.apify.com/v2/acts/crawlerbros~instagram-transcript-scraper/run-sync-get-dataset-items?token=${token}`,
      { reelsUrls: ['https://www.instagram.com/reel/C-a5_6MIf8o/'] },
      { timeout: 30000 }
    );
    console.log('Success! Apify is working.');
    console.log('Response data length:', response.data.length);
  } catch (error) {
    console.error('Apify error:', error.response ? error.response.data : error.message);
  }
}

testApify();
