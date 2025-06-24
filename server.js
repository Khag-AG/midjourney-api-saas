// server.js - Супер продвинутая версия с асинхронной генерацией
const express = require('express');
const { Midjourney } = require('midjourney');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const activeTasks = new Map(); // Хранилище активных задач

app.use(express.json());
app.use(express.static('public'));

// Директория для хранения данных
const DATA_DIR = path.join(__dirname, 'data');

// Инициализация директории данных
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating data directory:', error);
  }
}

// Файловая база данных
class FileDB {
  constructor(filename) {
    this.filepath = path.join(DATA_DIR, filename);
    this.data = new Map();
  }

  async load() {
    try {
      const content = await fs.readFile(this.filepath, 'utf8');
      const parsed = JSON.parse(content);
      this.data = new Map(parsed);
    } catch (error) {
      this.data = new Map();
    }
  }

  async save() {
    try {
      const content = JSON.stringify([...this.data]);
      await fs.writeFile(this.filepath, content, 'utf8');
    } catch (error) {
      console.error('Error saving to file:', error);
    }
  }

  get(key) { return this.data.get(key); }
  set(key, value) { this.data.set(key, value); this.save(); return this; }
  has(key) { return this.data.has(key); }
  delete(key) { const result = this.data.delete(key); this.save(); return result; }
  get size() { return this.data.size; }
  entries() { return this.data.entries(); }
  values() { return Array.from(this.data.values()); }
}

// Инициализация баз данных
const users = new FileDB('users.json');
const userUsage = new FileDB('usage.json');
const generationHistory = new FileDB('history.json');
const userSessions = new Map();

// Инициализация
async function init() {
  await initDataDir();
  await users.load();
  await userUsage.load();
  await generationHistory.load();
  console.log(`📊 Загружено ${users.size} пользователей из базы данных`);
}

// Функция генерации API ключей
function generateApiKey() {
  return 'mj_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Middleware для проверки API ключей
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API ключ обязателен. Добавьте заголовок X-API-Key' });
  }
  
  const user = users.get(apiKey);
  if (!user) {
    return res.status(401).json({ error: 'Недействительный API ключ' });
  }
  
  // Проверяем статус пользователя
  if (user.status === 'blocked') {
    return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });
  }
  
  // Для админов пропускаем проверку лимитов
  if (user.role === 'admin') {
    req.user = user;
    req.apiKey = apiKey;
    return next();
  }
  
  // Проверяем лимиты для обычных пользователей
  const currentUsage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
  
  // Проверяем нужно ли сбросить счетчик (раз в месяц)
  const now = new Date();
  const resetDate = new Date(currentUsage.resetDate);
  if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
    currentUsage.count = 0;
    currentUsage.resetDate = now;
    userUsage.set(apiKey, currentUsage);
  }
  
  if (currentUsage.count >= user.monthlyLimit) {
    return res.status(429).json({ 
      error: 'Превышен месячный лимит генераций',
      limit: user.monthlyLimit,
      used: currentUsage.count,
      resetDate: currentUsage.resetDate
    });
  }
  
  req.user = user;
  req.apiKey = apiKey;
  next();
}

// Функция создания Midjourney клиента
async function getMidjourneyClient(user) {
  try {
    const client = new Midjourney({
      ServerId: user.serverId,
      ChannelId: user.channelId,
      SalaiToken: user.salaiToken,
      Debug: false,
      Ws: true
    });
    
    await client.init();
    
    // Добавляем обработку ошибок WebSocket
    if (client.ws) {
      client.ws.on('error', (error) => {
        console.error('❌ WebSocket ошибка:', error.message);
        // Удаляем клиент из кеша при ошибке
        const apiKey = Array.from(userSessions.entries())
          .find(([key, val]) => val === client)?.[0];
        if (apiKey) {
          userSessions.delete(apiKey);
        }
      });
      
      client.ws.on('close', () => {
        console.log('🔌 WebSocket соединение закрыто');
        // Удаляем клиент из кеша при закрытии
        const apiKey = Array.from(userSessions.entries())
          .find(([key, val]) => val === client)?.[0];
        if (apiKey) {
          userSessions.delete(apiKey);
        }
      });
    }
    
    return client;
  } catch (error) {
    console.error('❌ Ошибка создания Midjourney клиента:', error);
    throw error;
  }
}

// === API ENDPOINTS ===

