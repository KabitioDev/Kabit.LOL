const socket = io();

// Canvas details
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let myId = null;
let activeRoomName = '';
let currentGameState = 'ROOM_SELECT'; // ROOM_SELECT, LOBBY, PLAYING, SPECTATING
let serverPlayers = {};
let renderPlayers = {}; // Smoothly interpolated positions
let serverBullets = [];
let renderBullets = [];
let platforms = [];

// Input state tracking
const keys = { left: false, right: false, jump: false };
let lastInputString = '';
let mousePos = { x: 0, y: 0 };
let aimAngle = 0;

// Camera state for smooth scrolling / zoom spectating
let camX = canvas.width / 2;
let camY = canvas.height / 2;
let camZoom = 1.0;
let currentCamX = canvas.width / 2;
let currentCamY = canvas.height / 2;
let currentCamZoom = 1.0;

// Local Settings (loaded from localStorage or defaults)
let settings = {
  volume: 80,
  screenshake: 8,
  laserStyle: 'dashed',
  showGrid: true
};

function loadSettings() {
  const saved = localStorage.getItem('kabit_settings');
  if (saved) {
    try {
      settings = { ...settings, ...JSON.parse(saved) };
    } catch (e) {
      console.error('Failed to parse settings', e);
    }
  }
  
  // Update UI components
  document.getElementById('settings-volume').value = settings.volume;
  document.getElementById('volume-val').textContent = settings.volume + '%';
  
  document.getElementById('settings-screenshake').value = settings.screenshake;
  document.getElementById('screenshake-val').textContent = settings.screenshake + '/10';
  
  document.getElementById('settings-laser-style').value = settings.laserStyle;
  document.getElementById('settings-grid').checked = settings.showGrid;
}

function saveSettings() {
  localStorage.setItem('kabit_settings', JSON.stringify(settings));
}

