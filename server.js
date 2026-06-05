const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Physics constants
const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;
const GRAVITY = 0.35;
const GROUND_FRICTION = 0.88;
const AIR_FRICTION = 0.98;
const JUMP_FORCE = -8.2;
const WALK_ACCEL = 0.22; // Slower movement speed (slowing down ground speed)
const MAX_WALK_SPEED = 2.0; // Slower movement speed (slowing down ground speed)

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 600;

// Arena Layout (Platforms players stand on)
const platforms = [
  // Left wall
  { x: -20, y: -200, width: 20, height: 1000, type: 'wall' },
  // Right wall
  { x: CANVAS_WIDTH, y: -200, width: 20, height: 1000, type: 'wall' },
  // Ceiling
  { x: -20, y: -20, width: CANVAS_WIDTH + 40, height: 20, type: 'ceiling' },
  
  // Left ground platform
  { x: 0, y: 500, width: 320, height: 30, type: 'ground' },
  // Right ground platform
  { x: 680, y: 500, width: 320, height: 30, type: 'ground' },
  // Middle low platform
  { x: 400, y: 430, width: 200, height: 20, type: 'platform' },
  // Left high platform
  { x: 120, y: 280, width: 240, height: 20, type: 'platform' },
  // Right high platform
  { x: 640, y: 280, width: 240, height: 20, type: 'platform' },
  // Central obstacle column (bumper)
  { x: 470, y: 160, width: 60, height: 80, type: 'bumper' }
];

// Weapon Configurations
const WEAPONS = {
  pistol: {
    cooldown: 350,
    bulletSpeed: 14,
    bulletGravity: 0,
    bulletRecoil: 4.5,
    playerKnockback: 8,
    maxBounces: 3,
    color: '#00f0ff',
    bulletsPerShot: 1,
    spread: 0,
    explosive: false
  },
  shotgun: {
    cooldown: 800,
    bulletSpeed: 13,
    bulletGravity: 0.08,
    bulletRecoil: 13,
    playerKnockback: 6,
    maxBounces: 1,
    color: '#ff00ff',
    bulletsPerShot: 5,
    spread: 0.28,
    explosive: false
  },
  sniper: {
    cooldown: 1100,
    bulletSpeed: 26,
    bulletGravity: 0,
    bulletRecoil: 15,
    playerKnockback: 18,
    maxBounces: 0,
    color: '#ffff00',
    bulletsPerShot: 1,
    spread: 0,
    explosive: false
  },
  rocket: {
    cooldown: 1400,
    bulletSpeed: 9,
    bulletGravity: 0.05,
    bulletRecoil: 9,
    playerKnockback: 5,
    maxBounces: 0,
    color: '#ff6600',
    bulletsPerShot: 1,
    spread: 0,
    explosive: true,
    explosionRadius: 130,
    explosionForce: 17
  },
  machinegun: {
    cooldown: 90,
    bulletSpeed: 16,
    bulletGravity: 0,
    bulletRecoil: 1.8,
    playerKnockback: 2.5,
    maxBounces: 1,
    color: '#39ff14',
    bulletsPerShot: 1,
    spread: 0.08,
    explosive: false
  }
};

const SPAWNS = [
  { x: 100, y: 450 },
  { x: 900, y: 450 },
  { x: 220, y: 240 },
  { x: 780, y: 240 },
  { x: 500, y: 380 },
  { x: 200, y: 450 },
  { x: 800, y: 450 },
  { x: 500, y: 100 }
];

function getRandomSpawn() {
  const index = Math.floor(Math.random() * SPAWNS.length);
  return { ...SPAWNS[index] };
}

// MULTI-ROOM PHYSICS CLASS
class GameRoom {
  constructor(name) {
    this.name = name;
    this.players = {}; // socketId -> Player object
    this.bullets = [];
    this.nextBulletId = 0;
    this.intervalId = null;
  }