// Проверка статуса системы
app.get('/health', (req, res) => {
  const totalUsers = users.size;
  const activeUsers = Array.from(users.entries()).filter(([_, user]) => user.status === 'active').length;
  const blockedUsers = Array.from(users.entries()).filter(([_, user]) => user.status === 'blocked').length;
  const adminUsers = Array.from(users.entries()).filter(([_, user]) => user.role === 'admin').length;
  
  res.json({
    status: 'ok',
    stats: {
      totalUsers,
      activeUsers,
      blockedUsers,
      adminUsers,
      activeSessions: userSessions.size,
      activeTasks: activeTasks.size
    },
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ADMIN: Создание нового пользователя
app.post('/admin/users', async (req, res) => {
  const { serverId, channelId, salaiToken, monthlyLimit = 100, userEmail, role = 'user' } = req.body;
  
  if (!serverId || !channelId || !salaiToken || !userEmail) {
    return res.status(400).json({
      error: 'Требуются: serverId, channelId, salaiToken, userEmail'
    });
  }
  
  const apiKey = generateApiKey();
  const user = {
    apiKey,
    serverId,
    channelId,
    salaiToken,
    monthlyLimit: role === 'admin' ? -1 : monthlyLimit,
    userEmail,
    role,
    createdAt: new Date().toISOString(),
    status: 'active'
  };
  
  users.set(apiKey, user);
  userUsage.set(apiKey, { count: 0, resetDate: new Date() });
  
  console.log(`👤 Новый ${role} создан: ${userEmail}`);
  
  res.json({
    success: true,
    apiKey: apiKey,
    user: {
      email: userEmail,
      monthlyLimit: user.monthlyLimit,
      role: user.role,
      status: 'active'
    }
  });
});

// ADMIN: Список всех пользователей
app.get('/admin/users', (req, res) => {
  const userList = Array.from(users.entries()).map(([apiKey, user]) => {
    const usage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
    return {
      apiKey: apiKey,
      email: user.userEmail,
      monthlyLimit: user.monthlyLimit,
      currentUsage: usage.count,
      resetDate: usage.resetDate,
      status: user.status,
      role: user.role || 'user',
      createdAt: user.createdAt,
      serverId: user.serverId,
      channelId: user.channelId,
      salaiToken: "***hidden***"
    };
  });
  
  res.json({ users: userList, total: users.size });
});

// ADMIN: Получение деталей конкретного пользователя
app.get('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  const user = users.get(apiKey);
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const usage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
  const history = generationHistory.get(apiKey) || [];
  
  res.json({
    ...user,
    currentUsage: usage.count,
    resetDate: usage.resetDate,
    history: history.slice(-10)
  });
});

// ADMIN: Обновление пользователя
app.put('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  const updates = req.body;
  
  const user = users.get(apiKey);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const allowedFields = ['monthlyLimit', 'status', 'role', 'userEmail'];
  const updatedUser = { ...user };
  
  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      updatedUser[field] = updates[field];
    }
  });
  
  if (updatedUser.role === 'admin') {
    updatedUser.monthlyLimit = -1;
  }
  
  users.set(apiKey, updatedUser);
  
  console.log(`✏️ Пользователь обновлен: ${updatedUser.userEmail}`);
  
  res.json({ success: true, user: updatedUser });
});

// ADMIN: Удаление пользователя
app.delete('/admin/users/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  
  if (!users.has(apiKey)) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  const user = users.get(apiKey);
  users.delete(apiKey);
  userUsage.delete(apiKey);
  generationHistory.delete(apiKey);
  userSessions.delete(apiKey);
  
  console.log(`🗑️ Пользователь удален: ${user.userEmail}`);
  
  res.json({ success: true, message: 'Пользователь удален' });
});

// ADMIN: Сброс лимитов пользователя
app.post('/admin/users/:apiKey/reset', (req, res) => {
  const { apiKey } = req.params;
  
  if (!users.has(apiKey)) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  userUsage.set(apiKey, { count: 0, resetDate: new Date() });
  
  console.log(`🔄 Лимиты сброшены для: ${users.get(apiKey).userEmail}`);
  
  res.json({ success: true, message: 'Лимиты сброшены' });
});