// Particle System
let particles = [];
class Particle {
  constructor(x, y, vx, vy, color, size, life, decayType = 'linear') {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.color = color;
    this.size = size;
    this.maxLife = life;
    this.life = life;
    this.decayType = decayType;
  }
  
  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.vy += 0.08; // gravity
    this.life--;
  }

  draw(ctx) {
    const alpha = this.decayType === 'linear' ? this.life / this.maxLife : Math.pow(this.life / this.maxLife, 2);
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.shadowBlur = 10;
    ctx.shadowColor = this.color;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Visual screen shake parameters
let screenShakeTime = 0;
let screenShakeIntensity = 0;

function triggerScreenShake(duration, intensity) {
  if (settings.screenshake === 0) return;
  screenShakeTime = duration;
  // Scale intensity with screenshake slider (0 to 10 scale)
  screenShakeIntensity = intensity * (settings.screenshake / 8);
}

// Synthesized sound manager using Web Audio API
class SoundFX {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  getVolume() {
    // scale 0.0 to 1.0 based on settings
    return settings.volume / 100;
  }

  createSweepNode(startFreq, endFreq, duration, type = 'sine') {
    if (!this.ctx) return null;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, this.ctx.currentTime + duration);
    
    osc.connect(gain);
    // Connect to volume gain node first
    const masterGain = this.ctx.createGain();
    masterGain.gain.value = this.getVolume();
    
    gain.connect(masterGain);
    masterGain.connect(this.ctx.destination);
    
    return { osc, gain };
  }

  playShoot(gunType) {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;

    const now = this.ctx.currentTime;
    
    if (gunType === 'pistol') {
      const { osc, gain } = this.createSweepNode(800, 180, 0.12, 'triangle');
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (gunType === 'shotgun') {
      const duration = 0.22;
      const bufferSize = this.ctx.sampleRate * duration;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;
      
      const gainNode = this.ctx.createGain();
      gainNode.gain.setValueAtTime(0.35, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);
      
      noise.connect(filter);
      
      const masterGain = this.ctx.createGain();
      masterGain.gain.value = this.getVolume();
      
      filter.connect(gainNode);
      gainNode.connect(masterGain);
      masterGain.connect(this.ctx.destination);
      
      noise.start(now);
      noise.stop(now + duration);
      
      // Add heavy thud
      const { osc, gain } = this.createSweepNode(350, 80, 0.15, 'sawtooth');
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (gunType === 'sniper') {
      const { osc, gain } = this.createSweepNode(1800, 100, 0.25, 'sawtooth');
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (gunType === 'rocket') {
      const { osc, gain } = this.createSweepNode(220, 50, 0.35, 'sawtooth');
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      
      osc.disconnect();
      osc.connect(filter);
      filter.connect(gain);
      
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (gunType === 'machinegun') {
      const { osc, gain } = this.createSweepNode(900, 250, 0.07, 'sine');
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.07);
      osc.start(now);
      osc.stop(now + 0.07);
    }
  }

  playJump() {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;
    const now = this.ctx.currentTime;
    const { osc, gain } = this.createSweepNode(180, 550, 0.1, 'sine');
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  playBounce() {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;
    const now = this.ctx.currentTime;
    const { osc, gain } = this.createSweepNode(1200, 800, 0.04, 'sine');
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.005, now + 0.04);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  playHit() {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;
    const now = this.ctx.currentTime;
    const { osc, gain } = this.createSweepNode(150, 60, 0.08, 'triangle');
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  playExplosion() {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;
    
    const now = this.ctx.currentTime;
    const duration = 0.45;
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.linearRampToValueAtTime(80, now + duration);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.5, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

    const masterGain = this.ctx.createGain();
    masterGain.gain.value = this.getVolume();

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(masterGain);
    masterGain.connect(this.ctx.destination);

    noise.start(now);
    noise.stop(now + duration);

    // Deep sub drop
    const { osc, gain } = this.createSweepNode(140, 30, duration, 'sawtooth');
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);
    osc.start(now);
    osc.stop(now + duration);
  }

  playDeath() {
    this.init();
    if (!this.ctx || this.getVolume() <= 0) return;
    const now = this.ctx.currentTime;
    const { osc, gain } = this.createSweepNode(300, 60, 0.35, 'sawtooth');
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  }
}

const sfx = new SoundFX();

// DOM Bindings
const roomSelectScreen = document.getElementById('room-selection');
const menuLobby = document.getElementById('lobby-menu');
const gameContainer = document.getElementById('game-container');
const activeRoomTitle = document.getElementById('active-room-title');
const newRoomInput = document.getElementById('new-room-input');
const createRoomBtn = document.getElementById('create-room-btn');
const roomGrid = document.getElementById('room-grid');

const nicknameInput = document.getElementById('nickname-input');
const colorDots = document.querySelectorAll('.color-dot');
const readyBtn = document.getElementById('ready-btn');
const lobbyBackBtn = document.getElementById('lobby-back-btn');
const lobbyRoster = document.getElementById('lobby-roster');
const gunCards = document.querySelectorAll('.gun-card');

const scoreboardEntries = document.getElementById('scoreboard-entries');
const activeWeaponName = document.getElementById('active-weapon-name');
const weaponCooldownBar = document.getElementById('weapon-cooldown-bar');

const deathScreen = document.getElementById('death-screen');
const killerNameSpan = document.getElementById('killer-name');
const deathStatusText = document.getElementById('death-status-text');
const respawnTimerText = document.getElementById('respawn-timer-text');
const deathEscapeBtn = document.getElementById('death-escape-btn');

// Chat UI elements
const chatLogs = document.getElementById('chat-logs');
const chatInput = document.getElementById('chat-input');

// Settings Elements
const settingsModal = document.getElementById('settings-modal');
const settingsOpenBtnRoom = document.getElementById('settings-open-btn-room');
const settingsOpenBtnLobby = document.getElementById('settings-open-btn-lobby');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsVolume = document.getElementById('settings-volume');
const volumeVal = document.getElementById('volume-val');
const settingsScreenshake = document.getElementById('settings-screenshake');
const screenshakeVal = document.getElementById('screenshake-val');
const settingsLaserStyle = document.getElementById('settings-laser-style');
const settingsGrid = document.getElementById('settings-grid');

// Custom profile settings
let selectedColor = '#00f0ff';
let selectedGun = 'pistol';
let isReady = false;

// Death respawn timer
let respawnInterval = null;
let respawnSecsLeft = 0;

// Load initial options
loadSettings();

// Load name from local storage
if (localStorage.getItem('kabit_nickname')) {
  nicknameInput.value = localStorage.getItem('kabit_nickname');
} else {
  nicknameInput.value = 'Player_' + Math.floor(Math.random() * 9000 + 1000);
}

// Option dialog events
const openSettings = () => {
  sfx.init();
  settingsModal.classList.remove('hidden');
};
settingsOpenBtnRoom.addEventListener('click', openSettings);
settingsOpenBtnLobby.addEventListener('click', openSettings);

settingsCloseBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
  saveSettings();
});

// Setting adjustments live binding
settingsVolume.addEventListener('input', () => {
  settings.volume = parseInt(settingsVolume.value);
  volumeVal.textContent = settings.volume + '%';
});

settingsScreenshake.addEventListener('input', () => {
  settings.screenshake = parseInt(settingsScreenshake.value);
  screenshakeVal.textContent = settings.screenshake + '/10';
});

settingsLaserStyle.addEventListener('change', () => {
  settings.laserStyle = settingsLaserStyle.value;
});

settingsGrid.addEventListener('change', () => {
  settings.showGrid = settingsGrid.checked;
});

// Color options setup
colorDots.forEach(dot => {
  dot.addEventListener('click', () => {
    colorDots.forEach(d => d.classList.remove('active'));
    dot.classList.add('active');
    selectedColor = dot.getAttribute('data-color');
    updateProfile();
  });
});

// Gun card selection setup
gunCards.forEach(card => {
  card.addEventListener('click', () => {
    gunCards.forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedGun = card.getAttribute('data-gun');
    updateProfile();
  });
});

nicknameInput.addEventListener('change', () => {
  const name = nicknameInput.value.trim();
  if (name.length > 0) {
    localStorage.setItem('kabit_nickname', name);
    updateProfile();
  }
});

readyBtn.addEventListener('click', () => {
  sfx.init();
  isReady = !isReady;
  
  if (isReady) {
    readyBtn.classList.add('ready-active');
    readyBtn.textContent = 'LEAVE ARENA';
  } else {
    readyBtn.classList.remove('ready-active');
    readyBtn.textContent = 'ENTER ARENA';
  }
  
  socket.emit('toggle_ready', isReady);
});

// Back button on lobby returns to rooms selection
lobbyBackBtn.addEventListener('click', () => {
  socket.emit('leave_room');
});

// Server room creation bindings
createRoomBtn.addEventListener('click', () => {
  const name = newRoomInput.value.trim();
  if (name.length > 0) {
    socket.emit('create_room', name);
    newRoomInput.value = '';
  }
});

newRoomInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    createRoomBtn.click();
  }
});