  start() {
    this.intervalId = setInterval(() => {
      this.updatePhysics();
      // Broadcast state to only clients inside this socket room
      io.to(this.name).emit('game_update', {
        players: this.players,
        bullets: this.bullets
      });
    }, TICK_INTERVAL);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  updatePhysics() {
    const now = Date.now();

    // 1. Update Player Physics
    Object.keys(this.players).forEach(id => {
      const player = this.players[id];
      
      // Spectating / Dead players update cooldowns but don't move or collide
      if (player.isDead) {
        if (player.cooldown > 0) player.cooldown -= TICK_INTERVAL;
        
        // Handle automated respawn check
        if (player.respawnTime && now >= player.respawnTime) {
          this.respawnPlayer(player);
        }
        return;
      }

      // Apply gravity
      player.vy += GRAVITY;

      // Apply movement inputs
      let horizontalInput = 0;
      if (player.inputs.left) horizontalInput -= 1;
      if (player.inputs.right) horizontalInput += 1;

      if (horizontalInput !== 0) {
        player.vx += horizontalInput * WALK_ACCEL;
        // Clamp normal walk speed
        const speedSign = Math.sign(player.vx);
        const absSpeed = Math.abs(player.vx);
        if (absSpeed > MAX_WALK_SPEED && speedSign === horizontalInput) {
          // Keep high recoil momentum, don't speed up further
        } else {
          player.vx = Math.min(MAX_WALK_SPEED, Math.max(-MAX_WALK_SPEED, player.vx + horizontalInput * WALK_ACCEL));
        }
      } else {
        // Apply friction
        if (player.isGrounded) {
          player.vx *= GROUND_FRICTION;
        } else {
          player.vx *= AIR_FRICTION;
        }
      }
      
      // Jump input
      if (player.inputs.jump && player.isGrounded) {
        player.vy = JUMP_FORCE;
        player.isGrounded = false;
        io.to(this.name).emit('sound_trigger', { type: 'jump', playerId: id });
      }

      player.vy *= 0.99; // Air drag

      // Update position
      player.x += player.vx;
      player.y += player.vy;

      // Cooldown timer
      if (player.cooldown > 0) {
        player.cooldown -= TICK_INTERVAL;
      }

      player.isGrounded = false;

      // Platform collisions
      platforms.forEach(platform => {
        const closestX = Math.max(platform.x, Math.min(player.x, platform.x + platform.width));
        const closestY = Math.max(platform.y, Math.min(player.y, platform.y + platform.height));
        
        const dx = player.x - closestX;
        const dy = player.y - closestY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < player.radius) {
          const overlap = player.radius - distance;
          
          let nx = 0, ny = 0;
          if (distance > 0.01) {
            nx = dx / distance;
            ny = dy / distance;
          } else {
            ny = -1;
          }
          
          player.x += nx * overlap;
          player.y += ny * overlap;
          
          const dotProd = player.vx * nx + player.vy * ny;
          if (dotProd < 0) {
            player.vx -= dotProd * nx;
            player.vy -= dotProd * ny;
          }
          
          if (ny < -0.7) {
            player.isGrounded = true;
          }
        }
      });

      // Out of bounds death check
      if (player.y > CANVAS_HEIGHT + 50) {
        this.eliminatePlayer(player);
      }
    });

    // 2. Update Bullet Physics
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      
      bullet.vy += bullet.gravity;
      bullet.x += bullet.vx;
      bullet.y += bullet.vy;
      
      let bulletRemoved = false;

      // Out of bounds deletion
      if (bullet.x < -100 || bullet.x > CANVAS_WIDTH + 100 || bullet.y < -200 || bullet.y > CANVAS_HEIGHT + 150) {
        this.bullets.splice(i, 1);
        continue;
      }

      // Collisions with platforms
      for (let p = 0; p < platforms.length; p++) {
        const platform = platforms[p];
        const closestX = Math.max(platform.x, Math.min(bullet.x, platform.x + platform.width));
        const closestY = Math.max(platform.y, Math.min(bullet.y, platform.y + platform.height));
        
        const dx = bullet.x - closestX;
        const dy = bullet.y - closestY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < bullet.radius) {
          if (bullet.explosive) {
            this.triggerExplosion(bullet.x, bullet.y, bullet.ownerId, bullet.explosionRadius, bullet.explosionForce);
            this.bullets.splice(i, 1);
            bulletRemoved = true;
            break;
          }

          let nx = 0, ny = 0;
          if (distance > 0.01) {
            nx = dx / distance;
            ny = dy / distance;
          } else {
            ny = -1;
          }

          const overlap = bullet.radius - distance;
          bullet.x += nx * overlap;
          bullet.y += ny * overlap;

          const dotProd = bullet.vx * nx + bullet.vy * ny;
          if (dotProd < 0) {
            const restitution = 0.85;
            bullet.vx = bullet.vx - (1 + restitution) * dotProd * nx;
            bullet.vy = bullet.vy - (1 + restitution) * dotProd * ny;
            bullet.bounces++;
            
            io.to(this.name).emit('bullet_bounce', { x: bullet.x, y: bullet.y, color: bullet.color });
          }

          if (bullet.bounces > bullet.maxBounces) {
            this.bullets.splice(i, 1);
            bulletRemoved = true;
            break;
          }
        }
      }