// ADMIN: Блокировка/разблокировка пользователя
app.post('/admin/users/:apiKey/toggle-block', (req, res) => {
  const { apiKey } = req.params;
  const user = users.get(apiKey);
  
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }
  
  user.status = user.status === 'blocked' ? 'active' : 'blocked';
  users.set(apiKey, user);
  
  console.log(`${user.status === 'blocked' ? '🔒' : '🔓'} Пользователь ${user.userEmail} ${user.status === 'blocked' ? 'заблокирован' : 'разблокирован'}`);
  
  res.json({ success: true, status: user.status });
});

// ADMIN: История генераций
app.get('/admin/history', (req, res) => {
  const allHistory = [];
  
  generationHistory.entries().forEach(([apiKey, history]) => {
    const user = users.get(apiKey);
    history.forEach(item => {
      allHistory.push({
        ...item,
        userEmail: user?.userEmail || 'Deleted User',
        apiKey: apiKey.substring(0, 8) + '...'
      });
    });
  });
  
  allHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  res.json({ history: allHistory.slice(0, 100) });
});

// USER: Генерация изображения (АСИНХРОННАЯ ВЕРСИЯ)
app.post('/api/generate', validateApiKey, async (req, res) => {
  try {
    const { prompt } = req.body;
    const { user, apiKey } = req;
    
    if (!prompt) {
      return res.status(400).json({
        error: 'Параметр prompt обязателен',
        example: { prompt: 'beautiful sunset over mountains' }
      });
    }
    
    // Генерируем уникальный task_id
    const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    
    console.log(`🎨 Запуск генерации для ${user.userEmail}: "${prompt}" (Task: ${taskId})`);
    
    // Сохраняем начальный статус
    activeTasks.set(taskId, {
      status: 'processing',
      prompt: prompt,
      user: user.userEmail,
      apiKey: apiKey,
      startedAt: new Date().toISOString()
    });
    
    // Сразу возвращаем task_id
    res.json({
      success: true,
      task_id: taskId,
      status: 'processing',
      message: 'Генерация запущена'
    });
    
    // Запускаем генерацию в фоне
    (async () => {
      try {
        let client = userSessions.get(apiKey);
        if (!client) {
          client = await getMidjourneyClient(user);
          userSessions.set(apiKey, client);
        }
        
        const result = await client.Imagine(prompt, (uri, progress) => {
          console.log(`${user.userEmail} - Прогресс: ${progress}`);
          const task = activeTasks.get(taskId);
          if (task) {
            task.progress = progress;
            activeTasks.set(taskId, task);
          }
        });
        
        // Обновляем статус на completed
        activeTasks.set(taskId, {
          status: 'completed',
          prompt: prompt,
          image_url: result.uri,
          midjourney_id: result.id,
          hash: result.hash || extractHashFromUrl(result.uri),
          user: user.userEmail,
          apiKey: apiKey,
          completedAt: new Date().toISOString()
        });
        
        // Обновляем счетчики и историю
        let currentUsage = userUsage.get(apiKey) || { count: 0, resetDate: new Date() };
        if (user.role !== 'admin') {
          currentUsage.count += 1;
          userUsage.set(apiKey, currentUsage);
        }
        
        const historyItem = {
          prompt,
          imageUrl: result.uri,
          taskId: result.id,
          hash: result.hash || extractHashFromUrl(result.uri),
          timestamp: new Date().toISOString()
        };
        
        const history = generationHistory.get(apiKey) || [];
        history.push(historyItem);
        generationHistory.set(apiKey, history);
        
        console.log(`✅ Генерация завершена: ${taskId} -> ${result.id}`);
        console.log(`📎 Тип вложения: ${result.uri.includes('ephemeral') ? 'ВРЕМЕННОЕ' : 'ПОСТОЯННОЕ'}`);

        // Если временное вложение, ждем появления постоянного
        if (result.uri.includes('ephemeral')) {
          console.log('⚠️ Получено временное вложение, ждем постоянное...');
          
          // Ждем до 30 секунд для получения постоянного вложения
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            try {
              const checkResponse = await fetch(`https://discord.com/api/v9/channels/${user.channelId}/messages/${result.id}`, {
                headers: {
                  'Authorization': user.salaiToken,
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
              });
              
              if (checkResponse.ok) {
                const message = await checkResponse.json();
                if (message.attachments && message.attachments.length > 0) {
                  const attachment = message.attachments[0];
                  if (!attachment.url.includes('ephemeral')) {
                    console.log('✅ Получено постоянное вложение!');
                    result.uri = attachment.url;
                    
                    // Обновляем в активной задаче
                    const task = activeTasks.get(taskId);
                    if (task) {
                      task.image_url = attachment.url;
                      activeTasks.set(taskId, task);
                    }
                    
                    // Обновляем в истории
                    const historyIndex = history.length - 1;
                    if (historyIndex >= 0) {
                      history[historyIndex].imageUrl = attachment.url;
                      generationHistory.set(apiKey, history);
                    }
                    
                    break;
                  }
                }
              }
            } catch (error) {
              console.log(`Попытка ${i + 1}/10 получить постоянное вложение...`);
            }
          }
        }

        console.log('✅ Изображение готово для upscale');
        
      } catch (error) {
        console.error(`❌ Ошибка генерации для ${taskId}:`, error.message);
        activeTasks.set(taskId, {
          status: 'failed',
          error: error.message,
          prompt: prompt,
          user: user.userEmail,
          apiKey: apiKey,
          failedAt: new Date().toISOString()
        });
      }
    })();
    
  } catch (error) {
    console.error('❌ Ошибка запуска генерации:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// USER: Проверка статуса генерации
app.get('/api/task/:taskId', validateApiKey, (req, res) => {
  const { taskId } = req.params;
  const task = activeTasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({
      error: 'Задача не найдена',
      task_id: taskId
    });
  }
  
  // Проверяем что это задача текущего пользователя
  if (task.apiKey !== req.apiKey && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Доступ запрещен'
    });
  }
  
  const response = {
    task_id: taskId,
    status: task.status,
    prompt: task.prompt
  };
  
  if (task.status === 'completed') {
    response.image_url = task.image_url;
    response.midjourney_id = task.midjourney_id;
    response.task_id = task.midjourney_id;  // Для совместимости с upscale
    response.is_ephemeral = task.image_url && task.image_url.includes('ephemeral');
    
    // Если изображение все еще временное, добавляем рекомендацию подождать
    if (response.is_ephemeral) {
      response.recommendation = 'Image has ephemeral attachment. Wait 30-60 seconds before upscale.';
    }
    
    // Удаляем выполненную задачу через 5 минут
    setTimeout(() => {
      activeTasks.delete(taskId);
    }, 300000);
  } else if (task.status === 'failed') {
    response.error = task.error;
  } else if (task.progress !== undefined) {
    response.progress = task.progress;
  }
  
  res.json(response);
});

// ADMIN: Список всех активных задач
app.get('/api/tasks', validateApiKey, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Только для администраторов' });
  }
  
  const tasks = Array.from(activeTasks.entries()).map(([id, task]) => ({
    task_id: id,
    status: task.status,
    user: task.user,
    prompt: task.prompt,
    progress: task.progress,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    error: task.error
  }));
  
  res.json({ tasks, total: tasks.length });
});