function updateProfile() {
  socket.emit('update_profile', {
    nickname: nicknameInput.value.trim() || 'Player',
    color: selectedColor,
    gun: selectedGun
  });
}

// Input Capturing
window.addEventListener('keydown', (e) => {
  // If typing in chat input, suppress game keys
  if (document.activeElement === chatInput) {
    if (e.key === 'Escape') {
      chatInput.value = '';
      chatInput.blur();
    }
    return;
  }

  // Escape Key to leave game / exit lobby
  if (e.key === 'Escape') {
    if (currentGameState === 'PLAYING' || currentGameState === 'SPECTATING' || currentGameState === 'LOBBY') {
      socket.emit('leave_room');
      return;
    }
  }

  // Enter Key to open/send chat
  if (e.key === 'Enter') {
    if (currentGameState === 'PLAYING' || currentGameState === 'SPECTATING') {
      chatInput.focus();
      return;
    }
  }

  if (currentGameState !== 'PLAYING') return;
  let changed = false;

  if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
    if (!keys.left) { keys.left = true; changed = true; }
  }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') {
    if (!keys.right) { keys.right = true; changed = true; }
  }
  if (e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp') {
    if (!keys.jump) { keys.jump = true; changed = true; }
  }

  if (changed) {
    sendInputs();
  }
});

window.addEventListener('keyup', (e) => {
  if (document.activeElement === chatInput) return;

  if (currentGameState !== 'PLAYING') return;
  let changed = false;

  if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
    if (keys.left) { keys.left = false; changed = true; }
  }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') {
    if (keys.right) { keys.right = false; changed = true; }
  }
  if (e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp') {
    if (keys.jump) { keys.jump = false; changed = true; }
  }

  if (changed) {
    sendInputs();
  }
});

// Chat input typing send event
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const msg = chatInput.value.trim();
    if (msg.length > 0) {
      socket.emit('chat_message', msg);
    }
    chatInput.value = '';
    chatInput.blur();
  }
});

// Calculate mouse direction
canvas.addEventListener('mousemove', (e) => {
  if (currentGameState !== 'PLAYING') return;
  const rect = canvas.getBoundingClientRect();
  
  // Account for dynamic camera coordinate system translation offsets!
  // mouse coordinates are screen space, so we must calculate offset relative to currentCam coordinates
  const screenCenterX = rect.width / 2;
  const screenCenterY = rect.height / 2;

  // Since player is centered at (currentCamX, currentCamY) in canvas,
  // the mouse relative to center of canvas dictates direction
  const canvasMouseX = (e.clientX - rect.left) / (rect.width / canvas.width);
  const canvasMouseY = (e.clientY - rect.top) / (rect.height / canvas.height);
  
  // Find player relative positions under scaled/translated viewport
  const player = renderPlayers[myId];
  if (player) {
    // If zoom is applied: mouse position in world space is:
    const worldMouseX = (canvasMouseX - canvas.width / 2) / currentCamZoom + currentCamX;
    const worldMouseY = (canvasMouseY - canvas.height / 2) / currentCamZoom + currentCamY;
    
    mousePos.x = worldMouseX;
    mousePos.y = worldMouseY;
  } else {
    mousePos.x = canvasMouseX;
    mousePos.y = canvasMouseY;
  }
});

canvas.addEventListener('mousedown', () => {
  if (currentGameState !== 'PLAYING') return;
  sfx.init();
  
  const player = renderPlayers[myId];
  if (player && !player.isDead && player.cooldown <= 0) {
    const angle = Math.atan2(mousePos.y - player.renderY, mousePos.x - player.renderX);
    socket.emit('shoot', angle);
  }
});

deathEscapeBtn.addEventListener('click', () => {
  socket.emit('leave_room');
});

function sendInputs() {
  const currentInputStr = JSON.stringify(keys);
  if (currentInputStr !== lastInputString) {
    socket.emit('input', keys);
    lastInputString = currentInputStr;
  }
}

