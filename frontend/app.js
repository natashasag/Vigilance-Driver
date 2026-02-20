

// ---- Auth ----
function getToken() { return localStorage.getItem('token'); }
function logout() { localStorage.removeItem('token'); localStorage.removeItem('email'); window.location.href = 'login.html'; }

// ---- Detection State ----
let isRunning = false;
let stream = null;
let animFrameId = null;
let startTime = 0;
let closedFrames = 0;
let blinkCount = 0;
let yawnCount = 0;
let wasClosed = false;
let wasYawning = false;
let totalAlerts = 0;
let totalMicroSleeps = 0;
let logs = [];
let modelsLoaded = false;
let audioCtx = null;
let oscillator = null;
let isAlarmOn = false;

const EAR_THRESHOLD = 0.25;
const MAR_THRESHOLD = 0.6;
const DROWSY_FRAMES = 15;
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

// ---- Math Helpers ----
function euclidean(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function calculateEAR(pts) {
  const leftEAR = (euclidean(pts[37], pts[41]) + euclidean(pts[38], pts[40])) / (2 * euclidean(pts[36], pts[39]));
  const rightEAR = (euclidean(pts[43], pts[47]) + euclidean(pts[44], pts[46])) / (2 * euclidean(pts[42], pts[45]));
  return (leftEAR + rightEAR) / 2;
}

function calculateMAR(pts) {
  const vertical = euclidean(pts[61], pts[67]) + euclidean(pts[62], pts[66]) + euclidean(pts[63], pts[65]);
  const horizontal = euclidean(pts[60], pts[64]);
  return vertical / (2 * horizontal);
}

function calculateHeadPose(pts) {
  const nose = pts[30];
  const leftEye = pts[36];
  const rightEye = pts[45];
  const midEye = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const eyeWidth = euclidean(leftEye, rightEye);
  const deviation = Math.abs(nose.x - midEye.x) / eyeWidth;
  return Math.max(0, Math.min(100, 100 - deviation * 200));
}

// ---- Audio Alarm ----
function startAlarm() {
  if (isAlarmOn) return;
  isAlarmOn = true;
  try {
    audioCtx = new AudioContext();
    oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 800;
    gain.gain.value = 0.3;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
  } catch (e) { /* audio not supported */ }
}

function stopAlarm() {
  if (!isAlarmOn) return;
  isAlarmOn = false;
  try { oscillator?.stop(); } catch (e) {}
  oscillator = null;
  try { audioCtx?.close(); } catch (e) {}
  audioCtx = null;
}

// ---- Landmark Drawing ----
function drawLandmarks(detection) {
  const canvas = document.getElementById('overlayCanvas');
  const video = document.getElementById('webcam');
  if (!canvas || !video) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const pts = detection.landmarks.positions;

  // Draw all 68 landmark dots
  ctx.fillStyle = '#22c55e';
  pts.forEach(pt => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Draw connections
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = 0.6;

  function drawPath(indices, close = false) {
    ctx.beginPath();
    ctx.moveTo(pts[indices[0]].x, pts[indices[0]].y);
    for (let i = 1; i < indices.length; i++) {
      ctx.lineTo(pts[indices[i]].x, pts[indices[i]].y);
    }
    if (close) ctx.closePath();
    ctx.stroke();
  }

  // Jaw (0-16)
  drawPath(Array.from({ length: 17 }, (_, i) => i));
  // Left eyebrow (17-21)
  drawPath([17, 18, 19, 20, 21]);
  // Right eyebrow (22-26)
  drawPath([22, 23, 24, 25, 26]);
  // Nose bridge (27-30)
  drawPath([27, 28, 29, 30]);
  // Nose bottom (31-35)
  drawPath([31, 32, 33, 34, 35]);
  // Left eye (36-41)
  drawPath([36, 37, 38, 39, 40, 41], true);
  // Right eye (42-47)
  drawPath([42, 43, 44, 45, 46, 47], true);
  // Outer mouth (48-59)
  drawPath([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59], true);
  // Inner mouth (60-67)
  drawPath([60, 61, 62, 63, 64, 65, 66, 67], true);

  ctx.globalAlpha = 1.0;

  // Face bounding box
  const box = detection.detection.box;
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.4;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.globalAlpha = 1.0;
}

// ---- Logging ----
function addLog(message, type) {
  const time = new Date().toLocaleTimeString();
  logs.unshift({ time, message, type });
  if (logs.length > 50) logs.pop();
  renderLogs();
}

function renderLogs() {
  const el = document.getElementById('logEntries');
  if (!el) return;
  if (logs.length === 0) {
    el.innerHTML = '<p class="log-empty">Start detection to see logs</p>';
    return;
  }
  el.innerHTML = logs.map(l =>
    `<div class="log-entry"><span class="log-time">${l.time}</span><span class="log-msg ${l.type}">${l.message}</span></div>`
  ).join('');
  document.getElementById('logCount').textContent = logs.length + ' events';
}

// ---- Load Models ----
async function loadModels() {
  const statusEl = document.getElementById('modelStatus');
  if (statusEl) statusEl.textContent = 'Loading face detection models...';
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    if (statusEl) statusEl.textContent = 'Models loaded ✓';
    addLog('Face detection models loaded', 'info');
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed to load models!';
    addLog('Failed to load face-api models: ' + err.message, 'danger');
  }
}

// ---- Save Session to MongoDB ----
async function saveSession() {
  const token = getToken();
  if (!token) return;
  const elapsed = (Date.now() - startTime) / 1000;
  const data = {
    started_at: new Date(startTime).toISOString(),
    ended_at: new Date().toISOString(),
    total_blinks: blinkCount,
    total_yawns: yawnCount,
    total_alerts: totalAlerts,
    total_microsleeps: totalMicroSleeps,
    duration_seconds: Math.round(elapsed),
    avg_alertness: Math.max(0, 100 - parseInt(document.getElementById('drowsinessScore')?.textContent || '0'))
  };
  try {
    await fetch('https://vigilance-driver.onrender.com/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(data)
    });
    addLog('Session saved to database', 'info');
  } catch (e) {
    addLog('Failed to save session', 'danger');
  }
}