      if (bulletRemoved) continue;

      // Collisions with players
      for (let pid in this.players) {
        const player = this.players[pid];
        if (player.isDead || pid === bullet.ownerId) continue;

        const dx = player.x - bullet.x;
        const dy = player.y - bullet.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < player.radius + bullet.radius) {
          // Log who shot the player last for killer-tracking
          player.lastHitBy = bullet.ownerId;
          player.lastHitTime = now;

          if (bullet.explosive) {
            this.triggerExplosion(bullet.x, bullet.y, bullet.ownerId, bullet.explosionRadius, bullet.explosionForce);
          } else {
            const bulletSpeed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
            let kx = 1, ky = 0;
            if (bulletSpeed > 0.01) {
              kx = bullet.vx / bulletSpeed;
              ky = bullet.vy / bulletSpeed;
            }

            player.vx += kx * bullet.playerKnockback;
            player.vy += ky * bullet.playerKnockback;

            const overlap = (player.radius + bullet.radius) - distance;
            player.x += kx * overlap;
            player.y += ky * overlap;

            io.to(this.name).emit('player_hit', { x: bullet.x, y: bullet.y, playerId: player.id });
          }

          this.bullets.splice(i, 1);
          bulletRemoved = true;
          break;
        }
      }
    }
  }

  triggerExplosion(ex, ey, ownerId, radius, force) {
    io.to(this.name).emit('explosion', { x: ex, y: ey, radius });
    const now = Date.now();

    Object.keys(this.players).forEach(pid => {
      const player = this.players[pid];
      if (player.isDead) return;

      const dx = player.x - ex;
      const dy = player.y - ey;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < radius + player.radius) {
        // Tag last hit if it was another player's rocket blast
        if (ownerId !== pid) {
          player.lastHitBy = ownerId;
          player.lastHitTime = now;
        }

        const effectDist = Math.max(10, distance);
        const forceRatio = 1 - (effectDist / (radius + player.radius));
        const actualForce = force * forceRatio;

        let nx = dx / effectDist;
        let ny = dy / effectDist;
        if (distance < 0.1) {
          const randAngle = Math.random() * Math.PI * 2;
          nx = Math.cos(randAngle);
          ny = Math.sin(randAngle);
        }

        player.vx += nx * actualForce;
        player.vy += ny * actualForce;
        player.isGrounded = false;
      }
    });
  }

  eliminatePlayer(player) {
    player.isDead = true;
    
    // Check if the death was caused by a killer recently
    let killer = null;
    const now = Date.now();
    if (player.lastHitBy && this.players[player.lastHitBy] && (now - player.lastHitTime < 6000)) {
      killer = this.players[player.lastHitBy];
      killer.wins++; // Increment score
    }

    // Set spectating focus target
    player.spectateTargetId = killer ? killer.id : null;
    player.respawnTime = now + 5000; // Schedule respawn in 5 seconds

    // Emit death event
    io.to(this.name).emit('player_died', {
      id: player.id,
      nickname: player.nickname,
      color: player.color,
      killerId: killer ? killer.id : null,
      killerName: killer ? killer.nickname : null,
      killerColor: killer ? killer.color : null
    });

    io.to(this.name).emit('sound_trigger', { type: 'death', playerId: player.id });
  }

  respawnPlayer(player) {
    const spawn = getRandomSpawn();
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.isDead = false;
    player.isGrounded = false;
    player.cooldown = 0;
    player.lastHitBy = null;
    player.lastHitTime = 0;
    player.respawnTime = null;
    player.spectateTargetId = null;

    io.to(this.name).emit('player_respawned', { id: player.id, x: spawn.x, y: spawn.y });
  }
}