// Add logs to kill feed
const killFeedContainer = document.getElementById('kill-feed');
function showKillFeed(message, color) {
  const item = document.createElement('div');
  item.className = 'kill-feed-item';
  item.innerHTML = `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${color}; box-shadow:0 0 6px ${color}"></span> ${message}`;
  
  killFeedContainer.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateX(50px)';
    item.style.transition = 'all 0.4s';
    setTimeout(() => item.remove(), 400);
  }, 3500);
}

// SOCKET MESSAGE HANDLING

socket.on('room_list', (rooms) => {
  roomGrid.innerHTML = '';
  
  if (rooms.length === 0) {
    roomGrid.innerHTML = '<div class="loading-rooms">No active rooms. Create one above!</div>';
    return;
  }

  rooms.forEach(room => {
    const box = document.createElement('div');
    box.className = 'room-card-item';
    box.innerHTML = `
      <div class="room-card-title">${room.name}</div>
      <div class="room-card-meta">
        <span class="room-card-count">${room.playerCount} Players</span>
        <span class="room-card-status">Online</span>
      </div>
    `;
    box.addEventListener('click', () => {
      sfx.init();
      socket.emit('join_room', room.name);
    });
    roomGrid.appendChild(box);
  });
});

socket.on('room_created', (name) => {
  socket.emit('join_room', name);
});

socket.on('joined_room_confirm', (data) => {
  myId = data.id;
  activeRoomName = data.roomName;
  serverPlayers = data.players;
  platforms = data.platforms;
  
  activeRoomTitle.textContent = activeRoomName.toUpperCase();
  document.getElementById('hud-room-name').textContent = activeRoomName.toUpperCase();
  
  // Clear chat log
  chatLogs.innerHTML = '';
  
  updateUIState('LOBBY');
  updateProfile(); // push starting name/weapon settings
});

socket.on('left_room_confirm', () => {
  activeRoomName = '';
  serverPlayers = {};
  renderPlayers = {};
  serverBullets = [];
  renderBullets = [];
  isReady = false;
  
  if (respawnInterval) {
    clearInterval(respawnInterval);
    respawnInterval = null;
  }

  updateUIState('ROOM_SELECT');
});

socket.on('error_msg', (msg) => {
  alert(msg);
});

socket.on('player_joined', (player) => {
  serverPlayers[player.id] = player;
  showKillFeed(`${player.nickname} joined the room`, player.color);
  rebuildLobbyUI();
});

socket.on('player_left', (id) => {
  if (serverPlayers[id]) {
    showKillFeed(`${serverPlayers[id].nickname} left the room`, '#718096');
    delete serverPlayers[id];
    delete renderPlayers[id];
  }
  rebuildLobbyUI();
});

socket.on('player_updated', (player) => {
  serverPlayers[player.id] = player;
  
  if (renderPlayers[player.id]) {
    renderPlayers[player.id].nickname = player.nickname;
    renderPlayers[player.id].color = player.color;
    renderPlayers[player.id].gun = player.gun;
    renderPlayers[player.id].isReady = player.isReady;
    renderPlayers[player.id].isDead = player.isDead;
  }
  
  rebuildLobbyUI();
});

socket.on('player_died', (data) => {
  const victim = renderPlayers[data.id];
  const victimName = victim ? victim.nickname : 'Player';
  
  if (data.killerName) {
    showKillFeed(`${data.killerName} blasted ${victimName}!`, data.killerColor);
  } else {
    showKillFeed(`${victimName} fell out of bounds`, data.color || '#718096');
  }

  // If local player died, launch death spectate failed-screen
  if (data.id === myId) {
    triggerScreenShake(30, 10);
    updateUIState('SPECTATING');
    
    if (data.killerName) {
      deathStatusText.innerHTML = `Killed by <span style="color:${data.killerColor}; text-shadow:0 0 10px ${data.killerColor}">${data.killerName}</span>`;
      document.getElementById('spectate-subtext').textContent = 'Spectating opponent...';
    } else {
      deathStatusText.textContent = 'You fell into the grid hazard!';
      document.getElementById('spectate-subtext').textContent = 'Spectating match...';
    }

    // Launch local 5-second countdown timer
    respawnSecsLeft = 5;
    respawnTimerText.textContent = `Respawning in ${respawnSecsLeft}s`;
    
    if (respawnInterval) clearInterval(respawnInterval);
    respawnInterval = setInterval(() => {
      respawnSecsLeft--;
      respawnTimerText.textContent = `Respawning in ${respawnSecsLeft}s`;
      if (respawnSecsLeft <= 0) {
        clearInterval(respawnInterval);
        respawnInterval = null;
      }
    }, 1000);
  }
});