// Генерация nonce как в Discord
function generateNonce() {
  const timestamp = Date.now();
  return timestamp.toString();
}

// Генерация session ID
function generateSessionId() {
  const hex = 'abcdef0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += hex[Math.floor(Math.random() * hex.length)];
  }
  return result;
}

// Генерация правильного X-Super-Properties
function generateSuperProperties() {
  const properties = {
    os: "Mac OS X",
    browser: "Discord Client",
    release_channel: "stable",
    client_version: "0.0.309",
    os_version: "23.2.0",
    os_arch: "arm64",
    app_arch: "arm64",
    system_locale: "en-US",
    browser_user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36",
    browser_version: "28.2.10",
    client_build_number: 306178,
    native_build_number: 50968,
    client_event_source: null
  };
  
  return Buffer.from(JSON.stringify(properties)).toString('base64');
}

// Ожидание результата upscale
async function waitForUpscaleResult(channelId, salaiToken, originalMessageId, index, maxAttempts = 30) {
  console.log(`⏳ Ожидаем результат upscale для сообщения ${originalMessageId}, картинка ${index}`);
  
  // Небольшая начальная задержка
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=50`, {
        headers: {
          'Authorization': salaiToken,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36'
        }
      });
      if (!response.ok) continue;
      const messages = await response.json();
      for (const msg of messages) {
        if (msg.author.id === '936929561302675456' && msg.attachments && msg.attachments.length > 0) {
          // Проверяем по содержимому или reference
          if (msg.content && (msg.content.includes(`Image #${index}`) || msg.content.includes('Upscaled by'))) {
            console.log('✅ Найден результат upscale по содержимому!');
            return { success: true, url: msg.attachments[0].url, proxy_url: msg.attachments[0].proxy_url, message_id: msg.id };
          }
          if (msg.reference && msg.reference.message_id === originalMessageId) {
            console.log('✅ Найден результат upscale по reference!');
            return { success: true, url: msg.attachments[0].url, proxy_url: msg.attachments[0].proxy_url, message_id: msg.id };
          }
        }
      }
    } catch (error) {
      console.error(`Попытка ${attempt + 1}: ${error.message}`);
    }
  }
  return { success: false, error: 'Timeout waiting for upscale result' };
}