// Global server room mapping
const rooms = {
  'US-East Physics': new GameRoom('US-East Physics'),
  'EU-West Bouncy': new GameRoom('EU-West Bouncy'),
  'Asia Recoil Pro': new GameRoom('Asia Recoil Pro')
};

// Start default rooms
Object.values(rooms).forEach(r => r.start());

function getRoomList() {
  return Object.values(rooms).map(r => ({
    name: r.name,
    playerCount: Object.keys(r.players).length
  }));
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  let currentRoom = null;

  // Send initial room list
  socket.emit('room_list', getRoomList());

  // Join a Room
  socket.on('join_room', (roomName) => {
    // If already in a room, leave it
    if (currentRoom) {
      leaveCurrentRoom();
    }

    const room = rooms[roomName];
    if (!room) {
      socket.emit('error_msg', 'Room does not exist!');
      return;
    }

    // Join socket.io channel
    socket.join(roomName);
    currentRoom = room;

    // Initialize player inside this room
    room.players[socket.id] = {
      id: socket.id,
      nickname: `Player_${socket.id.substring(0, 4)}`,
      color: '#00f0ff',
      gun: 'pistol',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 18,
      isGrounded: false,
      isDead: true, // starts in ready-lobby
      isReady: false,
      wins: 0,
      cooldown: 0,
      lastHitBy: null,
      lastHitTime: 0,
      respawnTime: null,
      spectateTargetId: null,
      inputs: { left: false, right: false, jump: false }
    };

    socket.emit('joined_room_confirm', {
      id: socket.id,
      roomName,
      players: room.players,
      platforms,
      WEAPONS
    });

    // Notify other players in this room
    socket.to(roomName).emit('player_joined', room.players[socket.id]);
    
    // Broadcast updated lobby room counts to everyone
    io.emit('room_list', getRoomList());
  });

  // Create custom Room
  socket.on('create_room', (roomName) => {
    const name = roomName.trim().substring(0, 18);
    if (!name) return;
    
    if (!rooms[name]) {
      rooms[name] = new GameRoom(name);
      rooms[name].start();
    }
    
    // Auto join
    socket.emit('room_created', name);
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;

    const room = currentRoom;
    socket.leave(room.name);
    
    // Delete player
    delete room.players[socket.id];
    
    // Notify others
    socket.to(room.name).emit('player_left', socket.id);
    
    // Stop room physics updates if empty custom room
    const defaultRooms = ['US-East Physics', 'EU-West Bouncy', 'Asia Recoil Pro'];
    if (Object.keys(room.players).length === 0 && !defaultRooms.includes(room.name)) {
      room.stop();
      delete rooms[room.name];
    }

    currentRoom = null;
    io.emit('room_list', getRoomList());
  }

  socket.on('leave_room', () => {
    leaveCurrentRoom();
    socket.emit('left_room_confirm');
    socket.emit('room_list', getRoomList());
  });

  // Profile update
  socket.on('update_profile', (profile) => {
    if (currentRoom && currentRoom.players[socket.id]) {
      const player = currentRoom.players[socket.id];
      if (profile.nickname) player.nickname = profile.nickname.substring(0, 14).replace(/<[^>]*>/g, '');
      if (profile.color) player.color = profile.color;
      if (profile.gun && WEAPONS[profile.gun]) player.gun = profile.gun;

      io.to(currentRoom.name).emit('player_updated', player);
    }
  });

  // Ready state (starts playing/spawns in arena immediately)
  socket.on('toggle_ready', (isReady) => {
    if (currentRoom && currentRoom.players[socket.id]) {
      const player = currentRoom.players[socket.id];
      player.isReady = isReady;

      if (isReady) {
        // Spawn active player
        const spawn = getRandomSpawn();
        player.x = spawn.x;
        player.y = spawn.y;
        player.vx = 0;
        player.vy = 0;
        player.isDead = false;
        player.isGrounded = false;
        player.cooldown = 0;
        player.lastHitBy = null;
        player.lastHitTime = 0;
        player.respawnTime = null;
        player.spectateTargetId = null;
      } else {
        // Put player to dead/spectate status
        player.isDead = true;
      }

      io.to(currentRoom.name).emit('player_updated', player);
    }
  });

  // Chat message
  socket.on('chat_message', (msg) => {
    if (currentRoom && currentRoom.players[socket.id]) {
      const player = currentRoom.players[socket.id];
      const cleanMsg = msg.trim().substring(0, 70).replace(/<[^>]*>/g, '');
      if (cleanMsg) {
        io.to(currentRoom.name).emit('chat_message', {
          sender: player.nickname,
          color: player.color,
          text: cleanMsg
        });
      }
    }
  });

  // Input sync
  socket.on('input', (inputs) => {
    if (currentRoom && currentRoom.players[socket.id]) {
      const player = currentRoom.players[socket.id];
      if (!player.isDead) {
        player.inputs = inputs;
      }
    }
  });

  // Shoot
  socket.on('shoot', (aimAngle) => {
    if (!currentRoom) return;
    const player = currentRoom.players[socket.id];
    if (!player || player.isDead || player.cooldown > 0) return;

    const gunConfig = WEAPONS[player.gun];
    player.cooldown = gunConfig.cooldown;

    // Recoil calculation
    const rx = -Math.cos(aimAngle);
    const ry = -Math.sin(aimAngle);
    player.vx += rx * gunConfig.bulletRecoil;
    player.vy += ry * gunConfig.bulletRecoil;
    player.isGrounded = false;

    // Bullet coordinates
    const startX = player.x + Math.cos(aimAngle) * (player.radius + 5);
    const startY = player.y + Math.sin(aimAngle) * (player.radius + 5);

    if (gunConfig.bulletsPerShot === 1) {
      const finalAngle = aimAngle + (Math.random() - 0.5) * gunConfig.spread;
      const vx = Math.cos(finalAngle) * gunConfig.bulletSpeed;
      const vy = Math.sin(finalAngle) * gunConfig.bulletSpeed;

      currentRoom.bullets.push({
        id: currentRoom.nextBulletId++,
        x: startX,
        y: startY,
        vx,
        vy,
        radius: player.gun === 'rocket' ? 6 : 4,
        gravity: gunConfig.bulletGravity,
        bounces: 0,
        maxBounces: gunConfig.maxBounces,
        explosive: gunConfig.explosive,
        explosionRadius: gunConfig.explosionRadius,
        explosionForce: gunConfig.explosionForce,
        ownerId: socket.id,
        color: gunConfig.color
      });
    } else {
      // Spread shotgun shot
      const halfSpread = ((gunConfig.bulletsPerShot - 1) * gunConfig.spread) / 2;
      for (let k = 0; k < gunConfig.bulletsPerShot; k++) {
        const offset = k * gunConfig.spread - halfSpread;
        const finalAngle = aimAngle + offset;
        const vx = Math.cos(finalAngle) * gunConfig.bulletSpeed;
        const vy = Math.sin(finalAngle) * gunConfig.bulletSpeed;

        currentRoom.bullets.push({
          id: currentRoom.nextBulletId++,
          x: startX,
          y: startY,
          vx,
          vy,
          radius: 3,
          gravity: gunConfig.bulletGravity,
          bounces: 0,
          maxBounces: gunConfig.maxBounces,
          explosive: gunConfig.explosive,
          ownerId: socket.id,
          color: gunConfig.color
        });
      }
    }

    io.to(currentRoom.name).emit('sound_trigger', { type: 'shoot', gun: player.gun, playerId: socket.id });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`=== KabitLOL Room-Based Server running on port ${PORT} ===`);
});