socket.on('player_respawned', (data) => {
  if (data.id === myId) {
    if (respawnInterval) {
      clearInterval(respawnInterval);
      respawnInterval = null;
    }
    updateUIState('PLAYING');
  }
  
  // Reset render LERP values immediately to avoid sliding from old death position
  if (renderPlayers[data.id]) {
    renderPlayers[data.id].renderX = data.x;
    renderPlayers[data.id].renderY = data.y;
    renderPlayers[data.id].targetX = data.x;
    renderPlayers[data.id].targetY = data.y;
    renderPlayers[data.id].isDead = false;
  }
});

socket.on('chat_message', (msg) => {
  const item = document.createElement('div');
  item.className = 'chat-msg';
  item.innerHTML = `
    <span class="chat-sender" style="color: ${msg.color}">${msg.sender}:</span>
    <span class="chat-text">${msg.text}</span>
  `;
  chatLogs.appendChild(item);
  chatLogs.scrollTop = chatLogs.scrollHeight;
});

socket.on('game_update', (data) => {
  serverPlayers = data.players;
  serverBullets = data.bullets;

  // Update client UI screen states based on our player state
  const me = serverPlayers[myId];
  if (me) {
    if (me.isReady) {
      if (me.isDead) {
        if (currentGameState !== 'SPECTATING') {
          updateUIState('SPECTATING');
        }
      } else {
        if (currentGameState !== 'PLAYING') {
          updateUIState('PLAYING');
        }
      }
    } else {
      if (currentGameState !== 'LOBBY' && currentGameState !== 'ROOM_SELECT') {
        updateUIState('LOBBY');
      }
    }
  }

  // Update render players
  Object.keys(serverPlayers).forEach(id => {
    const sp = serverPlayers[id];
    if (!renderPlayers[id]) {
      renderPlayers[id] = {
        id: sp.id,
        renderX: sp.x,
        renderY: sp.y,
        targetX: sp.x,
        targetY: sp.y,
        vx: sp.vx,
        vy: sp.vy,
        radius: sp.radius,
        isGrounded: sp.isGrounded,
        isDead: sp.isDead,
        nickname: sp.nickname,
        color: sp.color,
        gun: sp.gun,
        wins: sp.wins,
        cooldown: sp.cooldown,
        spectateTargetId: sp.spectateTargetId
      };
    } else {
      const rp = renderPlayers[id];
      rp.targetX = sp.x;
      rp.targetY = sp.y;
      rp.vx = sp.vx;
      rp.vy = sp.vy;
      rp.isGrounded = sp.isGrounded;
      rp.isDead = sp.isDead;
      rp.wins = sp.wins;
      rp.cooldown = sp.cooldown;
      rp.spectateTargetId = sp.spectateTargetId;
      
      const dist = Math.hypot(rp.renderX - rp.targetX, rp.renderY - rp.targetY);
      if (dist > 150) {
        rp.renderX = rp.targetX;
        rp.renderY = rp.targetY;
      }
    }
  });

  // Clean disconnected players
  Object.keys(renderPlayers).forEach(id => {
    if (!serverPlayers[id]) {
      delete renderPlayers[id];
    }
  });

  // Sync bullets
  const newRenderBullets = [];
  serverBullets.forEach(sb => {
    const existing = renderBullets.find(rb => rb.id === sb.id);
    if (existing) {
      existing.targetX = sb.x;
      existing.targetY = sb.y;
      existing.vx = sb.vx;
      existing.vy = sb.vy;
      existing.gravity = sb.gravity;
      existing.bounces = sb.bounces;
      existing.trail.push({ x: existing.renderX, y: existing.renderY });
      if (existing.trail.length > 5) existing.trail.shift();
      newRenderBullets.push(existing);
    } else {
      newRenderBullets.push({
        id: sb.id,
        renderX: sb.x,
        renderY: sb.y,
        targetX: sb.x,
        targetY: sb.y,
        vx: sb.vx,
        vy: sb.vy,
        radius: sb.radius,
        color: sb.color,
        bounces: sb.bounces,
        gravity: sb.gravity,
        trail: []
      });
    }
  });
  renderBullets = newRenderBullets;

  // Refresh HUD scores
  if (currentGameState === 'PLAYING' || currentGameState === 'SPECTATING') {
    updateHUD();
  }
});

// FX triggers
socket.on('bullet_bounce', (data) => {
  sfx.playBounce();
  
  for (let k = 0; k < 5; k++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 2 + 1;
    particles.push(new Particle(
      data.x, 
      data.y, 
      Math.cos(angle) * speed, 
      Math.sin(angle) * speed, 
      data.color, 
      2.5, 
      18
    ));
  }
});

socket.on('player_hit', (data) => {
  sfx.playHit();
  triggerScreenShake(10, 4);

  for (let k = 0; k < 8; k++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 3 + 1.5;
    particles.push(new Particle(
      data.x, 
      data.y, 
      Math.cos(angle) * speed, 
      Math.sin(angle) * speed, 
      '#ffffff', 
      2.8, 
      22
    ));
  }
});

