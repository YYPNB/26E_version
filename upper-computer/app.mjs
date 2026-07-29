import {
  buildRecordingName,
  formatBytes,
  formatDuration,
  normalizeDeviceAddress,
  selectRecordingMime,
} from "./core.mjs";

const elements = Object.fromEntries(
  [
    "connectionState", "connectionText", "resolutionMetric", "fpsMetric", "latencyMetric",
    "remoteVideo", "liveCanvas", "emptyState", "recordBadge", "recordClock", "stage",
    "fullscreenButton", "deviceAddress", "connectButton", "testName", "durationValue",
    "sizeValue", "startTestButton", "stopTestButton", "recordHint", "recordingList",
    "openVideoButton", "playbackDialog", "playbackTitle", "playbackVideo", "playbackRate",
    "closePlaybackButton", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

const context = elements.liveCanvas.getContext("2d", { alpha: false, desynchronized: true });
const state = {
  websocket: null,
  peer: null,
  connected: false,
  manualDisconnect: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  statsTimer: null,
  lastStats: null,
  renderFrame: null,
  recorder: null,
  writable: null,
  writeChain: Promise.resolve(),
  recordingChunks: [],
  recordingBytes: 0,
  recordingStartedAt: 0,
  recordingTimer: null,
  activeRecording: null,
  playbackUrl: null,
};

initialize();

async function initialize() {
  elements.deviceAddress.value = localStorage.getItem("maixcam-address") || "";
  elements.testName.value = suggestedTestName();
  bindEvents();
  startCanvasRenderer();
  await renderRecordingLibrary();

  if (!window.RTCPeerConnection || !window.MediaRecorder) {
    setStatus("error", "浏览器不支持 WebRTC/录像");
    elements.connectButton.disabled = true;
    showToast("请使用最新版 Microsoft Edge 或 Google Chrome");
  }
}

function bindEvents() {
  elements.connectButton.addEventListener("click", () => {
    if (state.websocket || state.peer) disconnectDevice(true);
    else connectDevice();
  });
  elements.deviceAddress.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connectDevice();
  });
  elements.startTestButton.addEventListener("click", startRecording);
  elements.stopTestButton.addEventListener("click", () => stopRecording("测试已结束，录像已保存"));
  elements.fullscreenButton.addEventListener("click", () => elements.stage.requestFullscreen?.());
  elements.openVideoButton.addEventListener("click", openExternalVideo);
  elements.closePlaybackButton.addEventListener("click", closePlayback);
  elements.playbackDialog.addEventListener("close", closePlayback);
  elements.playbackRate.addEventListener("change", () => {
    elements.playbackVideo.playbackRate = Number(elements.playbackRate.value);
  });
  document.querySelectorAll("[data-skip]").forEach((button) => {
    button.addEventListener("click", () => {
      const duration = Number.isFinite(elements.playbackVideo.duration) ? elements.playbackVideo.duration : Infinity;
      elements.playbackVideo.currentTime = Math.max(
        0,
        Math.min(duration, elements.playbackVideo.currentTime + Number(button.dataset.skip)),
      );
    });
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.recorder?.state === "recording") {
      event.preventDefault();
      event.returnValue = "正在录像，离开会中断本次测试记录。";
    }
  });
}

async function connectDevice() {
  let target;
  try {
    target = normalizeDeviceAddress(elements.deviceAddress.value);
  } catch (error) {
    showToast(error.message);
    return;
  }

  localStorage.setItem("maixcam-address", elements.deviceAddress.value.trim());
  clearTimeout(state.reconnectTimer);
  closeTransport();
  state.manualDisconnect = false;
  setStatus("working", state.reconnectAttempt ? `正在重连 (${state.reconnectAttempt})` : "正在连接");
  elements.connectButton.textContent = "断开连接";

  const websocket = new WebSocket(target.websocketUrl);
  state.websocket = websocket;

  websocket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    websocket.send(JSON.stringify({ id: "server", type: "request" }));
    setStatus("working", "正在协商视频");
  });

  websocket.addEventListener("message", async (event) => {
    if (state.websocket !== websocket || typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === "offer") await acceptOffer(message, websocket);
    } catch (error) {
      console.error(error);
      showToast(`视频协商失败：${error.message}`);
      scheduleReconnect();
    }
  });

  websocket.addEventListener("close", () => {
    if (state.websocket === websocket) scheduleReconnect();
  });
  websocket.addEventListener("error", () => {
    if (state.websocket === websocket) setStatus("error", "设备连接失败");
  });
}

