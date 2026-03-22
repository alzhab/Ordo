const fs = require('fs');
const https = require('https');
const path = require('path');
const Groq = require('groq-sdk');
const { GROQ_API_KEY } = require('./config');

const groq = new Groq({ apiKey: GROQ_API_KEY });

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function transcribeVoice(fileUrl) {
  const tmpPath = path.join('/tmp', `voice_${Date.now()}.ogg`);

  await downloadFile(fileUrl, tmpPath);

  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(tmpPath),
    model: 'whisper-large-v3',
    language: 'ru',
  });

  fs.unlink(tmpPath, () => {});

  return transcription.text;
}

module.exports = { transcribeVoice };