// Исправленная функция upscale с поддержкой временных вложений
async function customUpscale(messageId, index, hash, user) {
  console.log('🚀 Используем собственную реализацию upscale');
  console.log('📋 Параметры upscale:', {
    messageId,
    index,
    hash,
    serverId: user.serverId,
    channelId: user.channelId,
    userEmail: user.userEmail
  });
  
  // Для временных вложений нужен особый подход
  // Пробуем несколько вариантов custom_id
  const customIds = [
    `MJ::JOB::upsample::${index}::${hash}`,
    `MJ::JOB::upsample_v2::${index}::${hash}`,
    `MJ::JOB::high_variation::${index}::${hash}`
  ];
  
  let lastError = null;
  
  for (const customId of customIds) {
    const nonce = generateNonce();
    const sessionId = generateSessionId();
    
    const payload = {
      type: 3,
      nonce: nonce,
      guild_id: user.serverId,
      channel_id: user.channelId,
      message_flags: 0,
      message_id: messageId,
      application_id: '936929561302675456',
      session_id: sessionId,
      data: { 
        component_type: 2, 
        custom_id: customId 
      }
    };

    console.log('📤 Пробуем custom_id:', customId);
    
    try {
      const response = await fetch('https://discord.com/api/v9/interactions', {
        method: 'POST',
        headers: {
          'Authorization': user.salaiToken,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) discord/0.0.309 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          'Origin': 'https://discord.com',
          'Pragma': 'no-cache',
          'Referer': `https://discord.com/channels/${user.serverId}/${user.channelId}`,
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Debug-Options': 'bugReporterEnabled',
          'X-Discord-Locale': 'en-US',
          'X-Discord-Timezone': 'Europe/Moscow',
          'X-Super-Properties': generateSuperProperties()
        },
        body: JSON.stringify(payload)
      });

      const statusCode = response.status;
      const responseText = await response.text();
      console.log(`📥 Discord ответ: ${statusCode}`);
      
      if (statusCode === 204) {
        console.log('✅ Команда upscale принята Discord!');
        
        // Увеличиваем время ожидания результата
        const result = await waitForUpscaleResult(user.channelId, user.salaiToken, messageId, index, 45);
        
        if (result.success) {
          return { 
            uri: result.url, 
            proxy_url: result.proxy_url, 
            success: true,
            message_id: result.message_id
          };
        }
        throw new Error(result.error || 'Failed to get upscale result');
      } else if (statusCode === 404) {
        lastError = 'Message not found';
        continue; // Пробуем следующий custom_id
      } else {
        lastError = `Discord API error: ${statusCode} - ${responseText}`;
        continue;
      }
    } catch (error) {
      lastError = error.message;
      continue;
    }
  }
  
  // Если все попытки не удались
  throw new Error(lastError || 'Failed to upscale with all custom_id variants');
}

// Извлечение hash из URL изображения
function extractHashFromUrl(url) {
  if (!url) return null;
  const hashMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  return hashMatch ? hashMatch[1] : null;
}

// Проверка возраста сообщения Discord
function getTimestampFromSnowflake(snowflake) {
  const DISCORD_EPOCH = 1420070400000;
  const timestamp = Number((BigInt(snowflake) >> 22n)) + DISCORD_EPOCH;
  return timestamp;
}

