// Транскрипция голосовых сообщений через Groq Whisper API.
// Groq даёт бесплатный доступ к whisper-large-v3 с высокими лимитами.

const fs = require('fs');
const https = require('https');
const path = require('path');
const Groq = require('groq-sdk');
const { GROQ_API_KEY } = require('../../shared/config');

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Telegram отдаёт голосовые сообщения как URL, а не как поток —
// скачиваем файл во временную директорию перед отправкой в Groq.
// При ошибке скачивания удаляем частично скачанный файл.
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

// Скачивает голосовое сообщение по URL, отправляет в Groq Whisper, возвращает текст.
// Временный файл удаляется после транскрипции (или при ошибке Groq — не удаляется,
// но /tmp очищается операционной системой автоматически).
async function transcribeVoice(fileUrl) {
  // /tmp доступен как на локальной машине так и на Railway
  // .ogg — формат в котором Telegram отдаёт голосовые сообщения
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