// ---- Detection ----
async function startDetection() {
  if (!modelsLoaded) { addLog('Models still loading, please wait...', 'warning'); return; }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    const video = document.getElementById('webcam');
    video.srcObject = stream;
    await video.play();
    document.getElementById('videoPlaceholder').classList.add('hidden');

    startTime = Date.now();
    closedFrames = 0;
    blinkCount = 0;
    yawnCount = 0;
    wasClosed = false;
    wasYawning = false;
    totalAlerts = 0;
    totalMicroSleeps = 0;
    logs = [];
    isRunning = true;
    updateStartButton();
    addLog('Detection started - Camera active', 'info');

    async function detectFrame() {
      const video = document.getElementById('webcam');
      if (!video || video.paused || video.ended || !isRunning) return;

      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks();

      const elapsed = (Date.now() - startTime) / 1000;
      const minutes = elapsed / 60;

      if (detection) {
        drawLandmarks(detection);
        const pts = detection.landmarks.positions;
        const ear = parseFloat(calculateEAR(pts).toFixed(3));
        const mar = calculateMAR(pts);
        const headPoseScore = calculateHeadPose(pts);

        const isClosed = ear < EAR_THRESHOLD;
        if (isClosed) { closedFrames++; }
        else {
          if (wasClosed && !isClosed) blinkCount++;
          closedFrames = 0;
        }
        wasClosed = isClosed;

        const isYawning = mar > MAR_THRESHOLD;
        if (isYawning && !wasYawning) {
          yawnCount++;
          addLog('🥱 Yawn detected', 'warning');
        }
        wasYawning = isYawning;

        const isMicroSleep = closedFrames > DROWSY_FRAMES;
        const drowsinessScore = Math.min(100, Math.round(
          (isClosed ? 25 : 5) + (isYawning ? 20 : 0) + (isMicroSleep ? 35 : 0) + Math.max(0, 20 - headPoseScore / 5)
        ));
        const status = drowsinessScore > 60 ? 'drowsy' : drowsinessScore > 35 ? 'warning' : 'alert';
        const blinkRate = minutes > 0 ? parseFloat((blinkCount / minutes).toFixed(1)) : 0;

        if (isMicroSleep) startAlarm(); else stopAlarm();

        if (isMicroSleep && closedFrames === DROWSY_FRAMES + 1) {
          totalMicroSleeps++;
          totalAlerts++;
          addLog('⚠️ Micro-sleep detected!', 'danger');
        }

        updateDashboard({
          ear, drowsinessScore, status, blinkRate,
          blinks: blinkCount, yawns: yawnCount, alerts: totalAlerts,
          microSleeps: totalMicroSleeps, sessionTime: Math.round(elapsed),
          headPoseScore: Math.round(headPoseScore)
        });
      } else {
        // No face - clear canvas
        const canvas = document.getElementById('overlayCanvas');
        if (canvas) { const ctx = canvas.getContext('2d'); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
      }

      animFrameId = requestAnimationFrame(detectFrame);
    }

    animFrameId = requestAnimationFrame(detectFrame);
  } catch (err) {
    addLog('Failed to access camera: ' + err.message, 'danger');
  }
}