async function acceptOffer(offer, websocket) {
  state.peer?.close();
  const peer = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [] });
  state.peer = peer;

  peer.addEventListener("track", async (event) => {
    if (state.peer !== peer) return;
    elements.remoteVideo.srcObject = event.streams[0] || new MediaStream([event.track]);
    try { await elements.remoteVideo.play(); } catch { /* Muted autoplay is normally allowed. */ }
    state.connected = true;
    elements.emptyState.classList.add("hidden");
    elements.startTestButton.disabled = false;
    setStatus("online", "视频已连接");
    startStats(peer);
  });

  peer.addEventListener("connectionstatechange", () => {
    if (state.peer !== peer) return;
    if (peer.connectionState === "connected") {
      state.connected = true;
      setStatus("online", "视频已连接");
    } else if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
      state.connected = false;
      elements.startTestButton.disabled = true;
      scheduleReconnect();
    }
  });

  peer.addEventListener("datachannel", (event) => {
    event.channel.addEventListener("message", () => {});
  });

  await peer.setRemoteDescription({ type: "offer", sdp: offer.sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  await waitForIceGathering(peer, 5000);
  if (state.peer === peer && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ id: "server", type: "answer", sdp: peer.localDescription.sdp }));
  }
}

function scheduleReconnect() {
  if (state.manualDisconnect || state.reconnectTimer) return;
  state.connected = false;
  elements.startTestButton.disabled = true;
  stopStats();
  state.reconnectAttempt += 1;
  const delay = Math.min(8000, 1000 * (2 ** Math.min(state.reconnectAttempt - 1, 3)));
  setStatus("working", `视频中断，${Math.round(delay / 1000)} 秒后重连`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectDevice();
  }, delay);
}

function disconnectDevice(manual = false) {
  state.manualDisconnect = manual;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  closeTransport();
  state.connected = false;
  elements.startTestButton.disabled = true;
  elements.connectButton.textContent = "连接设备";
  setStatus("offline", "未连接");
}

function closeTransport() {
  stopStats();
  const websocket = state.websocket;
  const peer = state.peer;
  state.websocket = null;
  state.peer = null;
  if (websocket && websocket.readyState < WebSocket.CLOSING) websocket.close();
  peer?.close();
  elements.remoteVideo.srcObject = null;
}

function startCanvasRenderer() {
  let previousFrameAt = performance.now();
  let displayedFrames = 0;
  let fpsWindowAt = previousFrameAt;

  const draw = (now) => {
    const video = elements.remoteVideo;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      if (elements.liveCanvas.width !== video.videoWidth || elements.liveCanvas.height !== video.videoHeight) {
        elements.liveCanvas.width = video.videoWidth;
        elements.liveCanvas.height = video.videoHeight;
        elements.resolutionMetric.textContent = `${video.videoWidth} × ${video.videoHeight}`;
      }
      context.drawImage(video, 0, 0, elements.liveCanvas.width, elements.liveCanvas.height);
      if (!state.connected && state.recordingStartedAt) drawSignalLossOverlay();
      displayedFrames += 1;
      previousFrameAt = now;
    } else if (state.recordingStartedAt && !state.connected) {
      drawSignalLossOverlay(true);
    } else if (now - previousFrameAt > 1500) {
      elements.emptyState.classList.remove("hidden");
    }

    if (now - fpsWindowAt >= 1000) {
      elements.fpsMetric.textContent = `${Math.round(displayedFrames * 1000 / (now - fpsWindowAt))} FPS`;
      displayedFrames = 0;
      fpsWindowAt = now;
    }
    state.renderFrame = requestAnimationFrame(draw);
  };
  state.renderFrame = requestAnimationFrame(draw);
}

function drawSignalLossOverlay(clearFrame = false) {
  const width = elements.liveCanvas.width;
  const height = elements.liveCanvas.height;
  context.save();
  context.fillStyle = clearFrame ? "#05090a" : "rgba(0, 0, 0, 0.58)";
  context.fillRect(0, 0, width, height);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffcc66";
  context.font = `700 ${Math.max(14, Math.round(height * 0.09))}px sans-serif`;
  context.fillText("VIDEO LOST - RECONNECTING", width / 2, height / 2 - height * 0.06);
  context.fillStyle = "#d8e2e5";
  context.font = `${Math.max(11, Math.round(height * 0.06))}px monospace`;
  context.fillText(`TEST ${formatDuration(Date.now() - state.recordingStartedAt)}`, width / 2, height / 2 + height * 0.1);
  context.restore();
}