// USER: Upscale изображения с поддержкой бинарного вывода
app.post('/api/upscale', validateApiKey, async (req, res) => {
  try {
    const { task_id, index } = req.body;
    const idx = parseInt(index, 10);
    const { user, apiKey } = req;
    
    if (!task_id || Number.isNaN(idx)) {
      return res.status(400).json({
        error: 'Параметры task_id и index обязательны',
        example: { 
          task_id: "1379740446099771424", 
          index: 1,
          note: "index должен быть от 1 до 4"
        }
      });
    }
    
    if (idx < 1 || idx > 4) {
      return res.status(400).json({
        error: 'Параметр index должен быть от 1 до 4',
        detail: '1 - верхняя левая, 2 - верхняя правая, 3 - нижняя левая, 4 - нижняя правая'
      });
    }
    
    console.log(`🔍 Upscale для ${user.userEmail}: задача ${task_id}, картинка ${idx}`);
    
    // Проверяем возраст сообщения
    const messageAge = Date.now() - getTimestampFromSnowflake(task_id);
    const MAX_AGE = 15 * 60 * 1000; // 15 минут
    
    if (messageAge > MAX_AGE) {
      return res.status(400).json({
        error: 'Button expired. Discord buttons are only valid for 15 minutes after generation.',
        age_minutes: Math.floor(messageAge / 60000),
        max_age_minutes: 15
      });
    }
    
    // Проверяем в активных задачах
    const activeTask = Array.from(activeTasks.values()).find(task => 
      task.midjourney_id === task_id && task.status === 'completed'
    );
    
    // Если не нашли в активных, ищем в истории
    const history = generationHistory.get(apiKey) || [];
    const originalTask = activeTask || history.find(item => item.taskId === task_id);
    
    if (!originalTask || !(originalTask.imageUrl || originalTask.image_url)) {
      return res.status(404).json({
        error: 'Задача не найдена. Сначала сгенерируйте изображение.',
        details: 'Убедитесь, что используете правильный task_id из результата генерации'
      });
    }
    
    const imageUrl = originalTask.imageUrl || originalTask.image_url;
    
    // Сначала проверяем, есть ли hash в задаче
    let hash = originalTask.hash;
    
    // Если нет, извлекаем из URL
    if (!hash && imageUrl) {
      hash = extractHashFromUrl(imageUrl);
    }
    
    if (!hash) {
      console.error('❌ Не удалось извлечь hash из URL:', imageUrl);
      return res.status(400).json({
        error: 'Не удалось извлечь hash из URL изображения',
        imageUrl: imageUrl
      });
    }
    
    console.log(`📌 Извлечен hash: ${hash}`);
    console.log(`🔗 URL изображения: ${imageUrl}`);
    
    // Увеличиваем задержку для временных вложений
    if (imageUrl.includes('ephemeral')) {
      console.log('⚠️ Обнаружено временное вложение, увеличиваем задержку...');
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 секунд для временных
    } else {
      console.log('⏳ Ждем 2 секунды перед upscale...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    try {
      // Используем библиотеку midjourney для upscale
      let client = userSessions.get(apiKey);
      if (!client) {
        client = await getMidjourneyClient(user);
        userSessions.set(apiKey, client);
      }
      
      console.log('📚 Используем библиотеку Midjourney для upscale');
      
      // Midjourney библиотека принимает hash и флаги
      const flags = 0; // Default flags
      const loading = (uri, progress) => {
        console.log(`Upscale прогресс: ${progress}%`);
      };
      
      const result = await client.Upscale({
        index: idx,
        msgId: task_id,
        hash: hash,
        flags: flags,
        loading: loading
      });
      
      if (!result || !result.uri) {
        throw new Error('Failed to get upscale result from Midjourney library');
      }
      
      console.log(`✅ Upscale завершен для ${user.userEmail}`);
      console.log(`📎 URL результата: ${result.uri}`);
      
      const needBinary = req.headers['x-make-binary'] === 'true' || 
                        req.query.binary === 'true' ||
                        req.headers['accept'] === 'application/octet-stream';
      
      if (needBinary) {
        console.log(`📥 Бинарный режим активирован`);
        
        try {
          const https = require('https');
          const resultUrl = new URL(result.uri);
          
          https.get(resultUrl, (imageResponse) => {
            if (imageResponse.statusCode !== 200) {
              throw new Error(`HTTP error! status: ${imageResponse.statusCode}`);
            }
            
            const chunks = [];
            
            imageResponse.on('data', (chunk) => {
              chunks.push(chunk);
            });
            
            imageResponse.on('end', () => {
              const imageBuffer = Buffer.concat(chunks);
              
              console.log(`✅ Загружено изображение: ${imageBuffer.length} байт`);
              
              res.set({
                'Content-Type': 'image/png',
                'Content-Length': imageBuffer.length,
                'Content-Disposition': `attachment; filename="midjourney_upscaled_${idx}_${Date.now()}.png"`,
                'X-Image-URL': result.uri,
                'X-Task-ID': task_id,
                'X-Selected-Index': idx.toString()
              });
              
              res.send(imageBuffer);
            });
            
            imageResponse.on('error', (error) => {
              console.error('⚠️ Ошибка загрузки изображения:', error.message);
              res.json({
                success: true,
                image_url: result.uri,
                error: 'Не удалось загрузить изображение для бинарной отправки'
              });
            });
          }).on('error', (error) => {
            console.error('⚠️ Ошибка HTTPS запроса:', error.message);
            res.json({
              success: true,
              image_url: result.uri,
              error: 'Не удалось загрузить изображение для бинарной отправки'
            });
          });
          
          return;
          
        } catch (error) {
          console.error('⚠️ Ошибка в бинарном режиме:', error.message);
          return res.json({
            success: true,
            image_url: result.uri,
            error: 'Не удалось загрузить изображение для бинарной отправки'
          });
        }
      }
      
      // Сохраняем в историю
      const historyItem = {
        action: 'upscale',
        originalTaskId: task_id,
        selectedIndex: idx,
        imageUrl: result.uri,
        timestamp: new Date().toISOString()
      };
      
      history.push(historyItem);
      generationHistory.set(apiKey, history);
      
      res.json({
        success: true,
        image_url: result.uri,
        original_task_id: task_id,
        selected_index: idx,
        description: `Картинка ${idx} увеличена`,
        timestamp: new Date().toISOString()
      });
      
    } catch (upscaleError) {
      console.error('❌ Ошибка библиотеки Midjourney:', upscaleError.message);
      
      // Если библиотека не сработала, пробуем наш метод
      console.log('🔄 Пробуем альтернативный метод upscale...');
      
      try {
        const result = await customUpscale(task_id, idx, hash, user);
        
        console.log(`✅ Альтернативный upscale завершен для ${user.userEmail}`);
        
        res.json({
          success: true,
          image_url: result.uri,
          original_task_id: task_id,
          selected_index: idx,
          description: `Картинка ${idx} увеличена`,
          timestamp: new Date().toISOString()
        });
        
      } catch (customError) {
        console.error('❌ Ошибка альтернативного метода:', customError.message);
        
        // Возвращаем ошибку с полезной информацией
        return res.status(400).json({
          success: false,
          error: 'Failed to upscale image. The message might be too old or have temporary attachment.',
          suggestions: [
            'Убедитесь, что с момента генерации прошло менее 15 минут',
            'Попробуйте подождать 30-60 секунд после генерации',
            'Проверьте правильность task_id',
            'Попробуйте сгенерировать изображение заново'
          ],
          debug: {
            library_error: upscaleError.message,
            custom_error: customError.message
          }
        });
      }
    }
    
  } catch (error) {
    console.error('❌ Общая ошибка upscale:', error);
    console.error('Stack trace:', error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      type: 'general_error'
    });
  }
});

