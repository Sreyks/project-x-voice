const chat = document.getElementById('chat');
const emptyHint = document.getElementById('emptyHint');
const statusEl = document.getElementById('status');
const inputBar = document.querySelector('.input-bar');
const textInput = document.getElementById('textInput');
const recTimerEl = document.getElementById('recTimer');
const attachBtn = document.getElementById('attachBtn');
const micBtn = document.getElementById('micBtn');
const sendBtn = document.getElementById('sendBtn');
const recStopBtn = document.getElementById('recStopBtn');
const recSendBtn = document.getElementById('recSendBtn');

const CHUNK_MS = 4000;

let stream = null;
let mediaRecorder = null;
let audioChunks = [];
let recording = false;
let stopping = false;
let stopAction = 'review'; // 'review' -> fill input, 'send' -> send immediately
let recStartedAt = 0;
let recTimerInterval = null;
let chunkTimer = null;
let collectedText = '';

function setStatus(text) {
    statusEl.textContent = text || '';
}

function formatSeconds(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function pickMimeType() {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
    ];
    for (const type of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }
    return '';
}

function updateHasText() {
    inputBar.classList.toggle('has-text', textInput.value.trim().length > 0);
}

let aiHintShown = false;

function addMessage(text, sender) {
    if (!text) return null;
    emptyHint.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = sender === 'ai' ? 'msg ai' : 'msg';
    bubble.textContent = text;

    const time = document.createElement('span');
    time.className = 'msg-time';
    const now = new Date();
    time.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    bubble.appendChild(time);

    bubble.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (err) {
            const range = document.createRange();
            range.selectNodeContents(bubble);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
        bubble.classList.add('copied');
        setTimeout(() => bubble.classList.remove('copied'), 1200);
    });

    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
}

async function askAI(userText) {
    const typingBubble = document.createElement('div');
    typingBubble.className = 'msg ai typing';
    typingBubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    chat.appendChild(typingBubble);
    chat.scrollTop = chat.scrollHeight;

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: userText }),
        });
        const data = await res.json();
        typingBubble.remove();

        if (data.error === 'no_key') {
            if (!aiHintShown) {
                aiHintShown = true;
                setStatus('ИИ-ответы выключены — не задан GEMINI_API_KEY');
            }
            return;
        }
        if (data.reply) {
            addMessage(data.reply, 'ai');
        } else if (data.error) {
            addMessage('Ошибка ИИ: ' + data.error, 'ai');
        }
    } catch (err) {
        typingBubble.remove();
        addMessage('Не удалось связаться с ИИ: ' + err.message, 'ai');
    }
}

function sendCurrentText() {
    const text = textInput.value.trim();
    if (!text) return;
    addMessage(text);
    textInput.value = '';
    updateHasText();
    setStatus('');
    askAI(text);
}

async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('Браузер не поддерживает запись микрофона. Открой сайт в Chrome.');
        return;
    }
    if (!window.MediaRecorder) {
        setStatus('Браузер не поддерживает MediaRecorder. Открой сайт в Chrome.');
        return;
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        setStatus('Доступ к микрофону запрещён. Разреши микрофон в настройках браузера.');
        return;
    }

    recording = true;
    stopping = false;
    collectedText = '';
    recStartedAt = Date.now();
    inputBar.classList.add('recording');
    recTimerEl.textContent = '0:00';
    recTimerInterval = setInterval(() => {
        const secs = Math.floor((Date.now() - recStartedAt) / 1000);
        recTimerEl.textContent = formatSeconds(secs);
    }, 250);

    startChunk();
}

function startChunk() {
    if (!recording) return;

    const mimeType = pickMimeType();
    try {
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
        setStatus('Не удалось запустить запись: ' + err.message);
        finishRecordingUI();
        return;
    }

    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onerror = (e) => {
        setStatus('Ошибка записи: ' + (e.error ? e.error.message : 'неизвестно'));
    };
    mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const isLastChunk = stopping;

        if (isLastChunk) {
            if (stream) {
                stream.getTracks().forEach((t) => t.stop());
                stream = null;
            }
        }

        if (blob.size > 800) {
            transcribeChunk(blob, isLastChunk);
        } else if (isLastChunk) {
            finishRecordingUI();
        }

        if (!isLastChunk && recording) {
            startChunk();
        }
    };

    mediaRecorder.start();
    clearTimeout(chunkTimer);
    chunkTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    }, CHUNK_MS);
}

function stopRecording(action) {
    if (!recording) return;
    recording = false;
    stopping = true;
    stopAction = action;
    clearTimeout(chunkTimer);
    clearInterval(recTimerInterval);
    micBtn.classList.add('analyzing');
    recStopBtn.disabled = true;
    recSendBtn.disabled = true;
    setStatus('Анализирую...');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    } else if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        finishRecordingUI();
    }
}

function finishRecordingUI() {
    inputBar.classList.remove('recording');
    micBtn.classList.remove('analyzing');
    recStopBtn.disabled = false;
    recSendBtn.disabled = false;
    clearInterval(recTimerInterval);
    recTimerInterval = null;
}

async function transcribeChunk(blob, isLastChunk) {
    try {
        const formData = new FormData();
        formData.append('audio', blob, 'chunk.webm');
        const res = await fetch('/transcribe', { method: 'POST', body: formData });
        if (!res.ok) {
            throw new Error('Сервер вернул ошибку ' + res.status);
        }
        const data = await res.json();
        if (data.text) {
            collectedText = collectedText ? collectedText + ' ' + data.text : data.text;
        }
    } catch (err) {
        setStatus('Ошибка соединения с сервером: ' + err.message);
    } finally {
        if (isLastChunk) {
            finishRecordingUI();
            if (collectedText) {
                if (stopAction === 'send') {
                    const combined = textInput.value.trim()
                        ? textInput.value.trim() + ' ' + collectedText
                        : collectedText;
                    addMessage(combined);
                    askAI(combined);
                    textInput.value = '';
                } else {
                    textInput.value = textInput.value
                        ? textInput.value.trim() + ' ' + collectedText
                        : collectedText;
                    textInput.focus();
                }
                updateHasText();
                setStatus('');
            } else {
                setStatus('Не расслышал. Попробуй ещё раз, говори чётче и ближе к микрофону.');
            }
        }
    }
}

micBtn.addEventListener('click', () => {
    startRecording();
});

recStopBtn.addEventListener('click', () => {
    stopRecording('review');
});

recSendBtn.addEventListener('click', () => {
    stopRecording('send');
});

sendBtn.addEventListener('click', sendCurrentText);

textInput.addEventListener('input', updateHasText);
textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendCurrentText();
    }
});

attachBtn.addEventListener('click', () => {
    setStatus('Прикрепление файлов скоро появится');
    setTimeout(() => setStatus(''), 2000);
});

document.getElementById('clearBtn').addEventListener('click', () => {
    chat.innerHTML = '';
    chat.appendChild(emptyHint);
    emptyHint.style.display = 'block';
});