async function startRecording() {
  if (!state.connected || state.recorder) return;

  const filename = buildRecordingName(elements.testName.value);
  let fileHandle = null;
  let writable = null;
  const supportsDirectWrite = "showSaveFilePicker" in window;

  try {
    if (supportsDirectWrite) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "WebM 测试录像", accept: { "video/webm": [".webm"] } }],
      });
      writable = await fileHandle.createWritable();
    } else {
      const accepted = window.confirm("当前浏览器不支持录像直接写盘，将在结束时下载文件。长时间录像会占用较多内存，建议改用最新版 Edge 或 Chrome。是否继续？");
      if (!accepted) return;
    }

    const stream = elements.liveCanvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = "motion";
    const mimeType = selectRecordingMime();
    const options = { videoBitsPerSecond: 2_000_000 };
    if (mimeType) options.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, options);

    state.recorder = recorder;
    state.writable = writable;
    state.writeChain = Promise.resolve();
    state.recordingChunks = [];
    state.recordingBytes = 0;
    state.recordingStartedAt = Date.now();
    state.activeRecording = {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      name: elements.testName.value.trim() || "未命名测试",
      filename,
      startedAt: new Date().toISOString(),
      fileHandle,
      direct: Boolean(writable),
    };

    recorder.addEventListener("dataavailable", (event) => queueRecordingChunk(event.data));
    recorder.addEventListener("error", (event) => {
      console.error(event.error);
      showToast(`录像发生错误：${event.error?.message || "未知错误"}`);
      stopRecording("录像异常终止");
    });
    recorder.start(1000);
    setRecordingUi(true);
    updateRecordingMetrics();
    state.recordingTimer = setInterval(updateRecordingMetrics, 250);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (error.name !== "AbortError") showToast(`无法开始录像：${error.message}`);
  }
}

function queueRecordingChunk(blob) {
  if (!blob?.size) return;
  state.recordingBytes += blob.size;
  if (state.writable) {
    state.writeChain = state.writeChain.then(() => state.writable.write(blob));
  } else {
    state.recordingChunks.push(blob);
  }
}

async function stopRecording(message = "录像已保存") {
  const recorder = state.recorder;
  if (!recorder) return;
  elements.stopTestButton.disabled = true;
  clearInterval(state.recordingTimer);

  try {
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      if (recorder.state === "recording") recorder.requestData();
      recorder.stop();
    });
    await state.writeChain;

    const durationMs = Date.now() - state.recordingStartedAt;
    const record = { ...state.activeRecording, durationMs, size: state.recordingBytes };
    if (state.writable) {
      await state.writable.close();
    } else {
      const blob = new Blob(state.recordingChunks, { type: recorder.mimeType || "video/webm" });
      downloadBlob(blob, record.filename);
      record.blob = blob;
    }
    await saveRecordingRecord(record);
    showToast(message);
  } catch (error) {
    console.error(error);
    showToast(`保存录像失败：${error.message}`);
    await state.writable?.abort().catch(() => {});
  } finally {
    recorder.stream.getTracks().forEach((track) => track.stop());
    state.recorder = null;
    state.writable = null;
    state.recordingChunks = [];
    state.recordingStartedAt = 0;
    state.activeRecording = null;
    elements.stopTestButton.disabled = false;
    setRecordingUi(false);
    elements.testName.value = suggestedTestName();
    await renderRecordingLibrary();
  }
}

function setRecordingUi(recording) {
  elements.recordBadge.classList.toggle("hidden", !recording);
  elements.startTestButton.classList.toggle("hidden", recording);
  elements.stopTestButton.classList.toggle("hidden", !recording);
  elements.testName.disabled = recording;
  elements.recordHint.textContent = recording
    ? "正在持续写入录像文件；测试结束前请勿关闭本页面。视频断线时系统会自动重连并保留完整测试时间轴。"
    : "连接视频后即可开始测试。录像为 WebM 格式。";
}

function updateRecordingMetrics() {
  const duration = state.recordingStartedAt ? Date.now() - state.recordingStartedAt : 0;
  const durationText = formatDuration(duration);
  elements.durationValue.textContent = durationText;
  elements.recordClock.textContent = durationText;
  elements.sizeValue.textContent = formatBytes(state.recordingBytes);
}