// Админ панель (HTML интерфейс)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Корневой роут
app.get('/', (req, res) => {
  res.json({
    name: 'Midjourney API Service',
    version: '2.1.5',
    endpoints: {
      health: '/health',
      admin: '/admin',
      api: {
        generate: 'POST /api/generate (async)',
        status: 'GET /api/task/:taskId',
        tasks: 'GET /api/tasks (admin only)',
        upscale: 'POST /api/upscale'
      }
    },
    changes: {
      '2.1.0': 'Добавлена асинхронная генерация с проверкой статуса',
      '2.1.1': 'Исправлена проблема с upscale - добавлены правильные headers и проверка возраста кнопок',
      '2.1.2': 'Добавлена обработка временных вложений (ephemeral) и ожидание постоянных URL',
      '2.1.3': 'Упрощена логика upscale - работаем с временными вложениями напрямую',
      '2.1.4': 'Добавлено ожидание преобразования временных вложений в постоянные',
      '2.1.5': 'Использование встроенного метода Midjourney для upscale'
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 8080;

init().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Супер Midjourney API запущен на порту ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`👥 Admin панель: http://localhost:${PORT}/admin`);
    console.log(`🎨 API генерации: POST http://localhost:${PORT}/api/generate`);
    console.log(`📍 API статуса: GET http://localhost:${PORT}/api/task/:taskId`);
    console.log(`🔍 API upscale: POST http://localhost:${PORT}/api/upscale`);
    console.log(`🌍 Среда: ${process.env.NODE_ENV || 'development'}`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });
});