socket.on('explosion', (data) => {
  sfx.playExplosion();
  triggerScreenShake(26, 9);

  for (let k = 0; k < 22; k++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 2;
    particles.push(new Particle(
      data.x, 
      data.y, 
      Math.cos(angle) * speed, 
      Math.sin(angle) * speed, 
      '#ff6600', 
      Math.random() * 3 + 2, 
      30,
      'exponential'
    ));
    particles.push(new Particle(
      data.x, 
      data.y, 
      Math.cos(angle) * (speed * 0.7), 
      Math.sin(angle) * (speed * 0.7), 
      '#ffff00', 
      Math.random() * 2 + 1, 
      20,
      'linear'
    ));
  }

  // custom explosion ring particle
  particles.push({
    x: data.x,
    y: data.y,
    life: 22,
    maxLife: 22,
    radius: data.radius,
    isRing: true,
    update() { this.life--; },
    draw(ctx) {
      const ratio = 1 - this.life / this.maxLife;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - ratio);
      ctx.strokeStyle = '#ff3c00';
      ctx.lineWidth = 3.5 * (1 - ratio) + 1;
      ctx.shadowBlur = 18;
      ctx.shadowColor = '#ff3c00';
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius * ratio, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  });
});

socket.on('sound_trigger', (data) => {
  if (data.type === 'shoot') {
    sfx.playShoot(data.gun);
    
    const player = renderPlayers[data.playerId];
    if (player) {
      const angle = (player.id === myId) ? aimAngle : Math.atan2(mousePos.y - player.renderY, mousePos.x - player.renderX);
      const flashX = player.renderX + Math.cos(angle) * (player.radius + 8);
      const flashY = player.renderY + Math.sin(angle) * (player.radius + 8);

      const colorMap = { pistol: '#00f0ff', shotgun: '#ff00ff', sniper: '#ffff00', rocket: '#ff6600', machinegun: '#39ff14' };
      const color = colorMap[player.gun] || '#ffffff';

      for (let k = 0; k < 4; k++) {
        const pAngle = angle + (Math.random() - 0.5) * 0.5;
        const pSpeed = Math.random() * 2 + 1.5;
        particles.push(new Particle(
          flashX, flashY,
          Math.cos(pAngle) * pSpeed, Math.sin(pAngle) * pSpeed,
          color, 2, 12
        ));
      }
    }
  } else if (data.type === 'jump') {
    sfx.playJump();
    
    const player = renderPlayers[data.playerId];
    if (player) {
      for (let k = 0; k < 6; k++) {
        const vx = (Math.random() - 0.5) * 2;
        const vy = Math.random() * 1;
        particles.push(new Particle(
          player.renderX, player.renderY + player.radius,
          vx, vy, 'rgba(255,255,255,0.3)', 2, 15
        ));
      }
    }
  } else if (data.type === 'death') {
    sfx.playDeath();
    
    const player = renderPlayers[data.playerId];
    if (player) {
      for (let k = 0; k < 25; k++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 4 + 1;
        particles.push(new Particle(
          player.renderX, Math.min(canvas.height - 10, player.renderY),
          Math.cos(angle) * speed, Math.sin(angle) * speed,
          player.color, 3, 35
        ));
      }
    }
  }
});

// UI RENDERING

function updateUIState(state) {
  currentGameState = state;
  
  if (state === 'ROOM_SELECT') {
    roomSelectScreen.classList.add('active');
    menuLobby.classList.remove('active');
    gameContainer.classList.add('hidden');
    deathScreen.classList.add('hidden');
  } else if (state === 'LOBBY') {
    roomSelectScreen.classList.remove('active');
    menuLobby.classList.add('active');
    gameContainer.classList.add('hidden');
    deathScreen.classList.add('hidden');
    
    if (!isReady) {
      readyBtn.classList.remove('ready-active');
      readyBtn.textContent = 'ENTER ARENA';
    }
    rebuildLobbyUI();
  } else if (state === 'PLAYING') {
    roomSelectScreen.classList.remove('active');
    menuLobby.classList.remove('active');
    gameContainer.classList.remove('hidden');
    deathScreen.classList.add('hidden');
  } else if (state === 'SPECTATING') {
    roomSelectScreen.classList.remove('active');
    menuLobby.classList.remove('active');
    gameContainer.classList.remove('hidden');
    deathScreen.classList.remove('hidden');
  }
}

function rebuildLobbyUI() {
  lobbyRoster.innerHTML = '';
  Object.values(serverPlayers).forEach(p => {
    const row = document.createElement('div');
    row.className = 'lobby-player-row';
    
    const statusLabel = p.isReady ? 'PLAYING' : 'CUSTOMIZING';
    const statusClass = p.isReady ? 'ready' : 'waiting';
    
    row.innerHTML = `
      <div class="player-info">
        <span class="player-color-indicator" style="color: ${p.color}; background-color: ${p.color}"></span>
        <span class="player-name">${p.nickname} ${p.id === myId ? '(You)' : ''}</span>
        <span class="player-weapon-badge">${p.gun}</span>
      </div>
      <div class="player-status-badge ${statusClass}">${statusLabel}</div>
    `;
    lobbyRoster.appendChild(row);
  });
}

