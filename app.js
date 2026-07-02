const BOOK_URL = "assets/book.txt";
const STORAGE_KEY = "summerwork-reader-state-v1";
const BOOK_CACHE_KEY = "summerwork-book-text-v1";
const VOICE_ENDPOINT = window.VOICE_CLONE_ENDPOINT || "";
const AUDIO_TRACKS = [
  { file: "assets/audio/chapter-01.mp3", duration: 2700.024 },
  { file: "assets/audio/chapter-02.mp3", duration: 2687.664 },
  { file: "assets/audio/chapter-03.mp3", duration: 2700.024 },
  { file: "assets/audio/chapter-04.mp3", duration: 2781.192 },
  { file: "assets/audio/chapter-05.mp3", duration: 2700.024 },
  { file: "assets/audio/chapter-06.mp3", duration: 2397.264 },
];

const state = {
  chunks: [],
  index: 0,
  speaking: false,
  voices: [],
  voiceName: "",
  rate: 1,
  recorder: null,
  recordedParts: [],
  recordedBlob: null,
  speechToken: 0,
  lastSpeechStart: 0,
  queuedCount: 0,
  queueNextIndex: 0,
  audioTrackIndex: 0,
  audioTime: 0,
  audioMode: true,
};

const $ = (id) => document.getElementById(id);
const elements = {
  listenButton: $("listenButton"), listenLabel: $("listenLabel"), listenIcon: $("listenIcon"),
  voiceButton: $("voiceButton"), voiceDialog: $("voiceDialog"), voiceSelect: $("voiceSelect"),
  previewButton: $("previewButton"), rateSelect: $("rateSelect"), restartButton: $("restartButton"),
  playerTitle: $("player-title"), excerpt: $("excerpt"), progressFill: $("progressFill"),
  progressText: $("progressText"), progressTrack: document.querySelector("[role=progressbar]"),
  systemTab: $("systemTab"), customTab: $("customTab"), systemPanel: $("systemPanel"), customPanel: $("customPanel"),
  consentCheck: $("consentCheck"), recordButton: $("recordButton"), recordStatus: $("recordStatus"),
  recordPulse: $("recordPulse"), recordPreview: $("recordPreview"), createVoiceButton: $("createVoiceButton"),
  cloneNotice: $("cloneNotice"), toast: $("toast")
};
elements.bookAudio = $("bookAudio");

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.index = Number.isInteger(saved.index) ? saved.index : 0;
    state.voiceName = saved.voiceName || "";
    state.rate = Number(saved.rate) || 1;
    state.audioTrackIndex = Math.min(Number(saved.audioTrackIndex) || 0, AUDIO_TRACKS.length - 1);
    state.audioTime = Number(saved.audioTime) || 0;
    elements.rateSelect.value = String(state.rate);
  } catch { /* Ignore invalid local state. */ }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    index: state.index,
    voiceName: state.voiceName,
    rate: state.rate,
    audioTrackIndex: state.audioTrackIndex,
    audioTime: elements.bookAudio.currentTime || state.audioTime,
  }));
}

function loadAudioTrack(restoreTime = 0) {
  const track = AUDIO_TRACKS[state.audioTrackIndex];
  elements.bookAudio.src = track.file;
  elements.bookAudio.playbackRate = state.rate;
  elements.bookAudio.addEventListener("loadedmetadata", () => {
    if (restoreTime > 0 && restoreTime < elements.bookAudio.duration) elements.bookAudio.currentTime = restoreTime;
    updateAudioProgress();
  }, { once: true });
}

function updateAudioProgress() {
  const total = AUDIO_TRACKS.reduce((sum, track) => sum + track.duration, 0);
  const completed = AUDIO_TRACKS.slice(0, state.audioTrackIndex).reduce((sum, track) => sum + track.duration, 0);
  const current = Number.isFinite(elements.bookAudio.currentTime) ? elements.bookAudio.currentTime : state.audioTime;
  const percent = Math.min(100, Math.round(((completed + current) / total) * 100));
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(percent));
  elements.excerpt.textContent = `普通话有声书 · 第 ${state.audioTrackIndex + 1} 部分，共 ${AUDIO_TRACKS.length} 部分`;
}