async function startStats(peer) {
  stopStats();
  state.lastStats = null;
  const update = async () => {
    if (state.peer !== peer) return;
    try {
      const reports = await peer.getStats();
      for (const report of reports.values()) {
        if (report.type !== "inbound-rtp" || report.kind !== "video") continue;
        if (state.lastStats && report.framesDecoded != null) {
          const elapsed = (report.timestamp - state.lastStats.timestamp) / 1000;
          const fps = elapsed > 0 ? (report.framesDecoded - state.lastStats.framesDecoded) / elapsed : 0;
          elements.fpsMetric.textContent = `${Math.max(0, Math.round(fps))} FPS`;
        }
        if (report.jitterBufferDelay != null && report.jitterBufferEmittedCount > 0) {
          const delay = report.jitterBufferDelay / report.jitterBufferEmittedCount * 1000;
          elements.latencyMetric.textContent = `缓冲 ${Math.round(delay)} ms`;
        } else {
          elements.latencyMetric.textContent = "低延迟模式";
        }
        state.lastStats = { timestamp: report.timestamp, framesDecoded: report.framesDecoded || 0 };
      }
    } catch { /* Statistics are auxiliary and must not interrupt video. */ }
  };
  await update();
  state.statsTimer = setInterval(update, 1000);
}

function stopStats() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  state.lastStats = null;
  elements.latencyMetric.textContent = "等待视频";
}

async function waitForIceGathering(peer, timeoutMs) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    peer.addEventListener("icegatheringstatechange", check);
    function check() { if (peer.iceGatheringState === "complete") done(); }
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
  });
}

function setStatus(status, text) {
  elements.connectionState.dataset.state = status;
  elements.connectionText.textContent = text;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3500);
}

async function renderRecordingLibrary() {
  const recordings = (await getRecordingRecords()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  elements.recordingList.replaceChildren();
  if (!recordings.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = "还没有测试录像";
    elements.recordingList.append(empty);
    return;
  }

  recordings.forEach((record) => {
    const button = document.createElement("button");
    button.className = "recording-item";
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = record.name;
    const detail = document.createElement("span");
    detail.textContent = `${formatLocalTime(record.startedAt)} · ${formatDuration(record.durationMs)} · ${formatBytes(record.size)}`;
    const action = document.createElement("em");
    action.textContent = "回放";
    button.append(title, detail, action);
    button.addEventListener("click", () => playRecording(record));
    elements.recordingList.append(button);
  });
}

async function playRecording(record) {
  try {
    let file;
    if (record.fileHandle) {
      let permission = await record.fileHandle.queryPermission({ mode: "read" });
      if (permission !== "granted") permission = await record.fileHandle.requestPermission({ mode: "read" });
      if (permission !== "granted") throw new Error("未获得录像文件读取权限");
      file = await record.fileHandle.getFile();
    } else if (record.blob) {
      file = record.blob;
    } else {
      throw new Error("录像文件已移动或不可用，请使用“打开视频”重新选择");
    }
    openPlayback(file, record.name);
  } catch (error) {
    showToast(error.message);
  }
}

async function openExternalVideo() {
  try {
    if ("showOpenFilePicker" in window) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "测试录像", accept: { "video/webm": [".webm"], "video/mp4": [".mp4"] } }],
      });
      openPlayback(await handle.getFile(), handle.name);
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "video/webm,video/mp4,video/*";
      input.addEventListener("change", () => input.files?.[0] && openPlayback(input.files[0], input.files[0].name));
      input.click();
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast(error.message);
  }
}

function openPlayback(file, title) {
  closePlayback();
  state.playbackUrl = URL.createObjectURL(file);
  elements.playbackTitle.textContent = title;
  elements.playbackVideo.src = state.playbackUrl;
  elements.playbackRate.value = "1";
  elements.playbackVideo.playbackRate = 1;
  elements.playbackDialog.showModal();
}

function closePlayback() {
  elements.playbackVideo.pause();
  elements.playbackVideo.removeAttribute("src");
  elements.playbackVideo.load();
  if (state.playbackUrl) URL.revokeObjectURL(state.playbackUrl);
  state.playbackUrl = null;
  if (elements.playbackDialog.open) elements.playbackDialog.close();
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function suggestedTestName() {
  const now = new Date();
  return `测试-${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

function formatLocalTime(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(iso));
}

const DATABASE_NAME = "maixcam-ball-test-recorder";
const STORE_NAME = "recordings";

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function saveRecordingRecord(record) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.addEventListener("complete", resolve);
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  database.close();
}

async function getRecordingRecords() {
  const database = await openDatabase();
  const records = await new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  database.close();
  return records;
}