function updateHUD() {
  scoreboardEntries.innerHTML = '';
  const sortedPlayers = Object.values(renderPlayers).sort((a,b) => b.wins - a.wins);
  sortedPlayers.forEach(p => {
    const entry = document.createElement('div');
    entry.className = 'scoreboard-entry';
    entry.style.color = p.color;
    entry.innerHTML = `
      <span class="player-name-val">${p.nickname}</span>
      <span class="wins-val">${p.wins} Kills</span>
    `;
    scoreboardEntries.appendChild(entry);
  });

  const me = renderPlayers[myId];
  if (me) {
    activeWeaponName.textContent = me.gun.toUpperCase();
    
    const colorMap = { pistol: '#00f0ff', shotgun: '#ff00ff', sniper: '#ffff00', rocket: '#ff6600', machinegun: '#39ff14' };
    const color = colorMap[me.gun] || '#ffffff';
    
    activeWeaponName.style.color = color;
    weaponCooldownBar.style.backgroundColor = color;
    
    const maxCooldowns = { pistol: 350, shotgun: 800, sniper: 1100, rocket: 1400, machinegun: 90 };
    const maxCd = maxCooldowns[me.gun] || 350;
    
    if (me.cooldown > 0) {
      const percent = Math.min(100, (me.cooldown / maxCd) * 100);
      weaponCooldownBar.style.transform = `scaleY(${percent / 100})`;
    } else {
      weaponCooldownBar.style.transform = 'scaleY(0)';
    }
  }
}

// CANVAS GRID AND CAMERA DRAWING

function drawArena() {
  // 1. Draw Grid Pattern (if enabled in settings)
  if (settings.showGrid) {
    ctx.save();
    ctx.strokeStyle = '#111824';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. Draw Platforms
  platforms.forEach(platform => {
    ctx.save();
    let color = '#202e45';
    let glowColor = 'rgba(0, 240, 255, 0.4)';
    
    if (platform.type === 'bumper') {
      color = '#382045';
      glowColor = 'rgba(255, 0, 255, 0.45)';
    }

    ctx.fillStyle = color;
    ctx.fillRect(platform.x, platform.y, platform.width, platform.height);

    ctx.shadowBlur = 10;
    ctx.shadowColor = glowColor;
    ctx.strokeStyle = platform.type === 'bumper' ? '#ff00ff' : '#00f0ff';
    ctx.lineWidth = 2;
    
    ctx.beginPath();
    if (platform.type === 'bumper') {
      ctx.strokeRect(platform.x, platform.y, platform.width, platform.height);
    } else {
      ctx.moveTo(platform.x, platform.y);
      ctx.lineTo(platform.x + platform.width, platform.y);
      ctx.stroke();
    }
    ctx.restore();
  });

  // 3. Hazard Pit Warning Lines at bottom
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 40, 40, 0.18)';
  ctx.lineWidth = 3;
  ctx.shadowBlur = 8;
  ctx.shadowColor = '#ff2828';
  ctx.beginPath();
  ctx.moveTo(0, canvas.height - 10);
  ctx.lineTo(canvas.width, canvas.height - 10);
  ctx.stroke();
  
  ctx.strokeStyle = 'rgba(255, 40, 40, 0.08)';
  ctx.lineWidth = 2;
  const stripeGap = 20;
  ctx.beginPath();
  for (let x = 0; x < canvas.width; x += stripeGap) {
    ctx.moveTo(x, canvas.height);
    ctx.lineTo(x + 10, canvas.height - 10);
  }
  ctx.stroke();
  ctx.restore();
}

function updateLocalInterpolation() {
  Object.keys(renderPlayers).forEach(id => {
    const p = renderPlayers[id];
    if (p.isDead) return;

    p.renderX += (p.targetX - p.renderX) * 0.35;
    p.renderY += (p.targetY - p.renderY) * 0.35;
  });

  renderBullets.forEach(b => {
    b.vy += b.gravity;
    b.renderX += b.vx;
    b.renderY += b.vy;

    b.renderX += (b.targetX - b.renderX) * 0.25;
    b.renderY += (b.targetY - b.renderY) * 0.25;
  });
}

