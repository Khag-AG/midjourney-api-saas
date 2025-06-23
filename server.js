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
          timestamp: new Date().toISOString()
        };
        
        const history = generationHistory.get(apiKey) || [];
        history.push(historyItem);
        generationHistory.set(apiKey, history);
        
        console.log(`✅ Генерация завершена: ${taskId} -> ${result.id}`);
        console.log(`📎 Тип вложения: ${result.uri.includes('ephemeral') ? 'ВРЕМЕННОЕ' : 'ПОСТОЯННОЕ'}`);
        
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
  const timestamp = Date.now() - 1420070400000;
  const workerId = Math.floor(Math.random() * 1024);
  const processId = Math.floor(Math.random() * 16384);
  const counter = Math.floor(Math.random() * 4096);
  return ((timestamp * 524288) + (workerId * 16384) + processId * 4096 + counter).toString();
}

// Ожидание результата upscale
async function waitForUpscaleResult(channelId, salaiToken, originalMessageId, index, maxAttempts = 30) {
  console.log(`⏳ Ожидаем результат upscale для сообщения ${originalMessageId}, картинка ${index}`);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages?limit=50`, {
        headers: {
          'Authorization': salaiToken,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!response.ok) continue;
      const messages = await response.json();
      for (const msg of messages) {
        if (msg.author.id === '936929561302675456' && msg.attachments && msg.attachments.length > 0 && msg.content) {
          if (msg.content.includes(`Image #${index}`) || (msg.reference && msg.reference.message_id === originalMessageId)) {
            console.log('✅ Найден результат upscale!');
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

// Собственная реализация upscale через Discord API
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
  
  // Проверяем существование сообщения
  try {
    const checkUrl = `https://discord.com/api/v9/channels/${user.channelId}/messages/${messageId}`;
    console.log(`🔍 Проверяем сообщение: ${checkUrl}`);
    
    const checkResponse = await fetch(checkUrl, {
      headers: {
        'Authorization': user.salaiToken,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!checkResponse.ok) {
      const errorText = await checkResponse.text();
      console.error(`❌ Сообщение ${messageId} не найдено в канале ${user.channelId}`);
      console.error(`Ответ Discord: ${checkResponse.status} - ${errorText}`);
      throw new Error(`Message ${messageId} not found in channel ${user.channelId}`);
    }
    
    const message = await checkResponse.json();
    console.log('✅ Сообщение найдено:', {
      id: message.id,
      author: message.author?.username,
      hasComponents: !!message.components
    });
    
  } catch (error) {
    console.error('❌ Ошибка проверки сообщения:', error);
    // Продолжаем выполнение, так как сообщение может быть доступно для interaction
  }
  
  const customId = `MJ::JOB::upsample::${index}::${hash}`;
  const nonce = generateNonce();
  
  const payload = {
    type: 3,
    nonce,
    guild_id: user.serverId,
    channel_id: user.channelId,
    message_flags: 0,
    message_id: messageId,
    application_id: '936929561302675456',
    session_id: 'cb06f61453064c0983f2adae2a88c223',
    data: { 
      component_type: 2, 
      custom_id: customId 
    }
  };

  console.log('📤 Отправляем запрос на upscale:', { 
    messageId, 
    index, 
    customId, 
    nonce,
    guildId: user.serverId,
    channelId: user.channelId
  });
  
  try {
    const response = await fetch('https://discord.com/api/v9/interactions', {
      method: 'POST',
      headers: {
        'Authorization': user.salaiToken,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://discord.com',
        'Referer': `https://discord.com/channels/${user.serverId}/${user.channelId}`,
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Debug-Options': 'bugReporterEnabled',
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'Europe/Moscow'
      },
      body: JSON.stringify(payload)
    });

    const statusCode = response.status;
    const responseText = await response.text();
    console.log(`📥 Discord ответ: ${statusCode}`);
    if (responseText) console.log('Response body:', responseText);

    if (statusCode === 204) {
      console.log('✅ Команда upscale принята Discord!');
      const result = await waitForUpscaleResult(user.channelId, user.salaiToken, messageId, index);
      if (result.success) {
        return { 
          uri: result.url, 
          proxy_url: result.proxy_url, 
          success: true,
          message_id: result.message_id
        };
      }
      throw new Error(result.error || 'Failed to get upscale result');
    } else if (statusCode === 400) {
      const errorData = responseText ? JSON.parse(responseText) : {};
      throw new Error(`Bad Request: ${errorData.message || responseText}`);
    } else if (statusCode === 401) {
      throw new Error('Unauthorized: Check your Discord token');
    } else if (statusCode === 404) {
      throw new Error('Message not found or button expired. Try generating a new image.');
    } else {
      throw new Error(`Discord API error: ${statusCode} - ${responseText}`);
    }
  } catch (error) {
    console.error('❌ Ошибка customUpscale:', error);
    throw error;
  }
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
    
    // Извлекаем hash из URL
    let hash = null;
    if (imageUrl) {
      const hashMatch = imageUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
      hash = hashMatch ? hashMatch[1] : null;
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
    
    // Добавляем задержку перед upscale
    console.log('⏳ Ждем 3 секунды перед upscale...');
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      const result = await customUpscale(task_id, idx, hash, user);
      
      console.log(`✅ Upscale завершен для ${user.userEmail}`);
      
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
      console.error('❌ Ошибка при выполнении upscale:', upscaleError.message);
      
      // Возвращаем ошибку, но с информацией для отладки
      return res.status(500).json({
        success: false,
        error: upscaleError.message,
        debug: {
          task_id: task_id,
          index: idx,
          hash: hash,
          imageUrl: imageUrl,
          user: user.userEmail
        },
        suggestion: 'Попробуйте еще раз через несколько секунд'
      });
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
    version: '2.1.0',
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
      '2.1.0': 'Добавлена асинхронная генерация с проверкой статуса'
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

init().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Супер Midjourney API запущен на порту ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`👥 Admin панель: http://localhost:${PORT}/admin`);
    console.log(`🎨 API генерации: POST http://localhost:${PORT}/api/generate`);
    console.log(`📍 API статуса: GET http://localhost:${PORT}/api/task/:taskId`);
    console.log(`🔍 API upscale: POST http://localhost:${PORT}/api/upscale`);
    console.log(`🌍 Среда: ${process.env.NODE_ENV || 'development'}`);
  });
});