function stopDetection() {
  isRunning = false;
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const video = document.getElementById('webcam');
  if (video) video.srcObject = null;
  const canvas = document.getElementById('overlayCanvas');
  if (canvas) { const ctx = canvas.getContext('2d'); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
  document.getElementById('videoPlaceholder').classList.remove('hidden');
  stopAlarm();
  updateStartButton();
  addLog('Detection stopped', 'info');
  saveSession();
}

function toggleDetection() {
  if (isRunning) stopDetection(); else startDetection();
}

function updateStartButton() {
  const btn = document.getElementById('btnStart');
  if (isRunning) { btn.className = 'btn-start running'; btn.innerHTML = '⏹ Stop Detection'; }
  else { btn.className = 'btn-start'; btn.innerHTML = '📷 Start Detection'; }
}

function updateDashboard(d) {
  document.getElementById('earValue').textContent = d.ear.toFixed(3);
  document.getElementById('earInfo').textContent = `Threshold: ${EAR_THRESHOLD} | ${d.ear >= EAR_THRESHOLD ? 'Eyes Open' : 'Eyes Closed'}`;
  document.getElementById('earFill').style.width = Math.min(100, (d.ear / 0.4) * 100) + '%';

  const badge = document.getElementById('statusBadge');
  badge.className = 'status-badge ' + d.status;
  badge.textContent = d.status === 'alert' ? 'Driver Alert' : d.status === 'warning' ? 'Caution' : 'Drowsy - Pull Over!';

  document.getElementById('drowsinessScore').textContent = d.drowsinessScore;
  const fl = document.getElementById('fatigueLabel');
  if (d.drowsinessScore < 30) { fl.textContent = 'Low Fatigue Level'; fl.style.color = '#22c55e'; }
  else if (d.drowsinessScore < 60) { fl.textContent = 'Moderate Fatigue'; fl.style.color = '#eab308'; }
  else { fl.textContent = 'High Fatigue - Rest Now!'; fl.style.color = '#ef4444'; }

  const df = document.getElementById('drowsinessFill');
  df.style.width = d.drowsinessScore + '%';
  df.className = 'progress-fill ' + (d.drowsinessScore < 30 ? 'green' : d.drowsinessScore < 60 ? 'yellow' : 'red');

  document.getElementById('whyText').textContent =
    d.drowsinessScore < 30 ? '• Alertness levels are normal' :
    d.drowsinessScore < 60 ? '• Some fatigue indicators detected' : '• Multiple drowsiness indicators active';

  document.getElementById('statMicrosleeps').textContent = d.microSleeps;
  document.getElementById('statBlinkRate').textContent = d.blinkRate + '/min';
  document.getElementById('statBlinks').textContent = d.blinks;
  document.getElementById('statYawns').textContent = d.yawns;
  document.getElementById('statAlerts').textContent = d.alerts;

  document.getElementById('headPoseFill').style.width = d.headPoseScore + '%';
  document.getElementById('headPoseVal').textContent = d.headPoseScore + '%';

  const m = Math.floor(d.sessionTime / 60);
  document.getElementById('sessionTime').textContent = m + 'm';
  document.getElementById('avgAlertness').textContent = Math.max(0, 100 - d.drowsinessScore) + '%';
}

// Driving modes
function toggleSafetyMode() {
  document.getElementById('safetyToggle').className = 'toggle on';
  document.getElementById('ecoToggle').className = 'toggle off';
  document.getElementById('safetyIcon').className = 'mode-icon green';
  document.getElementById('ecoIcon').className = 'mode-icon gray';
  document.getElementById('modeStatus').textContent = '⚡ Maximum protection active';
}

function toggleEcoMode() {
  document.getElementById('safetyToggle').className = 'toggle off';
  document.getElementById('ecoToggle').className = 'toggle on';
  document.getElementById('safetyIcon').className = 'mode-icon gray';
  document.getElementById('ecoIcon').className = 'mode-icon green';
  document.getElementById('modeStatus').textContent = '⚡ Eco mode active';
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  if (!getToken()) { window.location.href = 'index.html'; return; }
  renderLogs();
  loadModels();
});
