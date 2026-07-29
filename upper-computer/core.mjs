export const DEFAULT_SIGNALING_PORT = 8001;

export function normalizeDeviceAddress(value) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error("请输入 MaixCAM Pro 的 IP 地址");
  }

  let url;
  try {
    url = new URL(input.includes("://") ? input : `http://${input}`);
  } catch {
    throw new Error("设备地址格式不正确");
  }

  if (!url.hostname) {
    throw new Error("设备地址中缺少主机名或 IP");
  }

  const port = Number(url.port || DEFAULT_SIGNALING_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("信令端口必须在 1 到 65535 之间");
  }

  return {
    host: url.hostname,
    port,
    websocketUrl: `ws://${url.hostname}:${port}/${randomId(10)}`,
  };
}

export function sanitizeTestName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 64);
  return normalized || "test";
}

export function buildRecordingName(testName, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "_",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
  return `${sanitizeTestName(testName)}_${stamp}.webm`;
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function selectRecordingMime(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass) return "";
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((mime) => MediaRecorderClass.isTypeSupported(mime)) || "";
}

function randomId(length) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const values = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < length; index += 1) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
