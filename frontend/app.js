// ---- Auth ----
function getToken() { return localStorage.getItem('token'); }
function logout() { localStorage.removeItem('token'); localStorage.removeItem('email'); window.location.href = 'login.html'; }

// ---- Audio Alert ----
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let alarmPlaying = false;
let alarmOscillator = null;

function startAlarm() {
  if (alarmPlaying) return;
  alarmPlaying = true;
  alarmOscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  alarmOscillator.type = 'square';
  alarmOscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
  alarmOscillator.connect(gain).connect(audioCtx.destination);
  alarmOscillator.start();
  // Beep pattern: alternate frequency
  const beepInterval = setInterval(() => {
    if (!alarmPlaying) { clearInterval(beepInterval); return; }
    const t = audioCtx.currentTime;
    alarmOscillator.frequency.setValueAtTime(880, t);
    alarmOscillator.frequency.setValueAtTime(0, t + 0.15);
    alarmOscillator.frequency.setValueAtTime(880, t + 0.3);
  }, 600);
}

function stopAlarm() {
  if (!alarmPlaying) return;
  alarmPlaying = false;
  if (alarmOscillator) { alarmOscillator.stop(); alarmOscillator = null; }
}

// ---- Detection State ----
let isRunning = false;
let stream = null;
let detectionInterval = null;
let startTime = 0;
let closedFrames = 0;
let blinkCount = 0;
let wasClosed = false;
let totalAlerts = 0;
let totalMicroSleeps = 0;
let totalYawns = 0;
let logs = [];
let modelsLoaded = false;

const EAR_THRESHOLD = 0.25;
const DROWSY_FRAMES = 15;
const MAR_THRESHOLD = 0.6;

// ---- EAR Calculation from 68 landmarks ----
function euclidean(p1, p2) {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function calculateEAR(landmarks) {
  // Left eye: points 36-41, Right eye: points 42-47 (0-indexed)
  const pts = landmarks.positions;

  // Left eye
  const l1 = euclidean(pts[37], pts[41]); // p2-p6
  const l2 = euclidean(pts[38], pts[40]); // p3-p5
  const l3 = euclidean(pts[36], pts[39]); // p1-p4
  const leftEAR = (l1 + l2) / (2.0 * l3);

  // Right eye
  const r1 = euclidean(pts[43], pts[47]);
  const r2 = euclidean(pts[44], pts[46]);
  const r3 = euclidean(pts[42], pts[45]);
  const rightEAR = (r1 + r2) / (2.0 * r3);

  return (leftEAR + rightEAR) / 2.0;
}

function calculateMAR(landmarks) {
  // Mouth: outer lips points 48-67
  const pts = landmarks.positions;
  const v1 = euclidean(pts[51], pts[57]); // top-bottom center
  const v2 = euclidean(pts[50], pts[58]);
  const v3 = euclidean(pts[52], pts[56]);
  const h = euclidean(pts[48], pts[54]); // left-right corner
  return (v1 + v2 + v3) / (2.0 * h);
}

function calculateHeadPose(landmarks) {
  const pts = landmarks.positions;
  const noseTip = pts[30];
  const leftEye = pts[36];
  const rightEye = pts[45];
  const midEye = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const dx = Math.abs(noseTip.x - midEye.x);
  const dy = Math.abs(noseTip.y - midEye.y);
  const eyeDist = euclidean(leftEye, rightEye);
  const deviation = (dx + dy) / eyeDist;
  return Math.max(0, Math.min(100, 100 - deviation * 200));
}

// ---- Load face-api.js models ----
async function loadModels() {
  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
  addLog('Loading face detection models...', 'info');
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    addLog('✅ Models loaded successfully', 'info');
  } catch (err) {
    addLog('❌ Failed to load models: ' + err.message, 'danger');
  }
}

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