async function startAudio() {
  state.speaking = true;
  elements.bookAudio.playbackRate = state.rate;
  try {
    await elements.bookAudio.play();
    elements.listenLabel.textContent = "暂停听读";
    elements.listenIcon.textContent = "❚❚";
    elements.playerTitle.textContent = "正在播放普通话有声书";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  } catch {
    state.speaking = false;
    toast("请再次点击播放按钮开始听读");
  }
}

function pauseAudio() {
  state.speaking = false;
  elements.bookAudio.pause();
  state.audioTime = elements.bookAudio.currentTime;
  saveState();
  elements.listenLabel.textContent = "继续听读";
  elements.listenIcon.textContent = "▶";
  elements.playerTitle.textContent = "已保存当前位置";
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

function restartAudio() {
  elements.bookAudio.pause();
  state.audioTrackIndex = 0;
  state.audioTime = 0;
  state.speaking = false;
  loadAudioTrack(0);
  updateAudioProgress();
  saveState();
  elements.listenLabel.textContent = "语音听读";
  elements.listenIcon.textContent = "▶";
  toast("已回到开头");
}

function splitForSpeech(text) {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const sentences = clean.match(/[^。！？!?；;\n]+[。！？!?；;]?|\n/g) || [clean];
  const chunks = [];
  let buffer = "";
  for (const sentence of sentences) {
    const part = sentence.trim();
    if (!part) continue;
    if ((buffer + part).length > 70 && buffer) {
      chunks.push(buffer);
      buffer = part;
    } else {
      buffer += part;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

async function loadBook() {
  try {
    let bookText = localStorage.getItem(BOOK_CACHE_KEY);
    if (!bookText) {
      if (window.BOOK_GZIP_BASE64 && "DecompressionStream" in window) {
        const binary = atob(window.BOOK_GZIP_BASE64);
        const compressed = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
        bookText = await new Response(stream).text();
      } else {
        const response = await fetch(BOOK_URL);
        if (!response.ok) throw new Error("book response failed");
        bookText = await response.text();
      }
      try { localStorage.setItem(BOOK_CACHE_KEY, bookText); } catch { /* Storage may be unavailable. */ }
    }
    state.chunks = splitForSpeech(bookText);
    state.index = Math.min(state.index, Math.max(0, state.chunks.length - 1));
    elements.listenButton.disabled = false;
    elements.playerTitle.textContent = state.index ? "继续上次的阅读" : "从序言开始";
    updateProgress();
  } catch (error) {
    elements.playerTitle.textContent = "书籍载入失败";
    elements.excerpt.textContent = "请确认 assets/book.docx 与页面位于同一站点，并保持网络连接后刷新。";
  }
}

function updateProgress() {
  if (!state.chunks.length) return;
  const percent = Math.round((state.index / state.chunks.length) * 100);
  elements.progressFill.style.width = `${percent}%`;
  elements.progressText.textContent = `${percent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(percent));
  elements.excerpt.textContent = state.chunks[state.index] || "已读完这本书。";
}

function selectedVoice() {
  return state.voices.find((voice) => voice.name === state.voiceName) || state.voices.find((voice) => voice.lang.startsWith("zh")) || state.voices[0];
}

function queueSpeech() {
  if (!state.speaking) return;
  const token = state.speechToken;
  while (state.queuedCount < 3 && state.queueNextIndex < state.chunks.length) {
    const chunkIndex = state.queueNextIndex++;
    const utterance = new SpeechSynthesisUtterance(state.chunks[chunkIndex]);
    const voice = selectedVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || "zh-CN";
    utterance.rate = state.rate;
    state.queuedCount += 1;
    state.lastSpeechStart = Date.now();
    utterance.onend = () => {
      if (!state.speaking || token !== state.speechToken) return;
      state.queuedCount -= 1;
      state.index = chunkIndex + 1;
      saveState();
      updateProgress();
      if (state.index >= state.chunks.length && state.queuedCount === 0) {
        state.speaking = false;
        elements.listenLabel.textContent = "重新听读";
        elements.listenIcon.textContent = "▶";
        elements.playerTitle.textContent = "已读完这本书";
        toast("这本书已经读完啦");
        return;
      }
      queueSpeech();
    };
    utterance.onerror = (event) => {
      if (token !== state.speechToken || event.error === "canceled" || event.error === "interrupted") return;
      recoverSpeechQueue();
    };
    speechSynthesis.speak(utterance);
  }
}

function recoverSpeechQueue() {
  if (!state.speaking) return;
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.queuedCount = 0;
  state.queueNextIndex = state.index;
  setTimeout(queueSpeech, 250);
}

function startSpeaking() {
  speechSynthesis.cancel();
  if (state.index >= state.chunks.length) state.index = 0;
  state.speaking = true;
  state.speechToken += 1;
  state.queuedCount = 0;
  state.queueNextIndex = state.index;
  elements.listenLabel.textContent = "暂停听读";
  elements.listenIcon.textContent = "❚❚";
  elements.playerTitle.textContent = "正在为你朗读";
  queueSpeech();
}

function stopSpeaking(label = "继续听读") {
  state.speaking = false;
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.queuedCount = 0;
  state.queueNextIndex = state.index;
  saveState();
  elements.listenLabel.textContent = label;
  elements.listenIcon.textContent = "▶";
  elements.playerTitle.textContent = "已保存当前位置";
}

function populateVoices() {
  state.voices = speechSynthesis.getVoices();
  const sorted = [...state.voices].sort((a, b) => Number(b.lang.startsWith("zh")) - Number(a.lang.startsWith("zh")) || a.name.localeCompare(b.name));
  elements.voiceSelect.innerHTML = "";
  sorted.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} · ${voice.lang}${voice.default ? "（默认）" : ""}`;
    elements.voiceSelect.append(option);
  });
  if (!state.voiceName || !state.voices.some((v) => v.name === state.voiceName)) {
    state.voiceName = sorted.find((v) => v.lang.startsWith("zh"))?.name || sorted[0]?.name || "";
  }
  elements.voiceSelect.value = state.voiceName;
}

function switchTab(custom) {
  elements.systemTab.classList.toggle("active", !custom);
  elements.customTab.classList.toggle("active", custom);
  elements.systemTab.setAttribute("aria-selected", String(!custom));
  elements.customTab.setAttribute("aria-selected", String(custom));
  elements.systemPanel.hidden = custom;
  elements.customPanel.hidden = !custom;
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordedParts = [];
    state.recorder = new MediaRecorder(stream);
    state.recorder.ondataavailable = (event) => event.data.size && state.recordedParts.push(event.data);
    state.recorder.onstop = () => {
      state.recordedBlob = new Blob(state.recordedParts, { type: state.recorder.mimeType });
      elements.recordPreview.src = URL.createObjectURL(state.recordedBlob);
      elements.recordPreview.hidden = false;
      elements.createVoiceButton.disabled = false;
      elements.recordButton.textContent = "重新录制";
      elements.recordStatus.innerHTML = "<strong>录制完成</strong><br>请试听并确认声音清楚。";
      elements.recordPulse.classList.remove("active");
      stream.getTracks().forEach((track) => track.stop());
    };
    state.recorder.start();
    elements.recordButton.textContent = "停止录制";
    elements.recordStatus.innerHTML = "<strong>正在录制…</strong><br>请自然、连续地朗读示例文字。";
    elements.recordPulse.classList.add("active");
  } catch {
    toast("需要允许麦克风权限才能录音");
  }
}

async function createCustomVoice() {
  if (!state.recordedBlob || !elements.consentCheck.checked) return;
  if (!VOICE_ENDPOINT) {
    elements.cloneNotice.textContent = "录音已准备好。请先配置合规的语音克隆服务接口，生成按钮才会提交录音；当前不会上传。";
    toast("录音已保留在当前页面，尚未上传");
    return;
  }
  const body = new FormData();
  body.append("audio", state.recordedBlob, "my-voice.webm");
  body.append("consent", "self-voice-confirmed");
  elements.createVoiceButton.disabled = true;
  elements.createVoiceButton.textContent = "正在生成…";
  try {
    const response = await fetch(VOICE_ENDPOINT, { method: "POST", body });
    if (!response.ok) throw new Error("clone failed");
    const result = await response.json();
    localStorage.setItem("summerwork-custom-voice-id", result.voiceId || "");
    elements.cloneNotice.textContent = "专属音色已生成。要用于整本听读，接口还需提供音频合成地址。";
    toast("专属音色生成成功");
  } catch {
    toast("音色服务暂时不可用，请稍后再试");
  } finally {
    elements.createVoiceButton.disabled = false;
    elements.createVoiceButton.textContent = "生成我的音色";
  }
}

restoreState();
populateVoices();
speechSynthesis.onvoiceschanged = populateVoices;

loadAudioTrack(state.audioTime);
elements.listenButton.disabled = false;
elements.playerTitle.textContent = state.audioTime || state.audioTrackIndex ? "继续上次的阅读" : "普通话有声书已准备好";
updateAudioProgress();

if ("mediaSession" in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({ title: "为谁辛苦为谁忙", artist: "刘志雄", album: "清风书房" });
  navigator.mediaSession.setActionHandler("play", startAudio);
  navigator.mediaSession.setActionHandler("pause", pauseAudio);
}

elements.listenButton.addEventListener("click", () => state.speaking ? pauseAudio() : startAudio());
elements.voiceButton.addEventListener("click", () => toast("当前使用内置普通话音频"));
elements.voiceSelect.addEventListener("change", () => { state.voiceName = elements.voiceSelect.value; saveState(); });
elements.rateSelect.addEventListener("change", () => { state.rate = Number(elements.rateSelect.value); elements.bookAudio.playbackRate = state.rate; saveState(); });
elements.previewButton.addEventListener("click", () => {
  speechSynthesis.cancel();
  const sample = new SpeechSynthesisUtterance("你好，愿这段声音陪你安静地读完一本好书。清风书房，正在为你朗读。");
  const voice = selectedVoice();
  if (voice) sample.voice = voice;
  sample.rate = state.rate;
  speechSynthesis.speak(sample);
});
elements.restartButton.addEventListener("click", restartAudio);
elements.systemTab.addEventListener("click", () => switchTab(false));
elements.customTab.addEventListener("click", () => switchTab(true));
elements.consentCheck.addEventListener("change", () => { elements.recordButton.disabled = !elements.consentCheck.checked; });
elements.recordButton.addEventListener("click", toggleRecording);
elements.createVoiceButton.addEventListener("click", createCustomVoice);
elements.voiceDialog.addEventListener("close", () => { if (state.recorder?.state === "recording") state.recorder.stop(); });
elements.bookAudio.addEventListener("timeupdate", () => {
  state.audioTime = elements.bookAudio.currentTime;
  updateAudioProgress();
  if (Math.floor(state.audioTime) % 5 === 0) saveState();
});
elements.bookAudio.addEventListener("ended", async () => {
  state.audioTrackIndex += 1;
  state.audioTime = 0;
  if (state.audioTrackIndex >= AUDIO_TRACKS.length) {
    state.audioTrackIndex = AUDIO_TRACKS.length - 1;
    state.speaking = false;
    elements.listenLabel.textContent = "重新听读";
    elements.listenIcon.textContent = "▶";
    elements.playerTitle.textContent = "已读完这本书";
    saveState();
    return;
  }
  loadAudioTrack(0);
  saveState();
  await startAudio();
});
window.addEventListener("beforeunload", () => { saveState(); speechSynthesis.cancel(); });

// Edge/Chrome can occasionally leave SpeechSynthesis idle after an utterance.
// As long as the listener has not pressed pause, revive it automatically.
setInterval(() => {
  if (state.audioMode || !state.speaking || document.hidden) return;
  if (!speechSynthesis.speaking && !speechSynthesis.pending && Date.now() - state.lastSpeechStart > 1200) {
    recoverSpeechQueue();
  } else if (speechSynthesis.paused) {
    speechSynthesis.resume();
  }
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (!state.audioMode && !document.hidden && state.speaking && !speechSynthesis.speaking) {
    recoverSpeechQueue();
  }
});