function drawGame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply Camera Shake translations
  ctx.save();
  if (screenShakeTime > 0) {
    const dx = (Math.random() - 0.5) * screenShakeIntensity;
    const dy = (Math.random() - 0.5) * screenShakeIntensity;
    ctx.translate(dx, dy);
    screenShakeTime--;
  }

  // Camera scroll positioning logic
  // Alive: Focus local player
  // Dead/Spectating: Focus the opponent killer
  const me = renderPlayers[myId];
  if (me) {
    if (!me.isDead) {
      camX = me.renderX;
      camY = me.renderY;
      camZoom = 1.0;
    } else {
      // dead, spectate killer
      const killerId = me.spectateTargetId;
      const killer = renderPlayers[killerId];
      if (killer && !killer.isDead) {
        camX = killer.renderX;
        camY = killer.renderY;
        camZoom = 1.4; // zoom in on killer action
      } else {
        camX = me.renderX;
        camY = me.renderY;
        camZoom = 1.25; // fallback zoom
      }
    }
  } else {
    camX = canvas.width / 2;
    camY = canvas.height / 2;
    camZoom = 1.0;
  }

  // Lerp camera coordinates for smooth pans
  currentCamX += (camX - currentCamX) * 0.08;
  currentCamY += (camY - currentCamY) * 0.08;
  currentCamZoom += (camZoom - currentCamZoom) * 0.08;

  // Clamp camera position so bounds are kept slightly cleaner
  // (We don't clamp too tightly to allow viewing offscreen falloffs)
  const paddingX = canvas.width / (2 * currentCamZoom);
  const paddingY = canvas.height / (2 * currentCamZoom);
  currentCamX = Math.max(0 - 100, Math.min(canvas.width + 100, currentCamX));
  currentCamY = Math.max(0 - 150, Math.min(canvas.height + 150, currentCamY));

  // Transform matrix for Camera Viewport
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(currentCamZoom, currentCamZoom);
  ctx.translate(-currentCamX, -currentCamY);

  // Draw Arena layout inside camera frame
  drawArena();

  // Draw FX particles
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].draw(ctx);
    if (particles[i].life <= 0) {
      particles.splice(i, 1);
    }
  }

  // Draw Laser Sights (if not disabled)
  if (settings.laserStyle !== 'none' && me && !me.isDead && currentGameState === 'PLAYING') {
    aimAngle = Math.atan2(mousePos.y - me.renderY, mousePos.x - me.renderX);
    
    ctx.save();
    ctx.strokeStyle = me.color;
    ctx.shadowBlur = 8;
    ctx.shadowColor = me.color;
    ctx.lineWidth = 1.5;
    
    if (settings.laserStyle === 'dashed') {
      ctx.setLineDash([4, 6]);
    }
    
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(me.renderX, me.renderY);
    ctx.lineTo(mousePos.x, mousePos.y);
    ctx.stroke();
    
    // Laser dot at mouse end
    ctx.beginPath();
    ctx.arc(mousePos.x, mousePos.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = me.color;
    ctx.globalAlpha = 0.8;
    ctx.fill();
    ctx.restore();
  }

  // Draw Bullets
  renderBullets.forEach(b => {
    ctx.save();
    if (b.trail && b.trail.length > 1) {
      ctx.beginPath();
      ctx.moveTo(b.trail[0].x, b.trail[0].y);
      for (let k = 1; k < b.trail.length; k++) {
        ctx.lineTo(b.trail[k].x, b.trail[k].y);
      }
      ctx.lineTo(b.renderX, b.renderY);
      
      const grad = ctx.createLinearGradient(b.trail[0].x, b.trail[0].y, b.renderX, b.renderY);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, b.color);
      
      ctx.strokeStyle = grad;
      ctx.lineWidth = b.radius * 1.5;
      ctx.stroke();
    }

    ctx.shadowBlur = 12;
    ctx.shadowColor = b.color;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.renderX, b.renderY, b.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Draw Players
  Object.keys(renderPlayers).forEach(id => {
    const p = renderPlayers[id];
    if (p.isDead) return;

    ctx.save();
    ctx.shadowBlur = 15;
    ctx.shadowColor = p.color;

    // Body outer rim
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.renderX, p.renderY, p.radius, 0, Math.PI * 2);
    ctx.fill();

    // Body inner glass core
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#06090f';
    ctx.beginPath();
    ctx.arc(p.renderX, p.renderY, p.radius * 0.72, 0, Math.PI * 2);
    ctx.fill();

    // Gun nozzle tube
    let theta = 0;
    if (p.id === myId) {
      theta = aimAngle;
    } else {
      theta = Math.atan2(p.vy, p.vx);
      if (Math.abs(p.vx) < 0.1 && Math.abs(p.vy) < 0.1) {
        theta = -Math.PI / 2;
      }
    }

    ctx.save();
    ctx.translate(p.renderX, p.renderY);
    ctx.rotate(theta);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.radius * 0.5, -3, p.radius * 0.6, 6);
    ctx.restore();

    // Nickname tag text
    ctx.shadowBlur = 5;
    ctx.shadowColor = '#000000';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px Inter';
    ctx.textAlign = 'center';
    ctx.fillText(p.nickname, p.renderX, p.renderY - p.radius - 6);

    ctx.restore();
  });

  ctx.restore(); // Restore camera scaling translation matrix
  ctx.restore(); // Restore camera shake translations
}

// Tick Game Client Loops
function clientGameLoop() {
  if (currentGameState === 'PLAYING' || currentGameState === 'SPECTATING') {
    updateLocalInterpolation();
    drawGame();
  }
  requestAnimationFrame(clientGameLoop);
}

requestAnimationFrame(clientGameLoop);