async function startDetection() {
  if (!modelsLoaded) {
    await loadModels();
    if (!modelsLoaded) return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    const video = document.getElementById('webcam');
    video.srcObject = stream;
    await video.play();
    document.getElementById('videoPlaceholder').classList.add('hidden');

    startTime = Date.now();
    closedFrames = 0;
    blinkCount = 0;
    wasClosed = false;
    totalAlerts = 0;
    totalMicroSleeps = 0;
    totalYawns = 0;
    logs = [];
    isRunning = true;

    updateStartButton();
    addLog('Detection started - Camera active', 'info');

    // Real detection loop
    async function detectFrame() {
      if (!isRunning) return;

      const video = document.getElementById('webcam');
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks();

      const elapsed = (Date.now() - startTime) / 1000;
      const minutes = elapsed / 60;

      if (detection) {
        const ear = parseFloat(calculateEAR(detection.landmarks).toFixed(3));
        const mar = parseFloat(calculateMAR(detection.landmarks).toFixed(3));
        const headPoseScore = calculateHeadPose(detection.landmarks);

        // Yawn detection
        if (mar > MAR_THRESHOLD) {
          totalYawns++;
          addLog('🥱 Yawn detected (MAR: ' + mar.toFixed(2) + ')', 'warning');
        }

        const isClosed = ear < EAR_THRESHOLD;
        if (isClosed) { closedFrames++; }
        else {
          if (wasClosed && !isClosed) blinkCount++;
          closedFrames = 0;
        }
        wasClosed = isClosed;

        const isMicroSleep = closedFrames > DROWSY_FRAMES;
        const fatigueFactor = Math.max(0, 1 - elapsed / 600);
        const drowsinessScore = Math.min(100, Math.round(
          15 + (1 - fatigueFactor) * 20 +
          (isMicroSleep ? 35 : 0) +
          (ear < EAR_THRESHOLD ? 15 : 0) +
          (100 - headPoseScore) * 0.15
        ));
        const status = drowsinessScore > 60 ? 'drowsy' : drowsinessScore > 35 ? 'warning' : 'alert';
        const blinkRate = minutes > 0 ? parseFloat((blinkCount / minutes).toFixed(1)) : 0;

        if (isMicroSleep && closedFrames === DROWSY_FRAMES + 1) {
          totalMicroSleeps++;
          totalAlerts++;
          addLog('⚠️ Micro-sleep detected!', 'danger');
          startAlarm();
        }

        if (!isMicroSleep && status === 'alert') {
          stopAlarm();
        }

        updateDashboard({
          ear, drowsinessScore, status, blinkRate,
          blinks: blinkCount, yawns: totalYawns, alerts: totalAlerts,
          microSleeps: totalMicroSleeps, sessionTime: Math.round(elapsed),
          headPoseScore
        });
      } else {
        addLog('No face detected', 'warning');
      }

      if (isRunning) requestAnimationFrame(detectFrame);
    }

    detectFrame();
  } catch (err) {
    addLog('Failed to access camera: ' + err.message, 'danger');
  }
}

function stopDetection() {
  isRunning = false;
  stopAlarm();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  const video = document.getElementById('webcam');
  if (video) video.srcObject = null;
  document.getElementById('videoPlaceholder').classList.remove('hidden');
  updateStartButton();
  addLog('Detection stopped', 'info');
}

function toggleDetection() {
  if (isRunning) stopDetection();
  else startDetection();
}

function updateStartButton() {
  const btn = document.getElementById('btnStart');
  if (isRunning) {
    btn.className = 'btn-start running';
    btn.innerHTML = '⏹ Stop Detection';
  } else {
    btn.className = 'btn-start';
    btn.innerHTML = '📷 Start Detection';
  }
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
  document.getElementById('headPoseVal').textContent = Math.round(d.headPoseScore) + '%';

  const m = Math.floor(d.sessionTime / 60);
  document.getElementById('sessionTime').textContent = m + 'm';
  document.getElementById('avgAlertness').textContent = Math.max(0, 100 - d.drowsinessScore) + '%';
}

function toggleSafetyMode() {
  document.getElementById('safetyToggle').className = 'toggle on';
  document.getElementById('ecoToggle').className = 'toggle off';
  document.getElementById('safetyIcon').className = 'mode-icon green';
  document.getElementById('ecoIcon').className = 'mode-icon gray';
  document.getElementById('modeStatus').textContent = '⚡ Maximum protection active';
  document.querySelector('.mode-item:nth-child(1)').classList.add('active');
  document.querySelector('.mode-item:nth-child(2)').classList.remove('active');
}

function toggleEcoMode() {
  document.getElementById('safetyToggle').className = 'toggle off';
  document.getElementById('ecoToggle').className = 'toggle on';
  document.getElementById('safetyIcon').className = 'mode-icon gray';
  document.getElementById('ecoIcon').className = 'mode-icon green';
  document.getElementById('modeStatus').textContent = '⚡ Eco mode active';
  document.querySelector('.mode-item:nth-child(1)').classList.remove('active');
  document.querySelector('.mode-item:nth-child(2)').classList.add('active');
}

document.addEventListener('DOMContentLoaded', () => {
  if (!getToken()) { window.location.href = 'login.html'; return; }
  renderLogs();
});
